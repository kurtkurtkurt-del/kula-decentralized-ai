// Coops on the phone (6.11.2026: "make the coop part actually work, no sql"): every coop you
// make or join is kept here, in kv-store, per account. A code you make opens your coop on
// this phone; the test coops (with the test people in them) open with their own codes. Pure
// functions (state in, state changed in place), the same shapes data/coops.ts always had.
// Tested in __tests__/demo-coops.test.ts.
import Storage from 'expo-sqlite/kv-store';
import { TEST_PEOPLE } from './testPeople';

export type CoopColor = 'red' | 'gold' | 'blue' | 'green' | 'violet' | 'paper';
export type Role = 'owner' | 'member';
export type Member = { id: string; handle: string | null; name: string | null; role: Role; live: boolean };
export type Tonight = { slug: string; title: string; model: string };
export type CoopNight = { night: string; slug: string; title: string; model: string; set_by: string | null; phones: number; tokens: number; kwh: number; credits: number };
export type LocalCoop = { id: string; name: string; emoji: string; color: CoopColor; code: string; role: Role; members: Member[]; tonight: Tonight | null; nights: CoopNight[]; test: boolean };
export type CoopState = { coops: LocalCoop[]; seq: number };
export type Me = { id: string; handle: string | null; name: string | null };
export type CoopForm = { name: string; emoji: string; color: CoopColor };

export const MAX_MEMBERS = 12;
export const freshCoops = (): CoopState => ({ coops: [], seq: 0 });

// The test coops: join one with its code and the test people are in it with you.
type TestCoop = { code: string; name: string; emoji: string; color: CoopColor; people: string[]; nights: CoopNight[] };
const night = (n: string, phones: number, tokens: number): CoopNight => ({ night: n, slug: 'koy-okulu-ogretmen', title: 'offline teacher for village schools', model: '3B Q4', set_by: 'test_ayla', phones, tokens, kwh: phones * 0.012, credits: Math.round(tokens / 2333) / 100 });
export const TEST_COOPS: TestCoop[] = [
  { code: 'GECE01', name: 'night owls', emoji: '🌙', color: 'violet', people: ['test_ayla', 'test_jonas', 'test_mehmet'], nights: [night('2026-11-03', 3, 112000), night('2026-11-01', 2, 64000)] },
  { code: 'OKUL42', name: 'village school', emoji: '🏫', color: 'green', people: ['test_mira', 'test_kerem', 'test_lena'], nights: [] },
];

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newCode(s: CoopState, rand: () => number = Math.random): string {
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_CHARS[Math.floor(rand() * CODE_CHARS.length)];
    if (!s.coops.some((x) => x.code === c) && !TEST_COOPS.some((x) => x.code === c)) return c;
  }
}
const norm = (code: string) => code.trim().toUpperCase();
const find = (s: CoopState, id: string) => {
  const c = s.coops.find((x) => x.id === id);
  if (!c) throw new Error('not in this coop');
  return c;
};
const owner = (c: LocalCoop) => {
  if (c.role !== 'owner') throw new Error('only the owner');
};

export function create(s: CoopState, me: Me, f: CoopForm, people: Me[], rand?: () => number): string {
  const name = f.name.trim();
  if (!name) throw new Error('name');
  const others = people.filter((p, i) => p.id !== me.id && people.findIndex((q) => q.id === p.id) === i);
  if (others.length + 1 > MAX_MEMBERS) throw new Error('the coop is full');
  const id = `local-${Date.now().toString(36)}-${++s.seq}`;
  s.coops.unshift({
    id, name, emoji: f.emoji, color: f.color, code: newCode(s, rand), role: 'owner', tonight: null, nights: [], test: false,
    members: [{ ...me, role: 'owner', live: false }, ...others.map((p) => ({ ...p, role: 'member' as const, live: false }))],
  });
  return id;
}
export const list = (s: CoopState) =>
  s.coops.map((c) => ({ id: c.id, name: c.name, emoji: c.emoji, color: c.color, members: c.members.length, role: c.role, tonight_slug: c.tonight?.slug ?? null, tonight_title: c.tonight?.title ?? null }));
