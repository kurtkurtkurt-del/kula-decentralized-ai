// The worker's event stream writer (api.ts Sse) against the phone's reader
// (app/src/llm/sse.ts SseReader): whatever the chunk boundaries, the same events come out;
// junk lines are skipped; nothing after `done` counts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { Sse } from '../src/api.ts';
import { SseReader, parseSse, type SseEvent } from '../../app/src/llm/sse.ts';

function fakeRes() {
  const chunks: string[] = [];
  const res = { writeHead() {}, flushHeaders() {}, write(c: string) { chunks.push(c); return true; }, end() {} };
  return { res: res as never, text: () => chunks.join('') };
}

const tokenEvent = fc.record({ t: fc.string({ minLength: 1, maxLength: 30, unit: 'grapheme' }) });
const doneEvent = fc.record({ done: fc.constant(true), tokens: fc.nat(10000), ms: fc.nat(1e6), firstMs: fc.nat(1e5), tps: fc.double({ min: 0, max: 500, noNaN: true }) });
const errorEvent = fc.record({ error: fc.string({ minLength: 1, maxLength: 40 }) });
const stream = fc.tuple(fc.array(tokenEvent, { maxLength: 30 }), fc.oneof(doneEvent, errorEvent)).map(([toks, last]) => [...toks, last] as SseEvent[]);

// splits text at the given fractions, so the same stream is cut in many ways
function cuts(text: string, at: number[]): string[] {
  const idx = [...new Set(at.map((f) => Math.floor(f * text.length)))].sort((a, b) => a - b);
  const out: string[] = [];
  let prev = 0;
  for (const i of idx) { out.push(text.slice(prev, i)); prev = i; }
  out.push(text.slice(prev));
  return out;
}

function readAll(pieces: string[]): SseEvent[] {
  const r = new SseReader();
  const out: SseEvent[] = [];
  for (const p of pieces) out.push(...r.feed(p));
  out.push(...r.end());
  return out;
}

const viaJson = (e: SseEvent[]) => JSON.parse(JSON.stringify(e));

test('fuzz: writer → reader round trip is the identity at any chunking', () => {
  fc.assert(fc.property(stream, fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 12 }), (events, at) => {
    const { res, text } = fakeRes();
    const sse = new Sse(res);
    for (const e of events) sse.send(e);
    const whole = text();
    assert.deepEqual(readAll(cuts(whole, at)), viaJson(events));
    assert.deepEqual(parseSse(whole), viaJson(events));
    // one character at a time too
    assert.deepEqual(readAll([...whole]), viaJson(events));
  }), { numRuns: 300 });
});

const junkLine = fc.oneof(
  fc.string({ maxLength: 40 }).filter((s) => !s.includes('\n') && !s.startsWith('data:')),
  fc.constant('data: {not json'),
  fc.constant('data: [1,2]'),
  fc.constant('data: null'),
  fc.constant('data:'),
  fc.constant(': comment'),
  fc.constant('event: ping'),
  fc.constant('data: "a string"'),
);

test('fuzz: junk lines between events are skipped', () => {
  fc.assert(fc.property(stream, fc.array(junkLine, { minLength: 1, maxLength: 8 }), fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 6 }), (events, junk, at) => {
    let text = '';
    events.forEach((e, i) => {
      text += `data: ${JSON.stringify(e)}\n\n`;
      if (i < events.length - 1) for (const j of junk) text += j + '\n';
    });
    assert.deepEqual(readAll(cuts(text, at)), viaJson(events));
  }), { numRuns: 200 });
});

test('fuzz: nothing after the done event is read', () => {
  fc.assert(fc.property(stream.filter((s) => 'done' in s[s.length - 1]), fc.array(tokenEvent, { minLength: 1, maxLength: 5 }), fc.string({ maxLength: 50 }), (events, extra, tail) => {
    const { res, text } = fakeRes();
    const sse = new Sse(res);
    for (const e of [...events, ...extra]) sse.send(e);
    const whole = text() + tail;
    const r = new SseReader();
    const got = [...r.feed(whole), ...r.end()];
    assert.deepEqual(got, viaJson(events));
    assert.equal(r.done, true);
    assert.deepEqual(r.feed('data: {"t":"late"}\n\n'), []);
  }), { numRuns: 200 });
});

test('fuzz: any text at all never throws and yields only objects', () => {
  fc.assert(fc.property(fc.oneof(fc.string({ maxLength: 500 }), fc.string({ unit: 'binary', maxLength: 300 })), fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 6 }), (text, at) => {
    const got = readAll(cuts(text, at));
    for (const e of got) assert.ok(e && typeof e === 'object' && !Array.isArray(e));
    assert.deepEqual(got, parseSse(text));
  }), { numRuns: 300 });
});

test('a crlf stream reads like an lf one', () => {
  const ev = [{ t: 'a' }, { t: 'b' }, { done: true, tokens: 2 }];
  const lf = ev.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  assert.deepEqual(parseSse(lf.replace(/\n/g, '\r\n')), ev);
  assert.deepEqual(parseSse(lf), ev);
});
