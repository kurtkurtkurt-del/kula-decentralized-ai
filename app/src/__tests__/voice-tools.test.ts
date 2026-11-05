// The secretary's tools (voice/tools.ts) with expo-calendar, the kv store and the native
// module (modules/kula-voice) mocked: read-back and yes/no before every write, reading at
// once, the brain log line for every tool call, and the talk-mode prompt (voice/prompt.ts).
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockStore = new Map<string, string>();
jest.mock('expo-sqlite/kv-store', () => ({
  __esModule: true,
  default: {
    getItemSync: (k: string) => mockStore.get(k) ?? null,
    setItemSync: (k: string, v: string) => mockStore.set(k, v),
    removeItemSync: (k: string) => mockStore.delete(k),
  },
}));

type Ev = { title: string; startDate: Date; endDate: Date; allDay: boolean };
const mockCal = {
  granted: true,
  canAskAgain: true,
  asked: 0,
  created: [] as (Ev & { cal: string; timeZone?: string })[],
  events: [] as Ev[],
  calendars: [] as { id: string; isPrimary?: boolean; isVisible?: boolean; allowsModifications: boolean }[],
};
jest.mock('expo-calendar', () => ({
  getCalendarPermissions: async () => ({ granted: mockCal.granted, canAskAgain: mockCal.canAskAgain }),
  requestCalendarPermissions: async () => {
    mockCal.asked++;
    return { granted: mockCal.granted, canAskAgain: mockCal.canAskAgain };
  },
  getCalendars: async () => mockCal.calendars.map((c) => ({ ...c, createEvent: async (e: Ev & { timeZone?: string }) => void mockCal.created.push({ ...e, cal: c.id }) })),
  listEvents: async (ids: string[], from: Date, to: Date) => mockCal.events.filter((e) => ids.length && e.startDate >= from && e.startDate < to),
}));

import { translator } from '@/i18n/core';
import type { BrainEntry } from '@/llm/brainlog';
import { phoneCalendar } from '@/voice/calendar';
import type { Msg, VoiceNative } from '@/voice/native';
import { clearNotes, notesStore } from '@/voice/notes';
import { buildMessages, remember, systemPrompt } from '@/voice/prompt';
import { clock, pickMessages, Secretary, when, type Outcome } from '@/voice/tools';
import { dict } from '@/i18n/dict';

const NOW = new Date(2026, 10, 5, 10, 0); // a thursday
const say = (o: Outcome) => (o.kind === 'say' ? o.text : '(chat)');

function fakeNative(over: Partial<VoiceNative> = {}) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const rec = (fn: string, ret: unknown) => (...args: unknown[]) => {
    calls.push({ fn, args });
    return ret;
  };
  const msgs: Msg[] = [
    { key: 'a', pkg: 'com.whatsapp', app: 'WhatsApp', title: 'Anna', text: 'are we still on for tonight?', at: 1000 },
    { key: 'b', pkg: 'org.telegram.messenger', app: 'Telegram', title: 'Tom', text: 'sent you the file', at: 2000 },
    { key: 'c', pkg: 'com.whatsapp', app: 'WhatsApp', title: 'Annem ❤️', text: 'akşam yemeğe gel', at: 3000 },
  ];
  const n = {
    startTalk: rec('startTalk', true), stopTalk: rec('stopTalk', undefined), headsetInfo: rec('headsetInfo', { connected: false, name: null, type: null, micRouted: false, route: 'phone' }),
    routeMic: rec('routeMic', false), releaseMic: rec('releaseMic', undefined), claimButtons: rec('claimButtons', undefined),
    notificationAccess: rec('notificationAccess', true), openNotificationAccess: rec('openNotificationAccess', true), openAppSettings: rec('openAppSettings', true),
    recentMessages: rec('recentMessages', msgs), clearMessages: rec('clearMessages', undefined),
    setAlarm: rec('setAlarm', true), setTimer: rec('setTimer', true), draftMessage: rec('draftMessage', true),
    addListener: () => ({ remove: () => {} }),
    ...over,
  } as unknown as VoiceNative;
  return { n, calls };
}

