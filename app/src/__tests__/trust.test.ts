// The security report on the phone (src/llm/trust.ts, src/llm/trustStore.ts): what is kept per
// device between looks, the verdict rules (the same as god's eye's trust branch on the computer),
// a whole look through a mocked tunnel and a mocked TrustVerify.kt, and the notes kept across a
// restart. The cryptography itself is tested on the JVM (TrustVerifyTest.kt).
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

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
jest.mock('@/llm/native', () => ({ llama: null, native: () => { throw new Error('nonative'); }, hasNative: () => false, GATE_PORT: 50551 }));

import { translator } from '@/i18n/core';
import type { TrustVerified } from '@/llm/native';
import type { Peer } from '@/llm/store';
import {
  accept, clusterReport, deviceReport, failed, freshNote, GUESS_LIMIT, hostCheck, look, OLD_WORKER, parseAnswer, sayCheck, sayHeadline, selfTitle, takeIn,
  type TrustAnswer, type TrustIO, type TrustNote,
} from '@/llm/trust';
import { acceptTrust, checkTrust, resetTrustCache, trustNotes } from '@/llm/trustStore';

const { tx } = translator('en');
const H = (c: string) => c.repeat(64).slice(0, 64);
const peer = (o: Partial<Peer> = {}): Peer => ({
  id: 'w1', name: 'Pixel', host: '192.168.1.33', port: 50551, secret: '', fp: H('f'), pin: null, kind: 'phone', ram: null, bw: null, added_at: '', ...o,
});
const answer = (o: Partial<TrustAnswer> = {}): TrustAnswer => ({
  id: 'a'.repeat(32), alg: 'p256', pub: 'cHVi', store: 'keystore', cert: 'Y2VydA==', v1: false, self: 'ok', found: null, more: false, lines: [], rejectsDay: {}, ...o,
});
const verified = (o: Partial<TrustVerified> = {}): TrustVerified => ({
  certPinned: true, cnMatches: true, keyIdMatches: true, keyId: 'a'.repeat(32), verified: 0, lastHash: null, problem: null, problemLine: null, ...o,
});
/** A device whose every check holds: answered, 3 lines verified. */
const good = (o: Partial<TrustNote> = {}): TrustNote => ({ ...takeIn(null, answer({ lines: ['1', '2', '3'] }), verified({ verified: 3, lastHash: H('3') }), null, 1_000), ...o });
const check = (n: TrustNote | null, k: string, p: Partial<Peer> = {}) => deviceReport(peer(p), n).checks.find((c) => c.k === k)!;

describe('parseAnswer', () => {
  it('takes a /trust body apart and drops what is not the contract', () => {
    const a = parseAnswer({
      v: 1, id: 'x'.repeat(32), key: { alg: 'ed25519', pub: 'AAA', store: 'file' }, cert: null, gate: { v1: true, tls: true, paired: 1 },
      ledger: { count: 3, head: H('1'), self: 'ok', found: true, more: true, lines: ['a', 7, 'b', 'x'.repeat(70_000)] },
      rejects: { day: { 'wrong pin': 2, bad: 'x' }, last: [] },
    });
    expect(a).toMatchObject({ alg: 'ed25519', store: 'file', cert: null, v1: true, found: true, more: true, lines: ['a', 'b'], rejectsDay: { 'wrong pin': 2 } });
    expect(parseAnswer(null)).toMatchObject({ id: null, lines: [], more: false, found: null, rejectsDay: {} });
    expect(parseAnswer({ ledger: { lines: Array.from({ length: 300 }, (_, i) => String(i)) } }).lines).toHaveLength(200);
  });
});

