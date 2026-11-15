// Talk mode end to end without a phone (15.11.2026): the controller (voice/useTalk.ts) with the
// recognizer, the voice, the model and the native module mocked. What a person does on the talk
// screen: press, speak, hear the secretary or the model, barge in, stop, forget; and the
// recognizer's event order on Android (voice/listen.ts heardEvents).
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
jest.mock('expo-speech-recognition', () => ({ ExpoSpeechRecognitionModule: {} }));

// the voice: every sentence starts and ends at once, so a reply is "spoken" synchronously
type SpeakOpts = { onStart?: () => void; onDone?: () => void };
const mockSpoken: string[] = [];
jest.mock('expo-speech', () => ({
  speak: (text: string, o: SpeakOpts) => {
    mockSpoken.push(text);
    o.onStart?.();
    o.onDone?.();
  },
  stop: async () => {},
  maxSpeechInputLength: 4000,
  getAvailableVoicesAsync: async () => [],
  VoiceQuality: { Default: 'Default', Enhanced: 'Enhanced' },
}));

// the recognizer: the test plays its events through the handlers the controller registered
type Heard = { partial: (t: string) => void; final: (t: string) => void; silence: () => void; error: (c: string, m: string) => void; start: () => void };
const mockRec = {
  heard: null as Heard | null,
  starts: 0,
  aborts: 0,
  ready: { ok: true, onDevice: true } as { ok: true; onDevice: boolean } | { ok: false; why: string },
  download: 'started' as 'done' | 'started' | 'failed',
  mic: 'ask' as 'granted' | 'ask' | 'blocked',
};
jest.mock('@/voice/listen', () => ({
  ready: async () => mockRec.ready,
  startListening: () => void mockRec.starts++,
  abortListening: () => void mockRec.aborts++,
  onHeard: (h: Heard) => {
    mockRec.heard = h;
    return () => {};
  },
  downloadModel: async () => mockRec.download,
  micPermission: async () => mockRec.mic,
}));

// the model: devices and a chat whose tokens the test hands out
type ChatOpts = { device?: string };
const mockEngine = {
  load: true as boolean,
  devices: [{ id: 'me', local: true }, { id: 'pc', local: false }] as { id: string; local: boolean }[],
  calls: [] as { messages: { role: string; content: string }[]; opts: ChatOpts }[],
  reply: 'Paris is the capital of France.',
  fail: false,
};
jest.mock('@/llm/engine', () => ({
  engine: () => ({ load: mockEngine.load ? {} : null, devices: mockEngine.devices, model: { id: 'llama', name: 'Llama' } }),
  chat: (messages: { role: string; content: string }[], onToken: (t: string) => void, opts: ChatOpts) => {
    mockEngine.calls.push({ messages, opts });
    const p = (async () => {
      if (mockEngine.fail) throw new Error('boom');
      for (const w of mockEngine.reply.split(/(?<= )/)) onToken(w);
      return { tokens: 5, ms: 1, firstMs: 1, tps: 5, stopped: false, device: 'me' };
    })() as Promise<unknown> & { stop: () => void };
    p.stop = () => {};
    return p;
  },
}));
jest.mock('@/llm/brainlog', () => ({ note: () => {} }));
jest.mock('@/i18n', () => ({ useLang: () => ({ lang: 'en' }) })); // only the hook; the controller translates with i18n/core
jest.mock('@/voice/calendar', () => ({ phoneCalendar: { permission: async () => mockCalOk, events: async () => [], add: async () => true } }));
let mockCalOk = true;

import { setVoiceNative, type Msg, type VoiceNative } from '@/voice/native';
import { TalkController, type Config } from '@/voice/useTalk';

// the real filter, under the mock the controller uses
const { heardEvents } = jest.requireActual<typeof import('@/voice/listen')>('@/voice/listen');

let access = true;
const msgs: Msg[] = [{ key: '1', pkg: 'com.whatsapp', app: 'WhatsApp', title: 'Ada', text: 'your code is 482193', at: 1 }];
const fakeNative = {
  startTalk: () => true,
  stopTalk: () => {},
  headsetInfo: () => ({ connected: false, name: null, type: null, micRouted: false, route: 'phone' }),
  notificationAccess: () => access,
  recentMessages: () => msgs,
  addListener: () => ({ remove: () => {} }),
} as unknown as VoiceNative;

