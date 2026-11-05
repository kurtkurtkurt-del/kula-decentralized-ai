// The brain tab's pictures (components/brain/*.ts): where the nodes sit, ring and bar math,
// sparkline buckets, the night window, node states, the folded timeline and its short keys.
import { describe, expect, it } from '@jest/globals';
import { clamp01, edge, fit, nodeShare, orbit, ringDash, shareSegments, sparkPath } from '@/components/brain/geometry';
import { big, buckets, HOUR, nodeState, speedOf, windowProgress } from '@/components/brain/stats';
import { group, shortKey, unitTotals } from '@/components/brain/grouping';
import type { BrainEntry } from '@/llm/brainlog';
import { dict } from '@/i18n/dict';

const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);

describe('orbit', () => {
  it('has no place for no device', () => expect(orbit(0, 100, 100, 50)).toEqual([]));
  it('puts one device to the right and two on either side', () => {
    expect(orbit(1, 100, 80, 50, 30)).toEqual([{ angle: 0, x: 150, y: 80 }]);
    const two = orbit(2, 100, 80, 50, 30);
    expect(two.map((p) => [p.x, p.y])).toEqual([[150, 80], [50, 80]]);
  });
  it('starts at the top from three on and goes round evenly on the ellipse', () => {
    const four = orbit(4, 100, 80, 50, 30);
    expect(four.map((p) => [p.x, p.y])).toEqual([[100, 50], [150, 80], [100, 110], [50, 80]]);
    for (const p of orbit(7, 0, 0, 120, 80)) expect(Math.abs((p.x / 120) ** 2 + (p.y / 80) ** 2 - 1)).toBeLessThan(0.01);
  });
  it('fits a long list with a "+k" place', () => {
    expect(fit([1, 2, 3], 8)).toEqual({ shown: [1, 2, 3], more: 0 });
    expect(fit([1, 2, 3, 4, 5], 4)).toEqual({ shown: [1, 2, 3], more: 2 });
  });
  it('finds where a line leaves a circle', () => {
    expect(edge({ x: 0, y: 0 }, { x: 10, y: 0 }, 3)).toEqual({ x: 3, y: 0 });
    expect(edge({ x: 0, y: 0 }, { x: 0, y: 0 }, 3)).toEqual({ x: 0, y: 0 });
  });
});

describe('rings and the share bar', () => {
  it('fills a ring by the share, clamped', () => {
    const r = ringDash(0.5, 10);
    expect(r.length).toBeCloseTo(Math.PI * 10, 0);
    expect(r.dash.split(' ').map(Number)[1]).toBeCloseTo(2 * Math.PI * 10, 0);
    expect(ringDash(2, 10).length).toBeCloseTo(2 * Math.PI * 10, 0);
    expect(ringDash(-1, 10).length).toBe(0);
    expect(clamp01(NaN)).toBe(0);
  });

  it('lays the parts out end to end and adds up to the whole', () => {
    const s = shareSegments([{ name: 'me', gb: 3 }, { name: 'tab', gb: 1 }]);
    expect(s.map((x) => x.frac)).toEqual([0.75, 0.25]);
    expect(s[1].start).toBe(0.75);
    expect(shareSegments([])).toEqual([]);
  });

  it('keeps a tiny part visible and still adds up to 1', () => {
    const s = shareSegments([{ name: 'me', gb: 10 }, { name: 'tiny', gb: 0.05 }], 0.05);
    expect(s[1].frac).toBe(0.05);
    expect(sum(s.map((x) => x.frac))).toBeCloseTo(1, 6);
  });

  it('shares equally when nothing was measured', () => {
    expect(shareSegments([{ name: 'a', gb: 0 }, { name: 'b', gb: 0 }]).map((x) => x.frac)).toEqual([0.5, 0.5]);
  });

  it('gives each device its part: split by gb, a whole copy apart and alone, none outside the model', () => {
    const split = [{ name: 'Pixel', gb: 1 }, { name: 'me', gb: 3 }];
    expect(nodeShare('split', split, 'pixel', true)).toBe(0.25);
    expect(nodeShare('split', split, 'gone', true)).toBe(0);
    expect(nodeShare('apart', split, 'pixel', true)).toBe(1);
    expect(nodeShare('alone', [], 'me', true)).toBe(1);
    expect(nodeShare('split', split, 'pixel', false)).toBe(0);
  });

  it('draws a sparkline with the highest at the top and zeros on the floor', () => {
    expect(sparkPath([], 10, 10)).toBe('');
    expect(sparkPath([0, 0], 10, 10, 0)).toBe('M0 10 L10 10');
    expect(sparkPath([0, 2, 1], 20, 10, 0)).toBe('M0 10 L10 0 L20 5');
  });
});

