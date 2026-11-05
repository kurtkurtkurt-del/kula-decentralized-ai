// Test people (6.11.2026: "test socially without a server"): a few made-up people who live
// only on this phone. They show up in connect (your people, requests, suggestions, search),
// have a page, take friend requests (and accept a few seconds later) and answer messages
// with canned lines after a short pause. Everything they say is marked "test" in the app.
// The functions here are pure (state in, state changed in place); data/friends.ts and
// data/dms.ts route a test handle, id or thread here and keep the state in kv-store.
// Tested in __tests__/demo-social.test.ts.
import Storage from 'expo-sqlite/kv-store';

export type TestRelation = 'none' | 'friend' | 'outgoing' | 'incoming';
export type TestPerson = { id: string; handle: string; display_name: string; bio: string; city_name: string; device: string; start: TestRelation; lines: string[] };

export const TEST_PEOPLE: TestPerson[] = [
  { id: 'test-ayla', handle: 'test_ayla', display_name: 'ayla', bio: 'night owl. my phone works while i sleep.', city_name: 'istanbul', device: 'pixel 7', start: 'friend',
    lines: ['my pixel did 40k tokens last night, not bad for a phone.', 'i keep the charger by the window, it stays cooler there.', 'the village school project is my favourite so far.'] },
  { id: 'test-jonas', handle: 'test_jonas', display_name: 'jonas', bio: 'trains small models for schools.', city_name: 'berlin', device: 'galaxy s23', start: 'friend',
    lines: ['the s23 gets warm after midnight, so i let it rest a bit.', 'have you measured your passport yet?', 'i am trying the 3b model tonight.'] },
  { id: 'test-mehmet', handle: 'test_mehmet', display_name: 'mehmet', bio: 'teacher. curious about ai that runs offline.', city_name: 'izmir', device: 'redmi note 12', start: 'friend',
    lines: ['my students asked if the phone is thinking at night. kind of!', 'the redmi is old but it still does its share.', 'tell me when you start a coop, i will join.'] },
  { id: 'test-mira', handle: 'test_mira', display_name: 'mira', bio: 'sent you a request. say yes and write to me.', city_name: 'munich', device: 'pixel 8 pro', start: 'incoming',
    lines: ['thanks for accepting!', 'my pixel 8 is plugged in every night now.', 'which project do you keep?'] },
  { id: 'test-kerem', handle: 'test_kerem', display_name: 'kerem', bio: 'add me: i say yes after a few seconds.', city_name: 'ankara', device: 'oneplus 11', start: 'none',
    lines: ['the oneplus charges fast, so it is ready early.', 'i run two phones on one charger, one of them is old.', 'we should do a night together.'] },
  { id: 'test-lena', handle: 'test_lena', display_name: 'lena', bio: 'add me too. i like long nights.', city_name: 'vienna', device: 'fairphone 5', start: 'none',
    lines: ['the fairphone is slow but steady.', 'i only plug in on wi-fi.', 'see you in the coop tonight.'] },
];

export const isTestHandle = (h?: string | null) => !!h && h.startsWith('test_');
export const isTestId = (id?: string | null) => !!id && id.startsWith('test-') && !id.startsWith('test-dm-');
export const threadOf = (handle: string) => `test-dm-${handle}`;
export const isTestThread = (id?: string | null) => !!id && id.startsWith('test-dm-');
export function testPerson(key: { handle?: string | null; id?: string | null; thread?: string | null }): TestPerson | null {
  const handle = key.thread && isTestThread(key.thread) ? key.thread.slice('test-dm-'.length) : key.handle;
  return TEST_PEOPLE.find((p) => (handle && p.handle === handle) || (key.id && p.id === key.id)) ?? null;
}

export type TestLine = { id: number; mine: boolean; body: string; at: string };
type Thread = { lines: TestLine[]; pending: { due: number; body: string }[]; seen: number; n: number };
export type SocialState = { rel: Record<string, { r: TestRelation; at: number }>; threads: Record<string, Thread>; seq: number };

export const freshSocial = (): SocialState => ({ rel: {}, threads: {}, seq: 0 });
/** A request to a test person is answered after this long. */
export const ACCEPT_AFTER = 4000;

// ------------------------------------------------------------- friends

export function relationOf(s: SocialState, p: TestPerson, now: number): TestRelation {
  const o = s.rel[p.handle];
  if (!o) return p.start;
  if (o.r === 'outgoing' && now - o.at >= ACCEPT_AFTER) return 'friend';
  return o.r;
}
export function request(s: SocialState, p: TestPerson, now: number): 'sent' | 'accepted' {
  const r = relationOf(s, p, now);
  if (r === 'friend') return 'accepted';
  if (r === 'incoming') {
    s.rel[p.handle] = { r: 'friend', at: now };
    return 'accepted';
  }
  if (r !== 'outgoing') s.rel[p.handle] = { r: 'outgoing', at: now };
  return 'sent';
}
export function accept(s: SocialState, p: TestPerson, now: number) {
  if (relationOf(s, p, now) === 'incoming') s.rel[p.handle] = { r: 'friend', at: now };
}
export function unfriend(s: SocialState, p: TestPerson, now: number) {
  s.rel[p.handle] = { r: 'none', at: now };
}

// ------------------------------------------------------------- messages

const thread = (s: SocialState, handle: string): Thread => (s.threads[handle] ??= { lines: [], pending: [], seen: 0, n: 0 });