function secretary(lang: 'en' | 'tr' | 'de' = 'en', native: VoiceNative | null = fakeNative().n) {
  const log: BrainEntry[] = [];
  const s = new Secretary({ lang, now: () => NOW, tx: translator(lang).tx, calendar: phoneCalendar, native, notes: notesStore, log: (e) => log.push(e) });
  return { s, log };
}

beforeEach(() => {
  mockStore.clear();
  clearNotes();
  Object.assign(mockCal, { granted: true, canAskAgain: true, asked: 0, created: [], events: [], calendars: [{ id: 'local', allowsModifications: true, isVisible: true }, { id: 'g', isPrimary: true, allowsModifications: true, isVisible: true }, { id: 'holidays', allowsModifications: false, isVisible: true }] });
});

describe('speaking dates', () => {
  it('days and clocks per language', () => {
    expect(clock(new Date(2026, 10, 6, 18, 0), 'en')).toBe('6 pm');
    expect(clock(new Date(2026, 10, 6, 6, 30), 'en')).toBe('6:30 am');
    expect(clock(new Date(2026, 10, 6, 18, 0), 'tr')).toBe('18:00');
    expect(when(new Date(2026, 10, 6, 18), false, NOW, 'tr', translator('tr').tx)).toBe('yarın saat 18:00');
    expect(when(new Date(2026, 10, 6, 18), false, NOW, 'de', translator('de').tx)).toBe('morgen um 18:00');
    expect(when(new Date(2026, 10, 9, 9), false, NOW, 'en', translator('en').tx)).toBe('on monday at 9 am');
    expect(when(new Date(2026, 11, 14), true, NOW, 'en', translator('en').tx)).toBe('on 14 december, all day');
  });
});

describe('calendar', () => {
  it('adding asks first, writes after yes into the primary writable calendar, and logs it', async () => {
    const { s, log } = secretary('tr');
    const q = await s.handle("yarın 18:00'e spor ekle");
    expect(say(q)).toBe('yarın saat 18:00 için spor ekliyorum, tamam mı?');
    expect(s.waiting()).toBe(say(q));
    expect(mockCal.created).toEqual([]);
    const done = await s.handle('evet');
    expect(say(done)).toBe('spor eklendi, yarın saat 18:00.');
    expect(mockCal.created).toHaveLength(1);
    expect(mockCal.created[0]).toMatchObject({ cal: 'g', title: 'spor', startDate: new Date(2026, 10, 6, 18), endDate: new Date(2026, 10, 6, 19), allDay: false });
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: 'voice', key: 'brain.voice.calendarAdd', tone: 'ok', vars: { title: 'spor', when: 'yarın saat 18:00', yes: ' · onaylandı' } });
    expect(log[0].detail).toContain('spor ekle');
    expect(s.waiting()).toBeNull();
  });

  it('a no writes nothing and is logged as declined', async () => {
    const { s, log } = secretary('en');
    await s.handle('add gym tomorrow at 6 pm');
    expect(say(await s.handle('no'))).toBe('okay, i won’t.');
    expect(mockCal.created).toEqual([]);
    expect(log[0]).toMatchObject({ key: 'brain.voice.declined', tone: 'warn' });
  });

  it('an unclear answer is asked again, twice unclear drops the question', async () => {
    const { s } = secretary('en');
    await s.handle('add gym tomorrow at 6 pm');
    expect(say(await s.handle('hmm'))).toBe('adding gym tomorrow at 6 pm. okay? yes or no?');
    await s.handle('what');
    const third = await s.handle('why is the sky blue');
    expect(third).toEqual({ kind: 'chat' });
    expect(s.waiting()).toBeNull();
    expect(mockCal.created).toEqual([]);
  });

  it('reads the day at once', async () => {
    mockCal.events = [
      { title: 'standup', startDate: new Date(2026, 10, 5, 9, 30), endDate: new Date(2026, 10, 5, 9, 45), allDay: false },
      { title: 'gym', startDate: new Date(2026, 10, 5, 18), endDate: new Date(2026, 10, 5, 19), allDay: false },
      { title: 'tomorrow thing', startDate: new Date(2026, 10, 6, 8), endDate: new Date(2026, 10, 6, 9), allDay: false },
    ];
    const { s, log } = secretary('en');
    expect(say(await s.handle("what's on my calendar today"))).toBe('today: 2 in your calendar. 9:30 am, standup. 6 pm, gym.');
    expect(log[0]).toMatchObject({ key: 'brain.voice.calendarRead', vars: { n: 2, day: 'today' } });
    expect(say(await s.handle('what do I have on saturday'))).toBe('nothing in your calendar on saturday.');
  });

  it('no permission: says so, opens nothing by itself, logs it', async () => {
    mockCal.granted = false;
    const { s, log } = secretary('en');
    const o = await s.handle('what do I have tomorrow');
    expect(o).toEqual({ kind: 'say', text: 'i can’t reach your calendar: the permission is off.', open: 'calendarPermission' });
    expect(mockCal.asked).toBe(1);
    expect(log[0]).toMatchObject({ key: 'brain.voice.denied', tone: 'warn' });
  });

  it('no writable calendar is a failure, not a crash', async () => {
    mockCal.calendars = [{ id: 'holidays', allowsModifications: false }];
    const { s, log } = secretary('en');
    await s.handle('add gym tomorrow at 6 pm');
    expect(say(await s.handle('yes'))).toBe('i found no calendar i may write to.');
    expect(log[0]).toMatchObject({ key: 'brain.voice.failed', tone: 'bad' });
  });
});

