import type { Passport } from '@/passport/contract';
import type { Message } from '@/llm/native';
import { haveMb, needMb } from '@/llm/fit';

// The pure side of photos (10.11.2026; llm/vision.ts does the work): how a photo is answered,
// whether two models fit at once, what the vision model is asked, and how its reading goes
// into a text model's prompt. No native module, no store: the projects' prompts use it too.

type VisionLike = { size: number; kv_mb_per_1k: number; name: string; mmproj?: { size: number } | null };
const bytes = (m: { size: number; mmproj?: { size: number } | null }) => m.size + (m.mmproj?.size ?? 0);

/** The long side photos are scaled to: fewer image tokens each when there are many. */
export const photoSide = (n: number) => (n <= 1 ? 768 : n <= 3 ? 512 : 384);
/** A vision model's context for reading one photo: the image tokens and a short description. */
export const DESCRIBE_CTX = 2048;
export const DESCRIBE_TOKENS = 320;

export type PhotoRoute<V = VisionLike> = { kind: 'direct' } | { kind: 'describe'; by: V; swap: boolean } | { kind: 'none' };

/** Pure: how a photo is answered, given the chat model, the chosen vision model, and whether both fit at once. */
export function routePhotos<V extends VisionLike>(chat: { mmproj?: unknown } | null, vision: V | null, both: boolean): PhotoRoute<V> {
  if (chat?.mmproj) return { kind: 'direct' };
  if (vision) return { kind: 'describe', by: vision, swap: !!chat && !both };
  return { kind: 'none' };
}

/** Do the loaded chat model (at its context) and the vision model with its mmproj fit in RAM together? Unknown without a passport: no. */
export function fitsBoth(p: Passport | null, chat: { size: number; kv_mb_per_1k: number }, chatCtx: number, vision: VisionLike): boolean {
  if (!p) return false;
  const need = needMb({ size: chat.size, kv_mb_per_1k: chat.kv_mb_per_1k, ctx: chatCtx }) + needMb({ size: bytes(vision), kv_mb_per_1k: vision.kv_mb_per_1k, ctx: DESCRIBE_CTX });
  return need <= haveMb(p) * 0.85;
}

/** What the vision model is asked about one photo. */
export function describeMessages(question?: string): Message[] {
  const ask = question?.trim() ? ` The person asks about it: "${question.trim().slice(0, 400)}". Include what is needed to answer that.` : '';
  return [{ role: 'user', content: `Describe this photo briefly and factually: what is in it, where, the colours, and copy any visible text exactly. Do not guess beyond what you can see.${ask}` }];
}

/** A vision model's reading of photos, kept with the message (chat) or the project (night). */
export type Seen = { text: string; by: string; n: number };

/** The note a text model gets in place of the photos, marked as the vision model's. */
export function seenNote(s: Seen): string {
  const what = s.n === 1 ? 'a photo' : `${s.n} photos`;
  return `[The person sent ${what}. ${s.by}, a vision model on this phone, looked at ${s.n === 1 ? 'it' : 'them'} and wrote:\n${s.text.trim()}\n(end of the vision model's description)]`;
}
/** A user message with photos as text for a model that does not see them. */
export function withPhotos(content: string, photos: number, seen?: Seen | null): string {
  if (!photos) return content;
  if (seen) return `${content}\n\n${seenNote(seen)}`;
  return `${content}\n\n[The person sent ${photos === 1 ? 'a photo' : `${photos} photos`} with this message; you cannot see ${photos === 1 ? 'it' : 'them'}.]`;
}

