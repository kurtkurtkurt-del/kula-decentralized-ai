/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { describe, expect, it, jest } from '@jest/globals';
jest.mock('expo-sqlite/kv-store', () => ({ __esModule: true, default: { getItemSync: () => null, setItemSync: () => {} } }));
import { classify, explain, retryable } from '@/llm/errors';
import { ladder, stepRoute } from '@/llm/steps';
import { leftText, rate } from '@/llm/progress';
import { translator } from '@/i18n/core';

describe('errors: raw strings become one of a few kinds', () => {
  const cases: [unknown, string][] = [
    ['Network request failed', 'offline'],
    [new Error('java.net.UnknownHostException: huggingface.co'), 'offline'],
    ['not enough free space', 'disk'],
    ['ENOSPC: no space left on device', 'disk'],
    ['checksum mismatch (got 3f9a1c…)', 'sha'],
    ['size mismatch: 1200 of 4000', 'sha'],
    ['peer gone', 'peer'],
    ['peer mac-mini: unreachable', 'peer'],
    ['connect timed out', 'peer'],
    ['busy', 'busy'],
    ['gate: busy', 'busy'],
    ['toobig', 'toobig'],
    ['failed to allocate 2048 MB', 'toobig'],
    ['load failed', 'toobig'],
    ['wrong secret', 'secret'],
    ['gate: server proof wrong', 'secret'],
    ['peer http 401', 'secret'],
    ['hf 401', 'gated'],
    ['hf 404', 'notfound'],
    ['hf 503', 'server'],
    ['interrupted', 'interrupted'],
    ['nopeers', 'nopeers'],
    ['nonative', 'nonative'],
    ['nomodel', 'nomodel'],
    [null, 'unknown'],
    ['something else entirely', 'unknown'],
  ];
  it('maps each raw string to its kind', () => {
    for (const [raw, kind] of cases) expect({ raw, kind: classify(raw).kind }).toEqual({ raw, kind });
  });
  it('keeps the http code as detail', () => {
    expect(classify('hf 503').detail).toBe('503');
  });
  it('explains in three languages, never the raw text for a known kind', () => {
    for (const lang of ['en', 'de', 'tr'] as const) {
      const s = explain('checksum mismatch (got 3f9a1c…)', translator(lang).tx);
      expect(s).not.toMatch(/3f9a1c/);
      expect(s.length).toBeGreaterThan(8);
      expect(s).not.toMatch(/^err\./);
    }
  });
  it('shows a short detail only for the unknown kind', () => {
    expect(explain('zzz odd thing', translator('en').tx)).toMatch(/zzz odd thing/);
    expect(explain('x'.repeat(200), translator('en').tx)).toMatch(/…\)$/);
  });
  it('knows what is worth retrying', () => {
    expect(retryable('peer gone')).toBe(true);
    expect(retryable('Network request failed')).toBe(true);
    expect(retryable('wrong secret')).toBe(false);
    expect(retryable('not enough free space')).toBe(false);
  });
  it('every err.* key exists in all three languages', () => {
    const kinds = ['offline', 'disk', 'sha', 'peer', 'busy', 'toobig', 'secret', 'gated', 'notfound', 'server', 'interrupted', 'nopeers', 'nonative', 'nomodel', 'cancelled', 'unknown'];
    for (const lang of ['en', 'de', 'tr'] as const) for (const k of kinds) expect(translator(lang).tx(`err.${k}`)).not.toBe(`err.${k}`);
  });
});

describe('steps: the first-run ladder', () => {
  const base = { passport: false, models: 0, downloading: false, ran: false, peers: 0 };
  it('starts at measure', () => {
    expect(ladder(base)).toMatchObject({ current: 'measure', index: 0, allDone: false, done: [] });
  });
  it('moves rung by rung', () => {
    expect(ladder({ ...base, passport: true }).current).toBe('download');
    expect(ladder({ ...base, passport: true, models: 1 }).current).toBe('run');
    expect(ladder({ ...base, passport: true, models: 1, ran: true }).current).toBe('join');
    expect(ladder({ ...base, passport: true, models: 1, ran: true, peers: 1 })).toMatchObject({ current: null, allDone: true, index: 4 });
  });
  it('a skipped rung is still the current one', () => {
    // a peer added before a model: join is done, download is what is asked next
    const l = ladder({ ...base, passport: true, peers: 2 });
    expect(l.current).toBe('download');
    expect(l.done).toEqual(['measure', 'join']);
  });
  it('routes each step somewhere useful', () => {
    expect(stepRoute('measure', null)).toBe('/passport');
    expect(stepRoute('run', 'a/b')).toBe('/model/a%2Fb');
    expect(stepRoute('run', null)).toBe('/models');
    expect(stepRoute('join', null)).toBe('/peers');
  });
});

describe('download card arithmetic', () => {
  it('rate: first reading is taken as is, later ones smoothed', () => {
    expect(rate(null, 1048576, 1000)).toBe(1048576);
    expect(rate(1000, 2000, 1000)).toBeCloseTo(1300);
    expect(rate(1000, 0, 0)).toBe(1000);
  });
  it('time left in words', () => {
    const t = translator('en').t;
    expect(leftText(t, 10 * 1048576, null)).toBe('');
    expect(leftText(t, 100, 1048576)).toBe('almost there');
    expect(leftText(t, 30 * 1048576, 1048576)).toBe('30 s left');
    expect(leftText(t, 600 * 1048576, 1048576)).toBe('10 min left');
    expect(leftText(translator('tr').t, 600 * 1048576, 1048576)).toBe('10 dk kaldı');
  });
});