describe('takeIn: what is kept between looks', () => {
  it('a first look verifies the newest lines; the next joins on from the last one verified', () => {
    const n1 = takeIn(null, answer({ lines: ['1', '2'] }), verified({ verified: 2, lastHash: H('2') }), null, 1_000);
    expect(n1).toMatchObject({ answered: true, head: H('2'), verified: 2, since: 1_000, fault: null });
    const n2 = takeIn(n1, answer({ found: true, lines: ['3'] }), verified({ verified: 1, lastHash: H('3') }), H('2'), 2_000);
    expect(n2).toMatchObject({ head: H('3'), verified: 3, since: 1_000 });
    // nothing new: nothing changes but the time
    const n3 = takeIn(n2, answer({ found: true }), verified(), H('3'), 3_000);
    expect(n3).toMatchObject({ head: H('3'), verified: 3, at: 3_000 });
  });

  it('a ledger that started over is a fault until the person knows why, and the new chain is followed', () => {
    const n1 = takeIn(null, answer({ lines: ['1'] }), verified({ verified: 1, lastHash: H('1') }), null, 1_000);
    const n2 = takeIn(n1, answer({ found: false, lines: ['x', 'y'] }), verified({ verified: 2, lastHash: H('y') }), H('1'), 5_000);
    expect(n2.fault).toEqual({ why: 'restart', at: 5_000, line: null });
    expect(n2).toMatchObject({ head: H('y'), verified: 2, since: 5_000 });
    expect(check(n2, 'ledger').ok).toBe(false);
    // later looks go on from the new chain; the fault stays
    const n3 = takeIn(n2, answer({ found: true, lines: ['z'] }), verified({ verified: 1, lastHash: H('z') }), H('y'), 6_000);
    expect(n3.fault?.why).toBe('restart');
    const ok = accept(n3);
    expect(ok.fault).toBeNull();
    expect(ok.head).toBe(H('z'));
    expect(check(ok, 'ledger').ok).toBe(true);
  });

  // G2: asked from a line, only `found: true` goes on from it. Without it (null, left out, not a
  // boolean) the first line was never checked against the head, so the ledger started over.
  it('asked from a line, an answer without found: true is a ledger that started over', () => {
    const n1 = takeIn(null, answer({ lines: ['1'] }), verified({ verified: 1, lastHash: H('1') }), null, 1_000);
    for (const found of [null, false] as const) {
      const n2 = takeIn(n1, answer({ found, lines: ['x', 'y'] }), verified({ verified: 2, lastHash: H('y') }), H('1'), 5_000);
      expect(n2.fault).toEqual({ why: 'restart', at: 5_000, line: null });
      expect(n2).toMatchObject({ head: H('y'), verified: 2, since: 5_000 });
      expect(deviceReport(peer(), n2).verdict).toBe('bad');
    }
    // found: null and 'yes' come out of parseAnswer as null
    expect(parseAnswer({ ledger: { found: null } }).found).toBeNull();
    expect(parseAnswer({ ledger: { found: 'yes' } }).found).toBeNull();
    expect(parseAnswer({ ledger: {} }).found).toBeNull();
    // no found and no lines: the restart, and nothing to follow
    const empty = takeIn(n1, answer({ found: null }), verified(), H('1'), 6_000);
    expect(empty).toMatchObject({ fault: { why: 'restart', at: 6_000, line: null }, head: null, verified: 0, since: 0 });
    // found: true goes on as before
    const on = takeIn(n1, answer({ found: true, lines: ['2'] }), verified({ verified: 1, lastHash: H('2') }), H('1'), 7_000);
    expect(on).toMatchObject({ fault: null, head: H('2'), verified: 2, since: 1_000 });
    // a first look (no since, found null) is no restart
    expect(takeIn(null, answer({ found: null, lines: ['1'] }), verified({ verified: 1, lastHash: H('1') }), null, 1).fault).toBeNull();
  });

  it('a line that does not hold: the head stays at the last good one, the same line again is the same fault, accepting steps past it', () => {
    const n1 = takeIn(null, answer({ lines: ['1', '2', 'bad'] }), verified({ verified: 2, lastHash: H('2'), problem: 'sig', problemLine: H('b') }), null, 1_000);
    expect(n1).toMatchObject({ head: H('2'), verified: 2, fault: { why: 'sig', at: 1_000, line: H('b') } });
    const n2 = takeIn(n1, answer({ found: true, lines: ['bad', '4'] }), verified({ problem: 'sig', problemLine: H('b') }), H('2'), 9_000);
    expect(n2.fault!.at).toBe(1_000);
    expect(n2.head).toBe(H('2'));
    const ok = accept(n2);
    expect(ok).toMatchObject({ head: H('b'), fault: null });
    // an unknown problem word from the native side is still a red line, never a pass
    expect(takeIn(null, answer(), verified({ problem: 'weird', problemLine: H('w') }), null, 1).fault!.why).toBe('sig');
  });

  it('a look without an answer keeps what was known; an older kula says so', () => {
    const n = good();
    expect(failed(n, 'timeout', 9)).toBe(n);
    expect(failed(null, 'timeout', 9)).toMatchObject({ answered: false, error: 'timeout' });
    expect(failed(n, OLD_WORKER, 9)).toMatchObject({ answered: false, error: OLD_WORKER, head: n.head });
  });
});

