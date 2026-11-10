// Photos on the chat page (10.11.2026): the computer's side of what the phone does in
// app/src/llm/photos.ts and vision.ts. The pure parts are here (which way a photo goes, what
// the vision model is asked, how its reading goes into a text model's prompt, what a photo
// may look like on the wire); the engine (engine.ts) does the work.
//
// A vision model is a catalog model with an `mmproj` (llama.cpp's mtmd image encoder; it sits
// next to the model in the same Hugging Face repo and in the same models folder here). A photo
// is answered one of three ways (routePhotos):
//   direct    the loaded model sees photos and runs here (mode "here", its llama-server started
//             with --mmproj): the photo goes to it as an OpenAI image_url part.
//   describe  any other case with a vision model on this computer: it reads the photo first in a
//             short-lived second llama-server (--mmproj, 127.0.0.1, stopped right after), and its
//             reading goes into the chat model's prompt, marked as the vision model's. Only text
//             goes to phones (phone, apart and split modes).
//   none      no vision model on this computer: a clear message.
// llama-server takes data: urls (handle_media in tools/server/server-common.cpp, b11157) but
// also fetches http(s) urls itself, so nothing but a data:image/…;base64 url ever reaches it.
import type { Message, ChatPart } from '../apart.js';
export type { ChatPart, WireMessage } from '../apart.js';

/** The long side photos are shrunk to in the browser: fewer image tokens each when there are more. */
export const photoSide = (n: number) => (n <= 1 ? 768 : 512);
export const MAX_PHOTOS = 3;
/** One photo as a data url, at most this many characters: a 768 px jpeg is 100–300 KB as base64. */
export const PHOTO_MAX_CHARS = 1_000_000;
/** The photos one stored chat may hold, all messages together. */
export const CHAT_PHOTOS_MAX_CHARS = 6_000_000;
/** The vision model's context for reading one photo (as the phone: the image tokens and a short description). */
export const DESCRIBE_CTX = 2048;
export const DESCRIBE_TOKENS = 320;

const DATA_URL = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Why a photo cannot be taken (null: fine). Only a base64 jpeg, png or webp data url, capped. */
export function photoProblem(url: unknown): string | null {
  if (typeof url !== 'string') return 'a photo must be a data: url';
  if (url.length > PHOTO_MAX_CHARS) return `a photo is too big (${Math.round(url.length / 1000)} KB; at most ${PHOTO_MAX_CHARS / 1000} KB): shrink it to about 768 px on the long side`;
  if (!DATA_URL.test(url)) return /^https?:/i.test(url) ? 'photos must be sent as data: urls, not links' : 'a photo must be a base64 jpeg, png or webp data: url';
  return null;
}

/** The photos of one message, checked: at most three, each a data url within the cap. Throws with the reason. */
export function checkPhotos(list: unknown): string[] {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error('photos must be a list');
  if (list.length > MAX_PHOTOS) throw new Error(`at most ${MAX_PHOTOS} photos per message`);
  for (const u of list) { const why = photoProblem(u); if (why) throw new Error(why); }
  return list as string[];
}

/** A vision model's reading of photos, kept with the message: what the text model got instead of them. */
export interface Seen { text: string; by: string; n: number }
/** How the newest message's photos were answered, for the bubble ("seen by", "read by"). */
export interface PhotoNote { how: 'direct' | 'describe'; by: string; n: number; text?: string; tight?: boolean }

export type PhotoRoute<V> = { kind: 'direct' } | { kind: 'describe'; by: V } | { kind: 'none' };

/** Pure: direct when the loaded model sees photos and runs here; else the chosen vision model reads them; else none. */
export function routePhotos<V>(chatSees: boolean, vision: V | null): PhotoRoute<V> {
  if (chatSees) return { kind: 'direct' };
  if (vision) return { kind: 'describe', by: vision };
  return { kind: 'none' };
}

/** What the vision model is asked about one photo (the phone's words). */
export function describePrompt(question?: string): string {
  const q = question?.trim();
  const ask = q ? ` The person asks about it: "${q.slice(0, 400)}". Include what is needed to answer that.` : '';
  return `Describe this photo briefly and factually: what is in it, where, the colours, and copy any visible text exactly. Do not guess beyond what you can see.${ask}`;
}

/** The note a text model gets in place of the photos, marked as the vision model's. */
export function seenNote(s: Seen): string {
  const what = s.n === 1 ? 'a photo' : `${s.n} photos`;
  return `[The person sent ${what}. ${s.by}, a vision model on this computer, looked at ${s.n === 1 ? 'it' : 'them'} and wrote:\n${s.text.trim()}\n(end of the vision model's description)]`;
}

/** A user message with photos as text, for a model that does not see them (earlier turns, or no reading kept). */
export function withPhotos(content: string, photos: number, seen?: Seen | null): string {
  if (!photos) return content;
  if (seen) return `${content}\n\n${seenNote(seen)}`;
  return `${content}\n\n[The person sent ${photos === 1 ? 'a photo' : `${photos} photos`} with this message; you cannot see ${photos === 1 ? 'it' : 'them'}.]`;
}

/** A kept reading, made safe: text and name capped, or null. */
export function cleanSeen(x: any): Seen | null {
  if (!x || typeof x !== 'object' || typeof x.text !== 'string' || typeof x.by !== 'string') return null;
  const n = Number(x.n);
  return { text: x.text.slice(0, 8000), by: x.by.slice(0, 80), n: Number.isInteger(n) && n > 0 && n <= MAX_PHOTOS ? n : 1 };
}

// ---- the wire

/** A user message with its photos, as OpenAI content parts (the text first, as the phone's template puts it). */
export function partsOf(text: string, photos: string[]): ChatPart[] {
  return [...(text ? [{ type: 'text' as const, text }] : []), ...photos.map((url) => ({ type: 'image_url' as const, image_url: { url } }))];
}

/**
 * A conversation from the page or /v1, each message with its own photos (and, for earlier ones,
 * the reading kept with it), as text messages plus the newest user message's photos: only those
 * are looked at; earlier photos become notes (withPhotos). The page sends an earlier message's
 * photos as their count only. Throws on a bad photo.
 */
export function splitPhotos(list: { role: Message['role']; content: string; photos?: unknown; seen?: unknown }[]): { messages: Message[]; photos: string[] } {
  let last = -1;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].role === 'user') { last = i; break; }
  let photos: string[] = [];
  const messages = list.map((m, i) => {
    const counted = typeof m.photos === 'number' && Number.isInteger(m.photos) && m.photos >= 0 && m.photos <= MAX_PHOTOS ? m.photos : null;
    const mine = counted === null ? checkPhotos(m.photos) : [];
    if (i === last && mine.length) { photos = mine; return { role: m.role, content: m.content }; }
    return { role: m.role, content: withPhotos(m.content, counted ?? mine.length, cleanSeen(m.seen)) };
  });
  return { messages, photos };
}