const cfg: Config = { lang: 'en', onDeviceOnly: true, rate: 1, continuous: true, headsetMic: false };
const flush = () => new Promise((r) => setTimeout(r, 0));

let c: TalkController;
let unmount: () => void;
beforeEach(() => {
  mockSpoken.length = 0;
  mockEngine.calls = [];
  mockEngine.load = true;
  mockEngine.fail = false;
  mockEngine.reply = 'Paris is the capital of France.';
  mockEngine.devices = [{ id: 'me', local: true }, { id: 'pc', local: false }];
  Object.assign(mockRec, { starts: 0, aborts: 0, ready: { ok: true, onDevice: true }, download: 'started', mic: 'ask' });
  access = true;
  mockCalOk = true;
  setVoiceNative(fakeNative);
  c = new TalkController(cfg);
  unmount = c.mount();
});
const view = () => c.snapshot();
/** Press, wait for the listen to start, say the words, wait for the answer. */
async function say(words: string) {
  if (view().loop.phase === 'idle') c.press();
  await flush();
  mockRec.heard!.final(words);
  await flush();
  await flush();
}

describe('talk mode, the secretary', () => {
  it('a tool answers out loud, shows both lines, and listens again hands-free', async () => {
    await say('what time is it');
    const t = view().turns;
    expect(t.map((x) => x.who)).toEqual(['you', 'kula']);
    expect(t[0].text).toBe('what time is it');
    expect(t[1].text).toMatch(/^it’s /);
    expect(mockSpoken.join(' ')).toMatch(/^it’s /);
    expect(view().loop.phase).toBe('listening');
    expect(mockRec.starts).toBe(2);
  });

  it('"bye" says goodbye and rests, without opening the microphone again', async () => {
    await say('bye');
    expect(view().loop.phase).toBe('idle');
    expect(mockRec.starts).toBe(1);
    expect(mockSpoken.join(' ')).toMatch(/bye/);
  });

  it('a write is asked first; the question shows and stop drops it', async () => {
    await say('add gym tomorrow at 6 pm');
    expect(view().question).toMatch(/adding gym tomorrow/);
    c.close();
    expect(view().question).toBeNull();
    expect(view().loop.phase).toBe('idle');
  });

  it('read messages without access: the notice comes up and goes once access is on', async () => {
    access = false;
    await say('read my messages');
    expect(view().banner).toBe('notificationAccess');
    access = true;
    await c.recheck();
    expect(view().banner).toBeNull();
  });

  it('a calendar refused, then allowed in the system settings: its notice goes', async () => {
    mockCalOk = false;
    await say("what's on my calendar today");
    expect(view().banner).toBe('calendarPermission');
    mockCalOk = true;
    await c.recheck();
    expect(view().banner).toBeNull();
  });
});

describe('talk mode, the model', () => {
  it('a free question is answered by the model, streamed into one line', async () => {
    await say('what is the capital of france');
    expect(mockEngine.calls).toHaveLength(1);
    expect(view().turns.at(-1)).toMatchObject({ who: 'kula', text: 'Paris is the capital of France.' });
    expect(view().turns).toHaveLength(2);
  });

  it('after the secretary read messages aloud, the next question is answered on this phone (8B.1)', async () => {
    await say('read my messages');
    await say('what did she mean');
    const call = mockEngine.calls[0];
    expect(call.opts.device).toBe('me');
    expect(JSON.stringify(call.messages)).toContain('482193');
  });

  it('with no device on this phone the read-outs are left out of the prompt', async () => {
    mockEngine.devices = [{ id: 'pc', local: false }];
    await say('read my messages');
    await say('what did she mean');
    expect(JSON.stringify(mockEngine.calls[0].messages)).not.toContain('482193');
  });

  it('a model that said nothing (all thinking) says so instead of listening in silence', async () => {
    mockEngine.reply = '<think>hmm</think>';
    await say('tell me a story');
    expect(view().turns.at(-1)?.text).toBe('the model gave no answer. ask again, a little shorter.');
    expect(mockSpoken.join(' ')).toContain('no answer');
  });

  it('a model error is said once, its empty line is gone, and the loop rests', async () => {
    mockEngine.fail = true;
    await say('tell me a story');
    const t = view().turns;
    expect(t.filter((x) => x.who === 'kula' && !x.text)).toHaveLength(0);
    expect(t.at(-1)).toMatchObject({ error: true, text: 'the model stopped with an error.' });
    expect(view().loop.phase).toBe('idle');
  });

  it('no model loaded: the secretary still works, a question is told how to load one', async () => {
    mockEngine.load = false;
    await say('what is the capital of france');
    expect(mockEngine.calls).toHaveLength(0);
    expect(view().turns.at(-1)?.text).toMatch(/no model is loaded/);
    expect(view().banner).toBeNull(); // the screen's own notice says it; not twice
  });

  it('new conversation forgets the lines and the model memory', async () => {
    await say('what is the capital of france');
    c.close();
    c.forget();
    expect(view().turns).toHaveLength(0);
    await say('and of italy');
    expect(mockEngine.calls[1].messages.map((m) => m.role)).toEqual(['system', 'user']);
  });
});