describe('deviceReport: the checks and the verdict', () => {
  it('everything right: all clear, every check ticked', () => {
    const r = deviceReport(peer(), good());
    expect(r.verdict).toBe('ok');
    expect(r.name).toBe('pixel');
    expect(r.checks.map((c) => [c.k, c.ok])).toEqual([['pinned', true], ['encrypted', true], ['identity', true], ['refused', true], ['ledger', true], ['key', true]]);
    expect(sayCheck(r.checks[4], tx)).toMatch(/^3 lines checked here since \d{4}-\d\d-\d\d: the chain and every signature hold$/);
    expect(sayCheck(r.checks[2], tx)).toBe('certificate matches the pin and names its ledger key (aaaaaaaa…)');
  });

  it('an older pairing (a shared secret, no certificate) is red twice', () => {
    const r = deviceReport(peer({ fp: null, secret: 'ab'.repeat(16) }), good({ certPinned: null }));
    expect(r.verdict).toBe('bad');
    expect(sayCheck(r.checks[0], tx)).toMatch(/^older pairing/);
    expect(sayCheck(r.checks[1], tx)).toBe('prompts and answers cross the network in plain text');
  });

  it('tls, but the old plain-text protocol still open: red', () => {
    expect(check(good({ v1: true }), 'encrypted').ok).toBe(false);
    expect(deviceReport(peer(), good({ v1: true })).verdict).toBe('bad');
  });

  it('a relayed device whose certificate is still to be learned is not checked yet, never green', () => {
    const r = deviceReport(peer({ fp: '', relay: { url: 'wss://r', code: '123456' } }), good({ certPinned: null }));
    expect(r.checks[0].ok).toBeNull();
    expect(r.checks[1].ok).toBe(true);
    expect(r.verdict).toBe('unknown');
  });

  it('identity: another certificate, a key that is not the id, a cn of another device, nothing to compare', () => {
    expect(sayCheck(check(good({ certPinned: false }), 'identity'), tx)).toBe('the certificate it shows is not the one pinned from its qr');
    expect(check(good({ keyIdMatches: false }), 'identity').ok).toBe(false);
    expect(sayCheck(check(good({ cnMatches: false }), 'identity'), tx)).toBe('its certificate names another device than its ledger key');
    expect(check(good({ hasCert: false }), 'identity').ok).toBeNull();
    expect(deviceReport(peer(), good({ hasCert: false })).verdict).toBe('unknown');
  });

  it('refused today: a replay is red at once, wrong codes from the limit on', () => {
    expect(sayCheck(check(good({ rejectsDay: { replay: 1 } }), 'refused'), tx)).toBe('someone replayed a recorded handshake (1 time today); it was refused');
    expect(check(good({ rejectsDay: { 'wrong pin': GUESS_LIMIT - 2, 'bad proof': 1 } }), 'refused').ok).toBe(true);
    const many = check(good({ rejectsDay: { 'wrong pin': GUESS_LIMIT - 2, 'bad proof': 1, 'wrong secret': 1 } }), 'refused');
    expect(many.ok).toBe(false);
    expect(sayCheck(many, tx)).toBe(`${GUESS_LIMIT} wrong codes today: someone may be guessing. all were refused`);
    expect(sayCheck(check(good({ rejectsDay: { 'not paired': 2, 'wrong pin': 1 } }), 'refused'), tx)).toBe('refused today: not paired ×2, wrong pin ×1');
    expect(deviceReport(peer(), good({ rejectsDay: { 'not paired': 2, 'wrong pin': 1 } })).refused).toBe(3);
  });

  it('the ledger: the device saying its own is broken is red; no lines yet is grey and does not hold the verdict back', () => {
    expect(check(good({ self: 'broken' }), 'ledger').ok).toBe(false);
    const empty = takeIn(null, answer(), verified(), null, 1);
    expect(check(empty, 'ledger').ok).toBeNull();
    expect(deviceReport(peer(), empty).verdict).toBe('ok');
    expect(sayCheck(check(good({ fault: { why: 'chain', at: 1, line: H('c') } }), 'ledger'), tx)).toBe('its ledger: the chain is broken (a line was changed, dropped or put in)');
    expect(deviceReport(peer(), good({ fault: { why: 'chain', at: 1, line: H('c') } })).accept).toBe(true);
  });

  it('where the key lives is its word: shown, never counted', () => {
    const r = deviceReport(peer(), good({ store: 'file' }));
    expect(r.checks.find((c) => c.k === 'key')!.ok).toBeNull();
    expect(r.verdict).toBe('ok');
  });

  it('not asked yet, no answer, an older kula: not checked yet, never green', () => {
    expect(deviceReport(peer(), null).verdict).toBe('unknown');
    expect(sayCheck(check(null, 'identity'), tx)).toBe('not checked yet');
    expect(sayCheck(check(failed(null, 'no answer in time', 1), 'identity'), tx)).toBe('not checked: no answer in time');
    expect(sayCheck(check(failed(null, OLD_WORKER, 1), 'identity'), tx)).toMatch(/older kula without the security report/);
  });
});