export function get(s: CoopState, id: string) {
  const c = find(s, id);
  return { id: c.id, name: c.name, emoji: c.emoji, color: c.color, me: c.role, members: c.members, tonight: c.tonight, nights: c.nights.length };
}
export const nights = (s: CoopState, id: string) => find(s, id).nights;
export function update(s: CoopState, id: string, f: CoopForm) {
  const c = find(s, id);
  owner(c);
  if (!f.name.trim()) throw new Error('name');
  Object.assign(c, { name: f.name.trim(), emoji: f.emoji, color: f.color });
}
export function add(s: CoopState, id: string, people: Me[]): number {
  const c = find(s, id);
  const fresh = people.filter((p, i) => !c.members.some((m) => m.id === p.id) && people.findIndex((q) => q.id === p.id) === i);
  if (c.members.length + fresh.length > MAX_MEMBERS) throw new Error('the coop is full');
  c.members.push(...fresh.map((p) => ({ ...p, role: 'member' as const, live: false })));
  return fresh.length;
}
export function remove(s: CoopState, id: string, user: string) {
  const c = find(s, id);
  owner(c);
  c.members = c.members.filter((m) => m.id !== user || m.role === 'owner');
}
/** Leaving (or deleting, for the owner): the coop is gone from this phone. */
export function leave(s: CoopState, id: string) {
  find(s, id);
  s.coops = s.coops.filter((c) => c.id !== id);
}
export const invite = (s: CoopState, id: string) => find(s, id).code;
export function setTonight(s: CoopState, id: string, t: Tonight) {
  find(s, id).tonight = t;
}

export type Peek = { id: string; name: string; emoji: string; color: CoopColor; members: number; mine: boolean; open: boolean };
/** What a code opens: one of your coops, a test coop (when the test people are on), or nothing. */
export function peek(s: CoopState, code: string, testOn: boolean): Peek | null {
  const k = norm(code);
  const mine = s.coops.find((c) => c.code === k);
  if (mine) return { id: mine.id, name: mine.name, emoji: mine.emoji, color: mine.color, members: mine.members.length, mine: true, open: true };
  const tc = testOn ? TEST_COOPS.find((c) => c.code === k) : undefined;
  if (tc) return { id: `test-coop-${tc.code}`, name: tc.name, emoji: tc.emoji, color: tc.color, members: tc.people.length, mine: false, open: true };
  return null;
}
export function join(s: CoopState, me: Me, code: string, testOn: boolean): string {
  const p = peek(s, code, testOn);
  if (!p) throw new Error('no coop with that code');
  if (p.mine) return p.id;
  const tc = TEST_COOPS.find((c) => c.code === norm(code))!;
  const members: Member[] = tc.people.flatMap((h, i) => {
    const t = TEST_PEOPLE.find((x) => x.handle === h);
    return t ? [{ id: t.id, handle: t.handle, name: t.display_name, role: i === 0 ? 'owner' : 'member', live: false } as Member] : [];
  });
  members.push({ ...me, role: 'member', live: false });
  s.coops.unshift({ id: p.id, name: tc.name, emoji: tc.emoji, color: tc.color, code: tc.code, role: 'member', members, tonight: null, nights: JSON.parse(JSON.stringify(tc.nights)), test: true });
  return p.id;
}
export const testCodes = () => TEST_COOPS.map((c) => c.code);

// ------------------------------------------------------------- on the phone

const key = (uid: string) => `coops.local.${uid}`;
export function loadCoops(uid: string): CoopState {
  try {
    const raw = Storage.getItemSync(key(uid));
    if (raw) return { ...freshCoops(), ...(JSON.parse(raw) as CoopState) };
  } catch {}
  return freshCoops();
}
export function saveCoops(uid: string, s: CoopState) {
  try {
    Storage.setItemSync(key(uid), JSON.stringify(s));
  } catch {}
}
