// Invite mode for the chat page: other devices on this wi-fi (a phone's browser, a tablet, a
// laptop) scan a qr and land in the chat, nothing installed. Off by default. The qr carries
// http://<lan ip>:<port>/<prefix>/join?k=<32 random bytes>; /join swaps the token for a session
// cookie (HttpOnly, SameSite=Strict), and every request that does not come in on 127.0.0.1
// needs that cookie. A new invite makes a new token and ends every guest session. Tokens and
// sessions live in memory only: a restart ends them too.
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const COOKIE = 'kula_guest';
export const INVITE_TTL_MS = 8 * 3600_000;
const JOIN_WINDOW_MS = 10 * 60_000;
export const JOIN_TRIES = 20;        // per address in the window, right or wrong
export const JOIN_WRONG = 6;         // wrong tokens per address in the window
const CHAT_WINDOW_MS = 60_000;
export const CHAT_PER_MIN = 12;      // prompts per guest per minute
export const CHAT_AT_ONCE = 1;       // answers in flight per guest
export const MAX_GUESTS = 64;

export interface Guest { id: string; created: number; expires: number; ip: string; chats: number[]; active: number }

const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const recent = (list: number[], now: number, window: number) => { while (list.length && now - list[0] > window) list.shift(); return list; };

export class Invite {
  token: string | null = null;
  expiresAt = 0;
  readonly guests = new Map<string, Guest>();
  private tries = new Map<string, { all: number[]; wrong: number[] }>();
  onDrop: (ids: string[]) => void = () => {};

  constructor(readonly ttlMs = INVITE_TTL_MS, private readonly now = () => Date.now()) {}

  get on(): boolean { return !!this.token && this.now() < this.expiresAt; }

  // a new token; every guest that came in with an old one is out
  rotate(): string {
    this.token = randomBytes(32).toString('hex');
    this.expiresAt = this.now() + this.ttlMs;
    this.dropAll();
    return this.token;
  }

  off(): void {
    this.token = null;
    this.expiresAt = 0;
    this.dropAll();
  }

  private dropAll() {
    const ids = [...this.guests.keys()];
    this.guests.clear();
    if (ids.length) this.onDrop(ids);
  }

  // /join?k=…: a guest session for the right token, else why not (and the http code)
  join(k: string, ip: string): { guest: Guest } | { code: number; error: string } {
    const now = this.now();
    const t = this.tries.get(ip) ?? { all: [], wrong: [] };
    this.tries.set(ip, t);
    recent(t.all, now, JOIN_WINDOW_MS);
    recent(t.wrong, now, JOIN_WINDOW_MS);
    if (t.all.length >= JOIN_TRIES || t.wrong.length >= JOIN_WRONG) return { code: 429, error: 'too many tries; wait a few minutes' };
    t.all.push(now);
    if (!this.on || !k || !same(k, this.token!)) { t.wrong.push(now); return { code: 401, error: this.on ? 'this invite is not valid (a new one was made?)' : 'invites are off on this computer' }; }
    if (this.guests.size >= MAX_GUESTS) return { code: 429, error: 'too many guests' };
    const guest: Guest = { id: randomBytes(16).toString('hex'), created: now, expires: Math.min(now + this.ttlMs, this.expiresAt), ip, chats: [], active: 0 };
    this.guests.set(guest.id, guest);
    return { guest };
  }

  // the guest a request's cookie names, while invites are on and it has not run out
  guestOf(cookieHeader: string | undefined): Guest | null {
    if (!this.on || !cookieHeader) return null;
    for (const part of cookieHeader.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k !== COOKIE) continue;
      const id = v.join('=');
      if (!/^[0-9a-f]{32}$/.test(id)) return null;
      const g = this.guests.get(id);
      if (!g) return null;
      if (this.now() > g.expires) { this.guests.delete(id); return null; }
      return g;
    }
    return null;
  }

  // may this guest send a prompt now? (counts it when yes)
  chatAllowed(g: Guest): string | null {
    const now = this.now();
    recent(g.chats, now, CHAT_WINDOW_MS);
    if (g.active >= CHAT_AT_ONCE) return 'one answer at a time';
    if (g.chats.length >= CHAT_PER_MIN) return 'slow down: too many prompts this minute';
    g.chats.push(now);
    return null;
  }

  cookie(g: Guest, prefix: string): string {
    return `${COOKIE}=${g.id}; HttpOnly; SameSite=Strict; Path=/${prefix}/; Max-Age=${Math.max(1, Math.floor((g.expires - this.now()) / 1000))}`;
  }
}