describe('clusterReport: one verdict', () => {
  const ok = deviceReport(peer(), good());
  const bad = deviceReport(peer({ id: 'w2', name: 'Mac' }), good({ v1: true }));
  const grey = deviceReport(peer({ id: 'w3', name: 'Tab' }), null);
  const host = hostCheck({ ok: true, lines: 4 });

  it('all clear only when every device holds', () => {
    const r = clusterReport([ok], host);
    expect(r.verdict).toBe('ok');
    expect(sayHeadline(r.headline, tx, 'this phone')).toBe('1 device: every link pinned and encrypted, every ledger holds');
  });
  it('anything red is red, and the first thing to look at is named', () => {
    const r = clusterReport([ok, grey, bad], host);
    expect(r.verdict).toBe('bad');
    expect(sayHeadline(r.headline, tx, 'this phone')).toBe('mac: tls on this link, but it still accepts the old plain-text protocol');
    const two = clusterReport([bad, ok], hostCheck({ ok: false, lines: 4 }));
    expect(sayHeadline(two.headline, tx, 'this phone')).toBe('2 things to look at. first, mac: tls on this link, but it still accepts the old plain-text protocol');
    // only this phone's own ledger
    const mine = clusterReport([ok], hostCheck({ ok: false, lines: 4 }));
    expect(sayHeadline(mine.headline, tx, 'pixel 9')).toBe('pixel 9: its own ledger is broken: the chain does not hold');
  });
  it('this phone\'s own ledger says it read only its last lines; one line reads as before', () => {
    expect(sayCheck(hostCheck({ ok: true, lines: 200 }), tx)).toBe('its own ledger: its last 200 lines, the chain holds');
    expect(sayCheck(hostCheck({ ok: true, lines: 1 }), tx)).toBe('its own ledger: 1 line, the chain holds');
  });
  it('a device not checked yet makes it grey; no device at all too', () => {
    expect(clusterReport([ok, grey], host)).toMatchObject({ verdict: 'unknown' });
    expect(sayHeadline(clusterReport([ok, grey], host).headline, tx, '')).toBe('not checked yet: tab');
    expect(sayHeadline(clusterReport([], hostCheck(null)).headline, tx, '')).toBe('no devices to check yet');
    // this phone keeping no ledger yet never holds the verdict back
    expect(clusterReport([ok], hostCheck(null)).verdict).toBe('ok');
  });
});

describe('selfTitle: this phone is named once', () => {
  it('never "this phone · this phone"', () => {
    expect(selfTitle(null, 'this phone')).toEqual({ name: 'this phone', tag: null });
    expect(selfTitle('this phone', 'this phone')).toEqual({ name: 'this phone', tag: null });
    expect(selfTitle('this phone', 'bu telefon')).toEqual({ name: 'bu telefon', tag: null });
    expect(selfTitle('Pixel 9', 'this phone')).toEqual({ name: 'pixel 9', tag: 'this phone' });
  });
});

// ---- a whole look, through mocks of the tunnel, the device and TrustVerify.kt ----