describe('messages', () => {
  it('reads the newest first, or from someone', async () => {
    const { s, log } = secretary('en');
    expect(say(await s.handle('read my messages'))).toBe('3 messages, newest first. Annem ❤️ on WhatsApp: akşam yemeğe gel. Tom on Telegram: sent you the file. Anna on WhatsApp: are we still on for tonight.');
    expect(say(await s.handle('what did Tom write'))).toBe('1 from tom. Tom on Telegram: sent you the file.');
    expect(log.map((l) => l.key)).toEqual(['brain.voice.messagesRead', 'brain.voice.messagesRead']);
    const tr = secretary('tr').s;
    expect(say(await tr.handle('annem ne yazdı'))).toBe("annem kişisinden 1 mesaj. WhatsApp üzerinden Annem ❤️: akşam yemeğe gel.");
  });

  it('loose names: anna finds Anna, not Annem; nobody is said plainly', () => {
    const list: Msg[] = [
      { key: '1', pkg: 'p', app: 'A', title: 'Anna', text: 'x', at: 1 },
      { key: '2', pkg: 'p', app: 'A', title: 'Annemarie Schulz', text: 'y', at: 2 },
      { key: '4', pkg: 'p', app: 'A', title: 'Annem', text: 'w', at: 0 },
      { key: '3', pkg: 'p', app: 'A', title: 'Bob', text: 'z', at: 3 },
    ];
    expect(pickMessages(list, 'anna').map((m) => m.key)).toEqual(['1']);
    expect(pickMessages(list, 'annemarie').map((m) => m.key)).toEqual(['2']);
    expect(pickMessages(list, 'schulz').map((m) => m.key)).toEqual(['2']);
    expect(pickMessages(list, 'carol')).toEqual([]);
  });

  it('without notification access it says how to turn it on', async () => {
    const { n } = fakeNative({ notificationAccess: () => false });
    const { s } = secretary('en', n);
    expect(await s.handle('read my messages')).toMatchObject({ kind: 'say', open: 'notificationAccess' });
  });

  it('a draft opens the app the person wrote from, only after yes, never sends', async () => {
    const { n, calls } = fakeNative();
    const { s, log } = secretary('en', n);
    expect(say(await s.handle("send a message to Anna saying I'm late"))).toBe("a message to anna: i'm late. shall i open it for you to send?");
    expect(calls.find((c) => c.fn === 'draftMessage')).toBeUndefined();
    expect(say(await s.handle('yes'))).toBe('the message is ready in the app. you send it.');
    expect(calls.find((c) => c.fn === 'draftMessage')?.args).toEqual(["i'm late", 'com.whatsapp']);
    expect(log[0]).toMatchObject({ key: 'brain.voice.draft', vars: { to: 'anna', app: 'WhatsApp' } });
  });

  it('without the native module the tools that need it say so', async () => {
    const { s } = secretary('en', null);
    expect(say(await s.handle('read my messages'))).toBe('that needs kula’s android app.');
  });
});