type Lang = 'en' | 'de' | 'tr';
export function langOf(body: string): Lang {
  if (/[äß]|\b(hallo|danke|wie|nacht|ja|nein|gut|ich|du|servus|moin)\b/i.test(body)) return 'de';
  if (/[çğışöü]|\b(merhaba|selam|naber|evet|gece|nasil)\b/i.test(body)) return 'tr';
  return 'en';
}
const GREET: Record<Lang, string[]> = {
  en: ['hey! good to hear from you.', 'hi there!', 'hello! all good here.'],
  de: ['hallo! schön, von dir zu hören.', 'hi! alles gut hier.', 'servus!'],
  tr: ['selam! haber almak güzel.', 'merhaba! burada her şey yolunda.', 'selam, naber?'],
};
const ASKED: Record<Lang, string[]> = {
  en: ['good question. i would say yes, but let me check tonight.', 'hmm, not sure. what do you think?', 'ask me again after my phone has done a night.'],
  de: ['gute frage. ich glaube ja, ich schau heute nacht nach.', 'hm, weiß nicht. was meinst du?', 'frag mich nochmal nach der nacht.'],
  tr: ['güzel soru. bence evet, bu gece bakarım.', 'hmm, emin değilim. sen ne dersin?', 'gece bitince bir daha sor.'],
};
const NIGHT: Record<Lang, string[]> = {
  en: ['my phone is on the charger, ready for tonight.', 'count me in for tonight. same project as last time?'],
  de: ['mein handy hängt am ladekabel, bereit für heute nacht.', 'ich bin heute nacht dabei. selbes projekt wie letztes mal?'],
  tr: ['telefonum şarjda, bu geceye hazır.', 'bu gece ben de varım. geçen seferki proje mi?'],
};
const FIRST: Record<Lang, string> = {
  en: '(i am a test person: my answers are automatic.)',
  de: '(ich bin eine testperson: meine antworten kommen automatisch.)',
  tr: '(ben bir test kişisiyim: cevaplarım otomatik.)',
};

/** What a test person answers to `body`, the n-th line you sent them (0 = the first). */
export function replyTo(p: TestPerson, body: string, n: number): string {
  const lang = langOf(body);
  const pick = (list: string[]) => list[n % list.length];
  let r: string;
  if (/\b(hi|hey|hello|hallo|merhaba|selam|servus|moin)\b/i.test(body)) r = pick(GREET[lang]);
  else if (body.includes('?')) r = pick(ASKED[lang]);
  else if (/night|coop|plug|charg|gece|kooperatif|şarj|nacht|koop|lade/i.test(body)) r = pick(NIGHT[lang]);
  else r = pick(p.lines);
  return n === 0 ? `${r} ${FIRST[lang]}` : r;
}
/** How long they take to answer: 1.5 s plus a little for a longer line, at most 4 s. */
export const replyDelay = (body: string) => 1500 + Math.min(2500, body.length * 30);

/** Turns the answers that are due into lines, in the order they came due (ids keep growing). */
export function settle(s: SocialState, now: number) {
  const due = Object.entries(s.threads)
    .flatMap(([h, t]) => t.pending.filter((x) => x.due <= now).map((x) => ({ h, x })))
    .sort((a, b) => a.x.due - b.x.due);
  for (const { h, x } of due) {
    const t = s.threads[h];
    t.pending = t.pending.filter((y) => y !== x);
    t.lines.push({ id: ++s.seq, mine: false, body: x.body, at: new Date(x.due).toISOString() });
  }
}
/** Your line to a test person; their answer comes due after replyDelay. Returns your line's id. */
export function say(s: SocialState, p: TestPerson, body: string, now: number): { id: number; due: number } {
  settle(s, now);
  const t = thread(s, p.handle);
  const id = ++s.seq;
  t.lines.push({ id, mine: true, body, at: new Date(now).toISOString() });
  t.seen = id;
  const due = now + replyDelay(body);
  t.pending.push({ due, body: replyTo(p, body, t.n++) });
  return { id, due };
}
export function linesAfter(s: SocialState, handle: string, after: number, now: number): TestLine[] {
  settle(s, now);
  return (s.threads[handle]?.lines ?? []).filter((l) => l.id > after);
}
export const unread = (s: SocialState, handle: string) => (s.threads[handle]?.lines ?? []).filter((l) => !l.mine && l.id > (s.threads[handle]?.seen ?? 0)).length;
export function markSeen(s: SocialState, handle: string, id: number) {
  const t = s.threads[handle];
  if (t && id > t.seen) t.seen = id;
}
export function unsay(s: SocialState, handle: string, id: number) {
  const t = s.threads[handle];
  if (t) t.lines = t.lines.filter((l) => !(l.mine && l.id === id));
}
/** The conversations with at least one line (or an answer on its way). */
export const startedThreads = (s: SocialState) => Object.entries(s.threads).filter(([, t]) => t.lines.length || t.pending.length).map(([h]) => h);
export const nextDue = (s: SocialState, handle: string) => Math.min(Infinity, ...(s.threads[handle]?.pending ?? []).map((x) => x.due));

// ------------------------------------------------------------- on the phone

const KEY = 'social.test.v1';
const SWITCH = 'social.test.on';
export function loadSocial(): SocialState {
  try {
    const raw = Storage.getItemSync(KEY);
    if (raw) return { ...freshSocial(), ...(JSON.parse(raw) as SocialState) };
  } catch {}
  return freshSocial();
}
export function saveSocial(s: SocialState) {
  try {
    Storage.setItemSync(KEY, JSON.stringify(s));
  } catch {}
}
/** The switch in connect: true/false when someone chose, null when nobody did (then the account decides). */
export function testSwitch(): boolean | null {
  try {
    const v = Storage.getItemSync(SWITCH);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}
export function setTestSwitch(on: boolean) {
  try {
    Storage.setItemSync(SWITCH, on ? '1' : '0');
  } catch {}
}