describe('stats', () => {
  const now = 1_000 * HOUR;
  it('buckets the last 24 h, oldest first, dropping what is outside', () => {
    const b = buckets([now - 23.5 * HOUR, now - 0.5 * HOUR, now - 0.1 * HOUR, now - 30 * HOUR, now + HOUR], now, 24, 12);
    expect(b).toHaveLength(12);
    expect(b[0]).toBe(1);
    expect(b[11]).toBe(2);
    expect(sum(b)).toBe(3);
  });

  it('knows where tonight stands across midnight', () => {
    const at = (h: number, m = 0) => new Date(2026, 10, 5, h, m);
    expect(windowProgress('23:00', '07:00', at(3))).toEqual({ open: true, frac: 0.5, length: 480, left: 240 });
    expect(windowProgress('23:00', '07:00', at(23))).toMatchObject({ open: true, frac: 0, left: 480 });
    expect(windowProgress('23:00', '07:00', at(12))).toEqual({ open: false, frac: 0, length: 480, left: 660 });
    expect(windowProgress('01:00', '05:00', at(2))).toMatchObject({ open: true, frac: 0.25 });
    expect(windowProgress('01:00', '05:00', at(5))).toMatchObject({ open: false, left: 20 * 60 });
  });

  it('picks a node state: refused, out, busy, idle, saved', () => {
    expect(nodeState({ busy: true }, 'rejected')).toBe('refused');
    expect(nodeState(undefined, 'verified')).toBe('saved');
    expect(nodeState({ busy: true, out: true }, 'none')).toBe('out');
    expect(nodeState({ busy: true }, 'none')).toBe('busy');
    expect(nodeState({ busy: false }, 'warn', true)).toBe('busy');
    expect(nodeState({ busy: false }, 'warn')).toBe('idle');
  });

  it('puts one speed big: the plan in a split, the sum apart, this phone alone', () => {
    const devs = [{ local: true, tps: 6.04 }, { local: false, tps: 3 }, { local: false, tps: 9, out: true }];
    expect(speedOf('apart', devs)).toBe(9);
    expect(speedOf('split', devs, 4.26)).toBe(4.3);
    expect(speedOf('split', devs, null)).toBe(6);
    expect(speedOf('alone', devs)).toBe(6);
    expect(speedOf('alone', [])).toBeNull();
  });

  it('writes big numbers short', () => {
    expect([big(950), big(12_400), big(1_420_000)]).toEqual(['950', '12K', '1.4M']);
  });
});

describe('the timeline', () => {
  const e = (at: number, p: Partial<BrainEntry>): BrainEntry => ({ at, kind: 'plan', key: 'brain.plan.alone', vars: {}, tone: 'info', ...p });

  it('has a short key, in the dictionary, for every sentence that needs one', () => {
    const keys = dict as Record<string, { en: string; de: string; tr: string }>;
    const long = Object.keys(dict).filter((k) => /^brain\.(plan\.|why\.|load\.|dispatch$|retry|night\.(start|end|failed)$|unit$|check\.|out$)/.test(k));
    expect(long.length).toBeGreaterThan(10);
    for (const k of long) {
      const s = shortKey(k);
      expect([k, s && keys[s] ? 'ok' : 'missing']).toEqual([k, 'ok']);
    }
    expect(shortKey('brain.why.somethingNew')).toBe('brain.short.skip');
    expect(shortKey('brain.voice.clock')).toBeNull();
  });

  it('folds a run of night lines and prompts, keeps the rest apart', () => {
    const list: BrainEntry[] = [
      e(9, { kind: 'unit', key: 'brain.unit', vars: { device: 'a', n: 3, tokens: 100 }, tone: 'ok' }),
      e(8, { kind: 'unit', key: 'brain.unit', vars: { device: 'b', n: 2, tokens: 50 }, tone: 'ok' }),
      e(7, { kind: 'check', key: 'brain.check.wrong', tone: 'warn' }),
      e(6, { kind: 'unit', key: 'brain.unit', vars: { device: 'a', n: 1, tokens: 10 }, tone: 'ok' }),
      e(5, { kind: 'dispatch', key: 'brain.dispatch', tone: 'info' }),
      e(4, { kind: 'dispatch', key: 'brain.dispatch', tone: 'info' }),
      e(3, { kind: 'plan', key: 'brain.plan.alone' }),
      e(2, { kind: 'plan', key: 'brain.plan.alone' }),
      e(1, { kind: 'skip', key: 'brain.why.remote', tone: 'warn' }),
      e(1, { kind: 'skip', key: 'brain.why.timeout', tone: 'bad' }),
    ];
    const g = group(list);
    expect(g.map((x) => [x.kind, x.items.length])).toEqual([['unit', 2], ['check', 1], ['unit', 1], ['dispatch', 2], ['plan', 1], ['plan', 1], ['skip', 2]]);
    expect(g[0].at).toBe(9);
    expect(g.at(-1)!.tone).toBe('bad');
    expect(new Set(g.map((x) => x.id)).size).toBe(g.length);
    expect(unitTotals(g[0].items)).toEqual({ devices: 2, n: 5, tokens: 150 });
  });

  it('keeps a row id when newer lines arrive on top', () => {
    const old = [e(1, { key: 'brain.plan.alone' })];
    const before = group(old)[0].id;
    const after = group([e(2, { kind: 'load', key: 'brain.load.done' }), ...old])[1].id;
    expect(after).toBe(before);
  });
});
