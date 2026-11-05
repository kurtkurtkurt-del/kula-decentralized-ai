// The phone's event stream reader (llm/sse.ts) and chatRemote on top of it, driven through
// a fake XMLHttpRequest that hands the response over in random pieces.
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { describe, expect, it, jest } from '@jest/globals';
import * as fc from 'fast-check';

const mockStore = new Map<string, string>();
jest.mock('expo-sqlite/kv-store', () => ({
  __esModule: true,
  default: {
    getItemSync: (k: string) => mockStore.get(k) ?? null,
    setItemSync: (k: string, v: string) => mockStore.set(k, v),
    removeItemSync: (k: string) => mockStore.delete(k),
    getAllKeysSync: () => [...mockStore.keys()],
  },
}));
jest.mock('@/data/passport', () => ({ lastPassport: () => null }));
jest.mock('expo-device', () => ({ deviceType: 1, DeviceType: { TABLET: 2, DESKTOP: 3 }, osVersion: '15', totalMemory: 8e9 }));
jest.mock('@/llm/native', () => ({ native: () => null, hasNative: () => false, llama: null }));

import { SseReader, parseSse, type SseEvent } from '@/llm/sse';
import { chatRemote, type Device } from '@/llm/engine';

const tokenEvent = fc.record({ t: fc.string({ minLength: 1, maxLength: 20, unit: 'grapheme' }) });
const doneEvent = fc.record({ done: fc.constant(true), tokens: fc.nat(10000), ms: fc.nat(1e6), firstMs: fc.nat(1e5), tps: fc.double({ min: 0, max: 500, noNaN: true }) });
const errorEvent = fc.record({ error: fc.string({ minLength: 1, maxLength: 40 }) });
const stream = fc.tuple(fc.array(tokenEvent, { maxLength: 25 }), fc.oneof(doneEvent, errorEvent)).map(([t, last]) => [...t, last] as SseEvent[]);
const fractions = fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 10 });
const wire = (events: SseEvent[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
const pieces = (text: string, at: number[]) => {
  const idx = [...new Set(at.map((f) => Math.floor(f * text.length)))].sort((a, b) => a - b);
  const out: string[] = [];
  let prev = 0;
  for (const i of idx) { out.push(text.slice(prev, i)); prev = i; }
  out.push(text.slice(prev));
  return out;
};
const viaJson = (e: unknown) => JSON.parse(JSON.stringify(e));

describe('SseReader', () => {
  it('gives the same events whatever the chunk boundaries', () => {
    fc.assert(fc.property(stream, fractions, (events, at) => {
      const text = wire(events);
      const r = new SseReader();
      const got: SseEvent[] = [];
      for (const p of pieces(text, at)) got.push(...r.feed(p));
      got.push(...r.end());
      expect(got).toEqual(viaJson(events));
      expect(parseSse(text)).toEqual(viaJson(events));
    }), { numRuns: 300 });
  });

  it('skips lines that are not events and stops at done', () => {
    fc.assert(fc.property(stream.filter((s) => 'done' in s[s.length - 1]), fc.array(fc.string({ maxLength: 30 }).filter((l) => !l.includes('\n') && !l.startsWith('data:')), { maxLength: 5 }), fc.array(tokenEvent, { maxLength: 4 }), fractions, (events, junk, late, at) => {
      let text = '';
      for (const e of events) { for (const j of junk) text += j + '\n'; text += `data: ${JSON.stringify(e)}\n\n`; }
      text += wire(late) + 'garbage without end';
      const r = new SseReader();
      const got: SseEvent[] = [];
      for (const p of pieces(text, at)) got.push(...r.feed(p));
      got.push(...r.end());
      expect(got).toEqual(viaJson(events));
    }), { numRuns: 200 });
  });

  it('never throws on any text', () => {
    fc.assert(fc.property(fc.oneof(fc.string({ maxLength: 300 }), fc.string({ unit: 'binary', maxLength: 200 })), (t) => {
      expect(() => parseSse(t)).not.toThrow();
    }), { numRuns: 300 });
  });
});

// A fake XHR: the test pushes the response in pieces, like the native stack does.
type Fake = { readyState: number; status: number; responseText: string; onreadystatechange: (() => void) | null; onerror: (() => void) | null; open: () => void; setRequestHeader: () => void; send: () => void; abort: () => void };
let current: FakeXhr | null = null;
class FakeXhr implements Fake {
  readyState = 0; status = 200; responseText = ''; onreadystatechange: (() => void) | null = null; onerror: (() => void) | null = null;
  open() { this.readyState = 1; current = this; }
  setRequestHeader() {}
  send() {}
  abort() {}
  push(piece: string) { this.readyState = 3; this.responseText += piece; this.onreadystatechange?.(); }
  finish() { this.readyState = 4; this.onreadystatechange?.(); }
}
(globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;
(globalThis as unknown as { fetch: unknown }).fetch = async () => ({});
const dev: Device = { id: 'p', name: 'peer', local: false, busy: false, apiPort: 1 };

describe('chatRemote over a chunked response', () => {
  it('streams every token once and resolves with the done stats, however the response is cut', async () => {
    await fc.assert(fc.asyncProperty(stream.filter((s) => 'done' in s[s.length - 1]), fractions, async (events, at) => {
      const got: string[] = [];
      const p = chatRemote(dev, [{ role: 'user', content: 'hi' }], (t) => got.push(t), { maxTokens: 8, temperature: 0 });
      const x = current!;
      for (const piece of pieces(wire(events), at)) x.push(piece);
      x.finish();
      const r = await p;
      expect(got).toEqual(events.filter((e) => 't' in e).map((e) => e.t));
      const done = events[events.length - 1];
      expect(r).toMatchObject({ tokens: done.tokens, ms: done.ms, firstMs: done.firstMs, tps: done.tps, stopped: false, device: 'peer' });
    }), { numRuns: 150 });
  });

  it('rejects with the peer error, and with "peer gone" when the stream ends without done', async () => {
    const p1 = chatRemote(dev, [], () => {}, { maxTokens: 8, temperature: 0 });
    const x1 = current!;
    x1.push('data: {"t":"a"}\n\ndata: {"error":"out of memory"}\n\n');
    x1.finish();
    await expect(p1).rejects.toThrow('out of memory');
    const p2 = chatRemote(dev, [], () => {}, { maxTokens: 8, temperature: 0 });
    const x2 = current!;
    x2.push('data: {"t":"a"}\n\n');
    x2.status = 0;
    x2.finish();
    await expect(p2).rejects.toThrow('peer gone');
  });

  it('ignores tokens after done, and a done event split across the last two chunks still resolves', async () => {
    const got: string[] = [];
    const p = chatRemote(dev, [], (t) => got.push(t), { maxTokens: 8, temperature: 0 });
    const x = current!;
    x.push('data: {"t":"a"}\n\ndata: {"done":true,"tokens":1,"ms":5,"firstMs":2,"tps":200}');
    x.push('\n\ndata: {"t":"late"}\n\n');
    x.finish();
    expect((await p).tokens).toBe(1);
    expect(got).toEqual(['a']);
  });
});