describe('talk mode, listening', () => {
  it('a late recognizer error while the model answers changes nothing', async () => {
    c.press();
    await flush();
    mockRec.heard!.final('what is the capital of france');
    c.heardError('network'); // arrives while thinking
    await flush();
    await flush();
    expect(view().banner).toBeNull();
    expect(view().turns.at(-1)?.text).toBe('Paris is the capital of France.');
  });

  it('the missing on-device pack: download fails → its notice and a way out; done → it listens', async () => {
    c.press();
    await flush();
    c.heardError('language-not-supported');
    expect(view().banner).toBe('noModel');
    expect(view().loop.phase).toBe('idle');
    mockRec.download = 'failed';
    await c.downloadModel();
    expect(view().banner).toBe('downloadFailed');
    mockRec.download = 'done';
    await c.downloadModel();
    await flush();
    expect(view().banner).toBeNull();
    expect(view().loop.phase).toBe('listening');
  });

  it('no microphone yet: the why first, then the system asks, then it listens', async () => {
    mockRec.ready = { ok: false, why: 'permission' };
    c.press();
    await flush();
    expect(view().banner).toBe('permission');
    expect(view().loop.phase).toBe('idle');
    mockRec.ready = { ok: true, onDevice: true };
    c.allowMic();
    await flush();
    expect(view().banner).toBeNull();
    expect(view().loop.phase).toBe('listening');
  });

  it('closing the screen stops everything', async () => {
    c.press();
    await flush();
    unmount();
    expect(view().loop.phase).toBe('idle');
    expect(mockRec.aborts).toBeGreaterThan(0);
  });
});

describe('heardEvents (the recognizer on Android)', () => {
  const rec = () => {
    const out: string[] = [];
    const on = heardEvents({ start: () => out.push('start'), partial: (t) => out.push(`partial:${t}`), final: (t) => out.push(`final:${t}`), silence: () => out.push('silence'), error: (c) => out.push(`error:${c}`) });
    return { on, out };
  };
  it('no match is one silence, not two (nomatch, then error no-speech, then end)', () => {
    const { on, out } = rec();
    on.start();
    on.nomatch();
    on.error('no-speech', '');
    on.end();
    expect(out).toEqual(['start', 'silence']);
  });
  it('an abort reports nothing the loop acts on, and its end is dropped', () => {
    const { on, out } = rec();
    on.start();
    on.error('aborted', '');
    on.end();
    expect(out).toEqual(['start', 'error:aborted']);
  });
  it('a final result is the only outcome of its listen', () => {
    const { on, out } = rec();
    on.start();
    on.result('hel', false);
    on.result('hello', true);
    on.end();
    expect(out).toEqual(['start', 'partial:hel', 'final:hello']);
  });
  it('a new listen that fails before its start still reaches the loop', () => {
    const { on, out } = rec();
    on.start();
    on.result('hi', true);
    on.error('not-allowed', '');
    expect(out).toEqual(['start', 'final:hi', 'error:not-allowed']);
  });
});
