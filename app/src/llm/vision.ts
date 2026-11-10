import { useEffect, useState } from 'react';
import { lastPassport } from '@/data/passport';
import { isVision } from '@/llm/catalog';
import { engine, load, loadVision, unload, type Photos } from '@/llm/engine';
import { native, type Message } from '@/llm/native';
import { DESCRIBE_CTX, DESCRIBE_TOKENS, describeMessages, fitsBoth, photoSide, routePhotos, seenNote, type Seen } from '@/llm/photos';
import { note } from '@/llm/brainlog';
import { bytesOf, localById, localModels, mmprojPath, settings, type LocalModel } from '@/llm/store';

export * from '@/llm/photos';

// Photos (10.11.2026): which model looks at them, and how.
//
// A vision model is one with an mmproj (llama.cpp's mtmd image encoder, catalog.ts). The
// "vision model" setting (settings.visionModelId) picks the one that reads photos; unset, it
// is the smallest vision model on the phone. A photo is answered in one of three ways
// (routePhotos):
//  - direct: the chat model is itself a vision model; its mmproj is loaded next to it and it
//    answers with the photo in front of it.
//  - describe: the chosen vision model reads the photo first (a short, factual description
//    plus any visible text) and that goes into the chat model's prompt, marked as the vision
//    model's. Both models in RAM when the passport says they fit; else the chat model steps
//    aside (unloaded), the vision model reads, the chat model comes back (swap).
//  - none: no vision model on the phone: a clear message, the photo stays with the message.
// Apart and split modes: a photo is always read on this phone (only it has the mmproj); only
// text goes to the other devices. The night's projects use the same chosen vision model.

/** The vision models on this phone, smallest first. */
export const visionModels = (): LocalModel[] => localModels().filter(isVision).sort((a, b) => bytesOf(a) - bytesOf(b));

/** The vision model that reads photos: the setting's when it is still on the phone, else the smallest. */
export function chosenVision(): LocalModel | null {
  const id = settings().visionModelId;
  const picked = id ? localById(id) : null;
  if (picked && isVision(picked)) return picked;
  return visionModels()[0] ?? null;
}

// ---- what is happening, for the screens -------------------------------------------------
export type Reading = { by: string; swap: boolean } | null;
let reading: Reading = null;
const listeners = new Set<() => void>();
const setReading = (r: Reading) => {
  reading = r;
  listeners.forEach((fn) => fn());
};
export const readingNow = () => reading;
export function useReading(): Reading {
  const [r, setR] = useState(reading);
  useEffect(() => {
    const fn = () => setR(reading);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return r;
}

/** One answer from the native describe (a second model next to the loaded one), streamed. */
function describeOne(v: LocalModel, uri: string, question?: string, onToken?: (t: string) => void): Promise<string> {
  const llama = native();
  const mm = mmprojPath(v);
  if (!mm) return Promise.reject(new Error('novision'));
  let id = -1;
  let text = '';
  return new Promise<string>((resolve, reject) => {
    const subs = [
      llama.addListener('onToken', (e) => {
        if (e.id !== id) return;
        text += e.text;
        onToken?.(e.text);
      }),
      llama.addListener('onDone', (e) => {
        if (e.id !== id) return;
        subs.forEach((s) => s.remove());
        if (e.error) return reject(new Error(e.error === 'nophotos' ? 'nophotos' : e.error));
        resolve(text.trim());
      }),
    ];
    id = llama.describeImages(v.path, mm, DESCRIBE_CTX, describeMessages(question), [uri], photoSide(1), DESCRIBE_TOKENS);
  });
}

/**
 * The chosen vision model reads the photos, one by one. With a chat model loaded that does
 * not fit next to it, the chat model is unloaded first and loaded again after (same mode,
 * context and peers); the screens show it through useReading(). Throws 'novision' when there
 * is no vision model on the phone.
 */
export async function describePhotos(uris: string[], opts: { question?: string; onToken?: (t: string) => void } = {}): Promise<Seen> {
  const v = chosenVision();
  if (!v) throw new Error('novision');
  const e = engine();
  const chat = e.load ? e.model : null;
  const swap = !!chat && !fitsBoth(lastPassport(), chat, e.load?.ctx ?? settings().ctx, v);
  const back = swap && chat ? { model: chat, mode: e.mode, ctx: e.load?.ctx ?? settings().ctx, peers: e.devices.filter((d) => !d.local && d.peer).map((d) => d.peer!) } : null;
  setReading({ by: v.name, swap });
  note({ at: Date.now(), kind: 'load', key: swap ? 'brain.vision.swap' : 'brain.vision.read', vars: { model: v.name, n: uris.length, chat: chat?.name ?? '' }, tone: 'info' });
  try {
    if (back) await unload();
    const parts: string[] = [];
    for (let i = 0; i < uris.length; i++) {
      const text = await describeOne(v, uris[i], opts.question, opts.onToken);
      parts.push(uris.length > 1 ? `photo ${i + 1}: ${text}` : text);
    }
    return { text: parts.join('\n'), by: v.name, n: uris.length };
  } finally {
    if (back) {
      // the chat model comes back even when the reading failed
      await load(back.model, back.mode, back.ctx, back.peers).catch((err: Error) => {
        note({ at: Date.now(), kind: 'error', key: 'brain.vision.back', vars: { model: back.model.name }, detail: err.message, tone: 'bad' });
      });
    }
    setReading(null);
  }
}

/** A chat turn with photos, ready for engine.chat: the messages (the last one carrying the
 * vision model's note on the describe route) and the photos for the direct route. */
export type PhotoTurn = { messages: Message[]; images?: Photos; seen?: Seen; route: 'direct' | 'describe' };

/**
 * Prepares the last user message's photos. `history` is the conversation as text (earlier
 * photos already turned into notes by withPhotos); `uris` the new message's photos.
 * Throws 'novision' when nothing on the phone can see them.
 */
export async function photoTurn(history: Message[], uris: string[], onToken?: (t: string) => void): Promise<PhotoTurn> {
  const e = engine();
  const chat = e.load ? e.model : null;
  const route = routePhotos(chat, chosenVision(), true);
  if (route.kind === 'direct') {
    try {
      await loadVision();
      return { messages: history, images: { uris, maxSide: photoSide(uris.length) }, route: 'direct' };
    } catch {
      // the chat model's own mmproj would not load (RAM?): another vision model reads it, when there is one
      if (!chosenVision()) throw new Error('novision');
    }
  } else if (route.kind === 'none') {
    throw new Error('novision');
  }
  const last = history[history.length - 1];
  const seen = await describePhotos(uris, { question: last?.content, onToken });
  const messages = history.map((m, i) => (i === history.length - 1 ? { ...m, content: `${m.content}\n\n${seenNote(seen)}` } : m));
  return { messages, seen, route: 'describe' };
}