describe('alarms and timers', () => {
  it('an alarm after yes, through the clock app', async () => {
    const { n, calls } = fakeNative();
    const { s, log } = secretary('de', n);
    expect(say(await s.handle('weck mich um 6:30'))).toBe('ein wecker morgen um 06:30. okay?');
    expect(say(await s.handle('ja'))).toBe('wecker auf 06:30 gestellt.');
    expect(calls.find((c) => c.fn === 'setAlarm')?.args).toEqual([6, 30, null]);
    expect(log[0]).toMatchObject({ key: 'brain.voice.alarm', vars: { time: '06:30', yes: ' · bestätigt' } });
  });

  it('a timer with a label', async () => {
    const { n, calls } = fakeNative();
    const { s } = secretary('en', n);
    expect(say(await s.handle('remind me in 20 minutes to call mom'))).toBe('a 20 minutes timer: call mom. okay?');
    await s.handle('okay');
    expect(calls.find((c) => c.fn === 'setTimer')?.args).toEqual([1200, 'call mom']);
  });

  it('the clock app refusing is said and logged', async () => {
    const { n } = fakeNative({ setTimer: () => false });
    const { s, log } = secretary('en', n);
    await s.handle('set a timer for 10 minutes');
    expect(say(await s.handle('yes'))).toBe('the clock app didn’t take it.');
    expect(log[0]).toMatchObject({ key: 'brain.voice.failed', tone: 'bad' });
  });
});

describe('notes, time, the end, conversation', () => {
  it('notes are kept on the phone, read back, cleared after a yes', async () => {
    const { s, log } = secretary('tr');
    expect(say(await s.handle('not al: süt al'))).toBe('not aldım.');
    expect(say(await s.handle('not al ekmek'))).toBe('not aldım.');
    expect(JSON.parse(mockStore.get('voice.notes') ?? '[]')).toHaveLength(2);
    expect(say(await s.handle('notlarımı oku'))).toBe('2 notun var. en yenileri: ekmek. süt al.');
    expect(say(await s.handle('notlarımı sil'))).toBe('2 notun hepsini sileyim mi?');
    expect(say(await s.handle('evet'))).toBe('notların silindi.');
    expect(notesStore.list()).toEqual([]);
    expect(log.map((l) => l.key)).toEqual(['brain.voice.note', 'brain.voice.note', 'brain.voice.notesRead', 'brain.voice.notesClear']);
  });

  it('time and date are said at once', async () => {
    const { s } = secretary('en');
    expect(say(await s.handle('what time is it'))).toBe('it’s 10 am.');
    expect(say(await secretary('tr').s.handle('bugün günlerden ne'))).toBe('bugün 5 kasım 2026, perşembe.');
  });

  it('bye ends talk mode; free talk goes to the model', async () => {
    const { s } = secretary('en');
    expect(await s.handle('bye')).toEqual({ kind: 'say', text: 'bye. talk mode is off.', end: true });
    expect(await s.handle('tell me a joke')).toEqual({ kind: 'chat' });
  });

  it('every brain.voice key exists in the dictionary', () => {
    const keys = Object.keys(dict).filter((k) => k.startsWith('brain.voice.'));
    expect(keys.length).toBeGreaterThan(10);
  });
});

describe('the talk-mode prompt', () => {
  it('a concise secretary in the user’s language, with the date', () => {
    const p = systemPrompt('tr', NOW);
    expect(p).toContain('answer in Turkish');
    expect(p).toContain('one to three short spoken sentences');
    expect(p).toContain('Thursday, 2026-11-05');
  });
  it('remembers the last turns, starting with the user', () => {
    const h = Array.from({ length: 20 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `t${i}` }));
    const kept = remember(h, 3);
    expect(kept.map((t) => t.text)).toEqual(['t14', 't15', 't16', 't17', 't18', 't19']);
    expect(remember(h.slice(1), 10)[0].role).toBe('user');
    const msgs = buildMessages(h.slice(0, 2), 'merhaba', 'tr', NOW, { noThink: true });
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(msgs[3].content).toBe('merhaba /no_think');
  });
});
