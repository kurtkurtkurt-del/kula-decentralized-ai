// The chat page's conversations: one JSON file each in ~/.kula-node/chats/ (KULA_NODE_HOME
// moves it), mode 600 in a 700 folder, because what people type is theirs. The page sends the
// whole conversation after every turn; the title is the first user message until renamed.
// A user message may keep its photos (at most three, shrunk by the page, data: urls checked by
// ui/vision.ts) and the vision model's reading of them; a chat holds 6 MB of photos at most.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { home } from '../paths.js';
import { checkPhotos, cleanSeen, CHAT_PHOTOS_MAX_CHARS, type Seen } from './vision.js';

// photos: how the newest message's photos were answered (seen by the model, or read by a vision model first)
export interface ChatMeta { tokens?: number; tps?: number; firstMs?: number; ms?: number; device?: string; stopped?: boolean; error?: string; photos?: { how: 'direct' | 'describe'; by: string; n: number; tight?: boolean } }
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; meta?: ChatMeta; photos?: string[]; seen?: Seen }
export interface Conversation {
  id: string;
  title: string;
  titleSet?: boolean;   // renamed by hand: the first message no longer names it
  created: number;
  updated: number;
  model?: string | null;
  messages: ChatMessage[];
}
export interface ConversationRow { id: string; title: string; updated: number; count: number }

export const ID_RE = /^[0-9a-f]{8,32}$/;
const MAX_MESSAGES = 2000;
const MAX_CONTENT = 512 * 1024;

export const chatsDir = (): string => path.join(home(), 'chats');
export const newId = (): string => randomBytes(8).toString('hex');

// "how do tides work" from the first thing the person asked, one line, at most 60 characters.
export function titleOf(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === 'user' && m.content.trim());
  if (!first) return 'new chat';
  const line = first.content.replace(/\s+/g, ' ').trim();
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// What the page sent, made safe to keep: known fields only, sizes capped.
export function clean(id: string, body: any, prev: Conversation | null): Conversation {
  if (!ID_RE.test(id)) throw new Error('bad id');
  const raw = Array.isArray(body?.messages) ? body.messages.slice(0, MAX_MESSAGES) : prev?.messages ?? [];
  const messages: ChatMessage[] = raw.map((m: any) => {
    const role = m?.role === 'assistant' || m?.role === 'system' ? m.role : 'user';
    const out: ChatMessage = { role, content: String(m?.content ?? '').slice(0, MAX_CONTENT) };
    if (m?.meta && typeof m.meta === 'object') {
      const x = m.meta;
      const p = x.photos;
      const photos = p && typeof p === 'object' && (p.how === 'direct' || p.how === 'describe') && typeof p.by === 'string'
        ? { how: p.how as 'direct' | 'describe', by: p.by.slice(0, 80), n: Math.max(1, Math.min(3, Math.round(Number(p.n) || 1))), ...(p.tight === true ? { tight: true } : {}) } : undefined;
      const meta: ChatMeta = { tokens: num(x.tokens), tps: num(x.tps), firstMs: num(x.firstMs), ms: num(x.ms), device: typeof x.device === 'string' ? x.device.slice(0, 80) : undefined, stopped: x.stopped === true ? true : undefined, error: typeof x.error === 'string' ? x.error.slice(0, 500) : undefined, photos };
      for (const k of Object.keys(meta) as (keyof ChatMeta)[]) if (meta[k] === undefined) delete meta[k];
      if (Object.keys(meta).length) out.meta = meta;
    }
    if (role === 'user' && m?.photos != null) {
      const photos = checkPhotos(m.photos);
      if (photos.length) out.photos = photos;
      const seen = cleanSeen(m.seen);
      if (seen && photos.length) out.seen = seen;
    }
    return out;
  });
  const photoChars = messages.reduce((a, m) => a + (m.photos ?? []).reduce((b, u) => b + u.length, 0), 0);
  if (photoChars > CHAT_PHOTOS_MAX_CHARS) throw new Error(`this chat holds too many photos (${Math.round(photoChars / 1e6)} MB; at most ${CHAT_PHOTOS_MAX_CHARS / 1e6} MB): start a new chat for more photos`);
  const titleSet = prev?.titleSet ?? false;
  const now = Date.now();
  return {
    id,
    title: titleSet ? prev!.title : titleOf(messages),
    titleSet,
    created: prev?.created ?? now,
    updated: now,
    model: typeof body?.model === 'string' ? body.model.slice(0, 200) : prev?.model ?? null,
    messages,
  };
}

export class ChatStore {
  constructor(readonly dir = chatsDir()) {}

  private file(id: string): string {
    if (!ID_RE.test(id)) throw new Error('bad id');
    return path.join(this.dir, `${id}.json`);
  }

  private write(c: Conversation): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const f = this.file(c.id);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 });
    fs.renameSync(tmp, f);
  }

  get(id: string): Conversation | null {
    try { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')) as Conversation; } catch { return null; }
  }

  // newest first; `q` keeps the ones whose title or any message holds it (any case)
  list(q?: string): ConversationRow[] {
    const needle = q?.trim().toLowerCase() ?? '';
    let names: string[] = [];
    try { names = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')); } catch { return []; }
    const rows: ConversationRow[] = [];
    for (const n of names) {
      const id = n.slice(0, -5);
      if (!ID_RE.test(id)) continue;
      const c = this.get(id);
      if (!c) continue;
      if (needle && !c.title.toLowerCase().includes(needle) && !c.messages.some((m) => m.content.toLowerCase().includes(needle))) continue;
      rows.push({ id: c.id, title: c.title, updated: c.updated, count: c.messages.length });
    }
    return rows.sort((a, b) => b.updated - a.updated);
  }

  put(id: string, body: unknown): Conversation {
    const c = clean(id, body, this.get(id));
    this.write(c);
    return c;
  }

  rename(id: string, title: string): Conversation | null {
    const c = this.get(id);
    if (!c) return null;
    const t = String(title).replace(/\s+/g, ' ').trim().slice(0, 120);
    const next: Conversation = t ? { ...c, title: t, titleSet: true, updated: Date.now() } : { ...c, title: titleOf(c.messages), titleSet: false, updated: Date.now() };
    this.write(next);
    return next;
  }

  remove(id: string): boolean {
    try { fs.rmSync(this.file(id)); return true; } catch { return false; }
  }
}