/** A device's ledger: lines named l0, l1…; its /trust answers after `since` the way Trust.kt does. */
function device(n: number) {
  const lines = Array.from({ length: n }, (_, i) => `l${i}`);
  const hash = (l: string) => H(l.replace(/\D/g, '') || '0');
  const asked: (string | null)[] = [];
  let status = 200;
  const io: TrustIO & { asked: typeof asked; lines: string[]; setStatus: (s: number) => void } = {
    asked, lines, setStatus: (s) => { status = s; },
    tunnel: async () => 4242,
    get: async (url) => {
      const since = /since=([0-9a-f]{64})/.exec(url)?.[1] ?? null;
      asked.push(since);
      if (status !== 200) return { status, body: null };
      let found: boolean | null = null;
      let after = lines.slice(-200);
      if (since) {
        const i = lines.findIndex((l) => hash(l) === since);
        found = i >= 0;
        after = i >= 0 ? lines.slice(i + 1) : lines.slice(-200);
      }
      const page = after.slice(0, 2);
      return { status: 200, body: { v: 1, id: 'a'.repeat(32), key: { alg: 'ed25519', pub: 'cA==', store: 'file' }, cert: 'Yw==', gate: { v1: false }, ledger: { self: 'ok', found, more: after.length > 2 && !!since, lines: since ? page : after }, rejects: { day: {} } } };
    },
    // checks the chain the way the native side would: a line called "bad" fails its signature
    verify: async (_fp, _cert, _id, _alg, _pub, ls, expectPrev) => {
      let v = 0;
      let last: string | null = null;
      for (const l of ls) {
        if (l === 'bad') return verified({ verified: v, lastHash: last, problem: 'sig', problemLine: H('b') });
        if (expectPrev && v === 0 && Number(l.slice(1)) !== Number(lines.findIndex((x) => hash(x) === expectPrev)) + 1) return verified({ problem: 'chain', problemLine: hash(l) });
        v++;
        last = hash(l);
      }
      return verified({ verified: v, lastHash: last });
    },
    now: () => 7_000,
  };
  return io;
}

describe('look: one device asked', () => {
  it('asks from the last line verified, pages while there is more, and an older kula says so', async () => {
    const io = device(3);
    const n1 = await look(peer(), null, io);
    expect(io.asked).toEqual([null]);
    expect(n1).toMatchObject({ verified: 3, head: H('2'), store: 'file' });
    io.lines.push('l3', 'l4', 'l5', 'l6', 'l7');
    const n2 = await look(peer(), n1, io);
    // since=l2 gives l3 l4 (more), since=l4 gives l5 l6 (more), since=l6 gives l7
    expect(io.asked.slice(1)).toEqual([H('2'), H('4'), H('6')]);
    expect(n2).toMatchObject({ verified: 8, head: H('7'), fault: null });
    io.setStatus(404);
    expect(await look(peer(), n2, io)).toMatchObject({ answered: false, error: OLD_WORKER });
    io.setStatus(500);
    expect(await look(peer(), n2, io)).toBe(n2);
  });

  it('a failing line stops the look, and the next look asks for it again', async () => {
    const io = device(2);
    io.lines.push('bad', 'l3');
    const n = await look(peer(), null, io);
    expect(n).toMatchObject({ verified: 2, head: H('1'), fault: { why: 'sig', line: H('b') } });
    await look(peer(), n, io);
    expect(io.asked.at(-1)).toBe(H('1'));
  });

  // G2 ported (scratch g2.test.mts): a device that answers since=<head> without `found` and hands
  // over a rewritten chain. The verify stand-in keeps TrustVerify.kt's rules: line 0's prev must be
  // expectPrev when one is given, each next line's prev the line before.
  describe('an answer without found: true (G2)', () => {
    const line = (prev: string, h: string) => JSON.stringify({ prev, h });
    const chainIO = (ledger: Record<string, unknown>) => {
      const asked: string[] = [];
      const expects: (string | null)[] = [];
      const io: TrustIO & { asked: string[]; expects: (string | null)[] } = {
        asked, expects,
        tunnel: async () => 1,
        get: async (url) => { asked.push(url); return { status: 200, body: { id: 'a'.repeat(32), key: { alg: 'ed25519', pub: 'AA==', store: 'keystore' }, cert: 'Q0VSVA==', gate: { v1: false }, ledger: { self: 'ok', more: false, ...ledger } } }; },
        verify: async (_fp, _cert, _id, _alg, _pub, ls, expectPrev) => {
          expects.push(expectPrev);
          let last: string | null = expectPrev;
          let n = 0;
          for (let i = 0; i < ls.length; i++) {
            const o = JSON.parse(ls[i]);
            if ((i > 0 || expectPrev !== null) && o.prev !== last) return verified({ verified: n, lastHash: n ? last : null, problem: 'chain', problemLine: o.h });
            last = o.h; n++;
          }
          return verified({ verified: n, lastHash: n ? last : null });
        },
        now: () => 2,
      };
      return io;
    };
    const head = H('h');
    const was = (): TrustNote => ({ ...freshNote(), at: 1, answered: true, hasCert: true, certPinned: true, cnMatches: true, keyIdMatches: true, keyId: 'a'.repeat(32), head, verified: 40, since: 1 });
    const forged = [line('x'.repeat(64), 'n1'), line('n1', 'n2')];

    const shapes: [string, Record<string, unknown>][] = [['left out', {}], ['null', { found: null }], ["'yes'", { found: 'yes' }]];
    it.each(shapes)('found %s with a rewritten chain: the restart, the new chain followed, accept clears it', async (_w, f) => {
      const io = chainIO({ ...f, lines: forged });
      const n = await look(peer(), was(), io);
      expect(io.asked[0]).toMatch(new RegExp(`since=${head}`));
      expect(io.expects[0]).toBeNull();
      expect(n.fault).toEqual({ why: 'restart', at: 2, line: null });
      expect(n).toMatchObject({ head: 'n2', verified: 2, since: 2 });
      expect(deviceReport(peer(), n)).toMatchObject({ verdict: 'bad', accept: true });
      const ok = accept(n);
      expect(ok).toMatchObject({ fault: null, head: 'n2' });
      expect(check(ok, 'ledger').ok).toBe(true);
    });

    it('found left out and no lines: the restart, head null', async () => {
      const n = await look(peer(), was(), chainIO({ lines: [] }));
      expect(n).toMatchObject({ fault: { why: 'restart' }, head: null, verified: 0 });
    });

    it('found: true with linked lines goes on; with an unlinked first line it is a chain fault', async () => {
      const io = chainIO({ found: true, lines: [line(head, 'n1'), line('n1', 'n2')] });
      const n = await look(peer(), was(), io);
      expect(io.expects[0]).toBe(head);
      expect(n).toMatchObject({ fault: null, head: 'n2', verified: 42, since: 1 });
      const broken = await look(peer(), was(), chainIO({ found: true, lines: forged }));
      expect(broken).toMatchObject({ fault: { why: 'chain', line: 'n1' }, head, verified: 40 });
    });

    it('found: false: the restart, as before', async () => {
      const n = await look(peer(), was(), chainIO({ found: false, lines: forged }));
      expect(n).toMatchObject({ fault: { why: 'restart' }, head: 'n2', verified: 2 });
    });

    it('a first look (no since, found null) is no restart', async () => {
      const io = chainIO({ lines: forged });
      const n = await look(peer(), null, io);
      expect(io.asked[0]).not.toMatch(/since=/);
      expect(n).toMatchObject({ fault: null, head: 'n2', verified: 2 });
    });
  });

  it('a tunnel that does not open: not checked, with the reason', async () => {
    const io = { ...device(1), tunnel: async () => { throw new Error('gate: wrong pin'); } };
    expect(await look(peer(), null, io)).toMatchObject({ answered: false, error: 'gate: wrong pin' });
  });
});

