// The speaker (voice/speak.ts) over a mocked expo-speech: sentences queue, the first sound is
// announced once, "drained" comes only after the reply was closed and all of it was spoken,
// and a stop makes the old reply's late callbacks harmless.
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { describe, expect, it, jest } from '@jest/globals';

type Opts = { language?: string; rate?: number; onStart?: () => void; onDone?: () => void; onStopped?: () => void };
const mockSpoken: { text: string; opts: Opts }[] = [];
jest.mock('expo-speech', () => ({
  speak: (text: string, opts: Opts) => mockSpoken.push({ text, opts }),
  stop: async () => {},
  maxSpeechInputLength: 4000,
  getAvailableVoicesAsync: async () => mockVoices,
  VoiceQuality: { Default: 'Default', Enhanced: 'Enhanced' },
}));
const mockVoices: Parameters<typeof import("@/voice/speak").localVoice>[0] = [
  { identifier: 'en-us-x-iog-server', language: 'en-US', quality: 'Enhanced' as never },
  { identifier: 'tr-tr-x-cfs-network', language: 'tr-TR', quality: 'Enhanced' as never },
  { identifier: 'tr-tr-x-cfs-local', language: 'tr-TR', quality: 'Default' as never },
  { identifier: 'tr-tr-x-ama-local', language: 'tr-TR', quality: 'Enhanced' as never },
  { identifier: 'en-gb-x-gba-local', language: 'en-GB', quality: 'Enhanced' as never },
];

import { Speaker, localVoice } from '@/voice/speak';

describe('localVoice', () => {
  it('picks a voice installed on the phone, never a network or server one', () => {
    expect(localVoice(mockVoices, 'tr-TR')).toBe('tr-tr-x-ama-local'); // local, enhanced first
    expect(localVoice(mockVoices, 'en-US')).toBe('en-gb-x-gba-local'); // the server one is skipped; same language, other region
    expect(localVoice(mockVoices, 'de-DE')).toBeNull(); // none: the engine's default for the language
  });
});

describe('Speaker', () => {
  it('queues sentences in the voice, says sound once and drained after close', () => {
    mockSpoken.length = 0;
    const ev: string[] = [];
    const sp = new Speaker({ language: 'tr-TR', rate: 1.1 }, { sound: () => ev.push('sound'), drained: () => ev.push('drained') });
    sp.begin();
    sp.say('Birinci cümle.');
    sp.say('  ');
    sp.say('İkinci.');
    expect(mockSpoken.map((s) => s.text)).toEqual(['Birinci cümle.', 'İkinci.']);
    expect(mockSpoken[0].opts).toMatchObject({ language: 'tr-TR', rate: 1.1 });
    mockSpoken[0].opts.onStart?.();
    mockSpoken[1].opts.onStart?.();
    expect(ev).toEqual(['sound']);
    mockSpoken[0].opts.onDone?.();
    mockSpoken[1].opts.onDone?.();
    expect(ev).toEqual(['sound']); // the model may still be writing
    sp.close();
    expect(ev).toEqual(['sound', 'drained']);
  });

  it('a reply with nothing to say drains at once; a stopped reply’s late callbacks do nothing', () => {
    mockSpoken.length = 0;
    const ev: string[] = [];
    const sp = new Speaker({ language: 'en-US', rate: 1 }, { sound: () => ev.push('sound'), drained: () => ev.push('drained') });
    sp.begin();
    sp.close();
    expect(ev).toEqual(['drained']);
    sp.begin();
    sp.say('long story.');
    sp.stop();
    mockSpoken[0].opts.onStart?.();
    mockSpoken[0].opts.onStopped?.();
    sp.close();
    expect(ev).toEqual(['drained', 'drained']);
    // the late callbacks of the stopped one did nothing; only the explicit close drained
  });
});