describe('the notes on this phone', () => {
  beforeEach(() => {
    mockStore.clear();
    resetTrustCache();
  });

  it('are kept across a restart, follow on from there, and forget unpaired devices', async () => {
    const io = device(2);
    await checkTrust([peer(), peer({ id: 'w2', name: 'Mac' })], io);
    expect(trustNotes().w1).toMatchObject({ verified: 2, head: H('1') });
    resetTrustCache(); // the app restarted: read back from storage
    expect(trustNotes().w1.head).toBe(H('1'));
    io.lines.push('l2');
    await checkTrust([peer()], io);
    expect(trustNotes().w1).toMatchObject({ verified: 3, head: H('2') });
    expect(trustNotes().w2).toBeUndefined();
  });

  it('"i know why" clears a fault, and is kept', async () => {
    const io = device(1);
    io.lines.push('bad');
    await checkTrust([peer()], io);
    expect(trustNotes().w1.fault?.why).toBe('sig');
    acceptTrust('w1');
    resetTrustCache();
    expect(trustNotes().w1).toMatchObject({ fault: null, head: H('b') });
  });

  it('two asks at once share one look', async () => {
    const io = device(1);
    const a = checkTrust([peer()], io);
    const b = checkTrust([peer()], io);
    await Promise.all([a, b]);
    expect(io.asked).toHaveLength(1);
  });

  it('without the native module nothing is asked', async () => {
    await expect(checkTrust([peer()])).resolves.toBeUndefined();
    expect(trustNotes()).toEqual({});
  });

  it('a fresh note is empty', () => {
    expect(freshNote()).toMatchObject({ answered: false, head: null, verified: 0, fault: null });
  });
});
