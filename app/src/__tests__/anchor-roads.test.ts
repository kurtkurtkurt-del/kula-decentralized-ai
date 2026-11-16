// The phone's side of the anchor network (docs/ANCHOR.md, 16.11.2026): a device's roads in
// order (the wi-fi, then its direct internet addresses, then the anchors), the staggered pick
// where the pinned certificate decides, split (rpc) allowed through an anchor while only the
// hosted relay stays out, the anchor's invite read from its code, its base64url line and its
// typed form, the join, and the stored roads healed like everything stored. The native module is
// a mock whose probePeer answers per road (an address, or an anchor's certificate).
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

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

type AnchorArg = { host: string; port: number; fp: string } | null | undefined;
const mockNative = {
  // "host:port" or "anchor:<fp8>" → [delay ms, answer]; missing: refused at once
  roads: {} as Record<string, [number, string | null]>,
  probes: [] as { key: string; channel: string; anchor: AnchorArg; at: number }[],
  joined: [] as { fp: string; name: string; host: string; port: number; addrs: []; joinedAt: number; waitingBack: boolean }[],
  joins: [] as unknown[],
  joinAnswer: null as null | { fp: string; name: string; host: string; port: number; via: string; again: boolean; sharing: boolean },
  probePeer: (host: string, port: number, _secret: string, channel: string, _tls: unknown, _relay: unknown, anchor?: AnchorArg) => {
    const key = anchor ? `anchor:${anchor.fp.slice(0, 8)}` : `${host}:${port}`;
    mockNative.probes.push({ key, channel, anchor, at: Date.now() });
    const [ms, answer] = mockNative.roads[key] ?? [0, 'refused'];
    return new Promise<string | null>((resolve) => setTimeout(() => resolve(answer), ms));
  },
  joinedAnchors: async () => mockNative.joined,
  joinAnchor: async (inv: unknown) => {
    mockNative.joins.push(inv);
    if (!mockNative.joinAnswer) throw new Error('this invite was used already: each invite works once. ask for a new one.');
    return mockNative.joinAnswer;
  },
  forgets: [] as string[],
  forgetFails: false,
  forgetAnchor: async (fp: string) => {
    if (mockNative.forgetFails) throw new Error('no store');
    mockNative.forgets.push(fp);
    return [];
  },
};
jest.mock('@/llm/native', () => ({ get llama() { return mockNative; }, native: () => mockNative, hasNative: () => true, GATE_PORT: 50551 }));

import { peerArgs, probeAll, REMOTE_NO_SPLIT, type Plan } from '@/llm/cluster';
import { forgetPeerRow, fromBase64Url, isInvite, isPeerQr, joinInvite, parseInvite, parsePeerQr, takePeerQr } from '@/llm/peers';
import { addrKind, cleanRoad, pickRoad, reachedBy, roadArgs, roadsOf, ROAD_STAGGER_MS, type RoadProbe } from '@/llm/roads';
import { healPeers, peers, rememberPeer, type Peer, type Road } from '@/llm/store';

const FP_B = 'b'.repeat(64);
const FP_A = 'a1'.repeat(32);
const FP_Z = 'c3'.repeat(32);
const peer = (o: Partial<Peer> = {}): Peer => ({ id: 'b', name: 'b', host: '192.168.1.20', port: 50551, secret: '', fp: FP_B, pin: null, kind: 'pc', ram: 8000, bw: 20, added_at: '', ...o });

// base64url of a utf-8 string, the way kula-node's peerCode writes it
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

beforeEach(() => {
  jest.useFakeTimers();
  mockNative.roads = {};
  mockNative.probes = [];
  mockNative.joined = [];
  mockNative.joins = [];
  mockNative.joinAnswer = null;
  mockNative.forgets = [];
  mockNative.forgetFails = false;
  mockStore.clear();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('roads in order', () => {
  it('the wi-fi first, then the direct internet addresses, then the device’s anchors, then the ones this phone joined', () => {
    const p = peer({
      addrs: [{ host: '203.0.113.5', port: 50551, via: 'mapped' }, { host: '2001:db8::5', port: 50551, via: 'ipv6' }],
      anchors: [{ fp: FP_A, host: '198.51.100.7', port: 50551, name: 'berlin' }],
    });
    const r = roadsOf(p, [{ fp: FP_Z, host: '198.51.100.9', port: 50552 }, { fp: FP_A, host: '198.51.100.7', port: 50551 }]);
    expect(r).toEqual([
      { host: '192.168.1.20', port: 50551, via: 'lan' },
      { host: '203.0.113.5', port: 50551, via: 'mapped' },
      { host: '2001:db8::5', port: 50551, via: 'ipv6' },
      { via: 'anchor', anchor: FP_A, host: '198.51.100.7', port: 50551, name: 'berlin' },
      { via: 'anchor', anchor: FP_Z, host: '198.51.100.9', port: 50552 },
    ]);
  });
  it('never the device as its own anchor; no anchors without a pinned certificate; the relay keeps its one way', () => {
    expect(roadsOf(peer({ fp: FP_A }), [{ fp: FP_A, host: '198.51.100.7', port: 1 }])).toHaveLength(1);
    expect(roadsOf(peer({ fp: null }), [{ fp: FP_A, host: '198.51.100.7', port: 1 }])).toEqual([{ host: '192.168.1.20', port: 50551, via: 'lan' }]);
    expect(roadsOf(peer({ relay: { url: 'wss://r', code: '123456' } }), [{ fp: FP_A, host: '198.51.100.7', port: 1 }])).toEqual([]);
  });
  it('names the kind of a bare address the way the rows say it', () => {
    expect(addrKind('192.168.1.5')).toBe('lan');
    expect(addrKind('10.0.0.2')).toBe('lan');
    expect(addrKind('203.0.113.5')).toBe('mapped');
    expect(addrKind('2001:db8::1')).toBe('ipv6');
    expect(addrKind('fe80::1')).toBe('lan');
  });
});

describe('the staggered pick', () => {
  const list: Road[] = [
    { host: '192.168.1.20', port: 50551, via: 'lan' },
    { host: '203.0.113.5', port: 50551, via: 'mapped' },
    { via: 'anchor', anchor: FP_A, host: '198.51.100.7', port: 50551 },
  ];
  const probeBy = (answers: Record<number, [number, string | null]>, starts: number[]): RoadProbe => (road) => {
    const i = list.indexOf(road);
    starts[i] = Date.now();
    const [ms, a] = answers[i] ?? [0, 'refused'];
    return new Promise((res) => setTimeout(() => res(a), ms));
  };

  it('a silent lan, a dead mapped port, then the anchor: tries start 250 ms apart, a failure starts the next at once', async () => {
    const t0 = Date.now();
    const starts: number[] = [];
    // the lan never answers in time (it fails after 2 s); the mapped port refuses after 100 ms
    const p = pickRoad(list, probeBy({ 0: [2000, 'connect timed out'], 1: [100, 'refused'], 2: [300, null] }, starts));
    await jest.advanceTimersByTimeAsync(3000);
    const r = await p;
    expect(r.road).toEqual(list[2]);
    expect(starts[1] - t0).toBe(ROAD_STAGGER_MS);
    // the mapped try failed at 350 ms: the anchor starts then, not at its 500 ms
    expect(starts[2] - t0).toBe(ROAD_STAGGER_MS + 100);
  });
  it('back home the lan answers before the second try starts', async () => {
    const starts: number[] = [];
    const p = pickRoad(list, probeBy({ 0: [20, null], 1: [10, null], 2: [10, null] }, starts));
    await jest.advanceTimersByTimeAsync(1000);
    expect((await p).road).toEqual(list[0]);
    expect(starts.filter((s) => s !== undefined)).toHaveLength(1);
  });
  it('the earliest in order among those that answered wins; none: the first road’s reason', async () => {
    const p = pickRoad(list, probeBy({ 0: [5000, 'timeout'], 1: [400, null], 2: [10, null] }, []));
    await jest.advanceTimersByTimeAsync(6000);
    // the anchor answered at 510 ms, the mapped port at 650 ms: the anchor won, as in node's pickRoute
    expect((await p).road).toEqual(list[2]);
    const q = pickRoad(list, probeBy({ 0: [10, 'gate: fingerprint mismatch'], 1: [10, 'refused'], 2: [10, 'anchor: not here'] }, []));
    await jest.advanceTimersByTimeAsync(1000);
    expect(await q).toEqual({ road: null, why: 'gate: fingerprint mismatch' });
  });
  it('with an unspent pairing code the roads are tried one at a time', async () => {
    const starts: number[] = [];
    const t0 = Date.now();
    const p = pickRoad(list, probeBy({ 0: [1000, 'timeout'], 1: [1000, 'timeout'], 2: [10, null] }, starts), { serial: true });
    await jest.advanceTimersByTimeAsync(3000);
    expect((await p).road).toEqual(list[2]);
    expect(starts[1] - t0).toBe(1000);
    expect(starts[2] - t0).toBe(2000);
  });
});

describe('probeAll along the roads', () => {
  it('split (rpc) goes through an anchor: the peer comes back with the anchor road, and the tunnel args carry it', async () => {
    mockNative.joined = [{ fp: FP_A, name: 'berlin', host: '198.51.100.7', port: 50551, addrs: [], joinedAt: 0, waitingBack: false }];
    mockNative.roads = { [`anchor:${FP_A.slice(0, 8)}`]: [50, null] };
    rememberPeer(peer());
    const p = probeAll([peer()], 'rpc');
    await jest.advanceTimersByTimeAsync(2000);
    const r = await p;
    expect(r.bad).toEqual([]);
    expect(r.ok[0].route).toEqual({ via: 'anchor', anchor: FP_A, host: '198.51.100.7', port: 50551, name: 'berlin' });
    // the probe through the anchor was on rpc, with the anchor's own address and certificate
    expect(mockNative.probes.find((x) => x.anchor)).toEqual(expect.objectContaining({ channel: 'rpc', anchor: { host: '198.51.100.7', port: 50551, fp: FP_A } }));
    // the road is kept with the peer, and the split's tunnel follows it
    expect(peers()[0].route).toEqual(r.ok[0].route);
    const plan = { used: [{ ...r.ok[0], assignedMb: 900 }] } as unknown as Plan;
    expect(peerArgs(plan)).toEqual([expect.objectContaining({ host: '192.168.1.20', port: 50551, fp: FP_B, weight: 900, anchor: { host: '198.51.100.7', port: 50551, fp: FP_A } })]);
    expect(reachedBy(r.ok[0])).toBe('anchor');
  });
  it('a direct internet address beats the anchor, and the lan clears the route again', async () => {
    const p0 = peer({ addrs: [{ host: '203.0.113.5', port: 50551, via: 'mapped' }], anchors: [{ fp: FP_A, host: '198.51.100.7', port: 50551 }] });
    mockNative.roads = { '203.0.113.5:50551': [30, null], [`anchor:${FP_A.slice(0, 8)}`]: [10, null] };
    let p = probeAll([p0], 'api');
    await jest.advanceTimersByTimeAsync(2000);
    let r = await p;
    expect(r.ok[0].route).toEqual({ host: '203.0.113.5', port: 50551, via: 'mapped' });
    expect(reachedBy(r.ok[0])).toBe('internet');
    expect(roadArgs(r.ok[0])).toEqual({ host: '203.0.113.5', port: 50551, anchor: null });
    mockNative.roads['192.168.1.20:50551'] = [5, null];
    p = probeAll([r.ok[0]], 'api');
    await jest.advanceTimersByTimeAsync(2000);
    r = await p;
    expect(r.ok[0].route).toBeNull();
    expect(reachedBy(r.ok[0])).toBe('wifi');
  });
  it('only the hosted relay stays out of split', async () => {
    const far = peer({ id: 'far', relay: { url: 'wss://relay.example', code: '123456' } });
    const r = await probeAll([far], 'rpc');
    expect(r.bad).toEqual([{ peer: far, why: REMOTE_NO_SPLIT }]);
    expect(mockNative.probes).toEqual([]);
  });
  it('a device that answers nowhere says why the first road failed', async () => {
    mockNative.roads = { '192.168.1.20:50551': [10, 'connect timed out'] };
    const p = probeAll([peer({ anchors: [{ fp: FP_A, host: '198.51.100.7', port: 50551 }] })], 'rpc');
    await jest.advanceTimersByTimeAsync(2000);
    expect((await p).bad[0].why).toBe('connect timed out');
  });
});

describe('the anchor’s invite', () => {
  const invite = { k: 'kula-peer', v: 3, id: 'id-berlin', name: 'Berlin Mac', host: '203.0.113.5', port: 50551, addrs: [{ host: '203.0.113.5', port: 50551, via: 'mapped' }, { host: '2001:db8::5', port: 50551, via: 'ipv6' }], anchor: true, fp: FP_A, pin: '0123456789abcdef', hpin: 'fedcba9876543210', kind: 'pc', ram: null, bw: null };

  it('reads the qr json and the pasteable base64url line alike', () => {
    for (const text of [JSON.stringify(invite), b64url(JSON.stringify(invite))]) {
      expect(isPeerQr(text)).toBe(true);
      expect(isInvite(text)).toBe(true);
      const inv = parseInvite(text)!;
      expect(inv).toEqual(expect.objectContaining({ fp: FP_A, fpPrefix: null, pin: '0123456789abcdef', hpin: 'fedcba9876543210', name: 'Berlin Mac' }));
      expect(inv.ways).toEqual([{ host: '203.0.113.5', port: 50551, via: 'mapped' }, { host: '2001:db8::5', port: 50551, via: 'ipv6' }]);
      expect(inv.peer.pin).toBeNull();
    }
  });
  it('reads the typed form: address, code, the certificate’s start (16 hex or more)', () => {
    const inv = parseInvite('203.0.113.5:50551 0123456789abcdef A1A1A1A1A1A1A1A1')!;
    expect(inv).toEqual(expect.objectContaining({ fp: '', fpPrefix: 'a1a1a1a1a1a1a1a1', pin: '0123456789abcdef', hpin: null }));
    expect(inv.ways).toEqual([{ host: '203.0.113.5', port: 50551, via: 'mapped' }]);
    expect(parseInvite('[2001:db8::5]:50551, 0123456789abcdef, a1a1a1a1a1a1a1a1a1')!.ways[0]).toEqual({ host: '2001:db8::5', port: 50551, via: 'ipv6' });
    // too short a certificate start is not an invite (15 hex)
    expect(isInvite('203.0.113.5:50551 0123456789abcdef a1a1a1a1a1a1a1a')).toBe(false);
    // a relay code is not an invite
    expect(isInvite('123456 0123456789abcdef')).toBe(false);
  });
  it('a plain device code is no invite, and an invite is never taken as a plain pairing', () => {
    const plain = { ...invite, anchor: undefined, hpin: undefined };
    expect(isInvite(JSON.stringify(plain))).toBe(false);
    expect(() => takePeerQr(JSON.stringify(invite))).toThrow('invite');
    expect(peers()).toEqual([]);
  });
  it('reads a device’s addrs and anchors from its code and keeps them', () => {
    const code = { k: 'kula-peer', v: 3, id: 'mac', name: 'mac', host: '192.168.1.20', port: 50551, fp: FP_B, pin: null, kind: 'pc', addrs: [{ host: '203.0.113.5', port: 50551, via: 'mapped' }, { host: 'example.com', port: 1, via: 'mapped' }], anchors: [{ fp: FP_A, host: '198.51.100.7', port: 50551, name: 'berlin' }, { fp: 'xyz', host: '1.2.3.4', port: 1 }] };
    const p = takePeerQr(JSON.stringify(code));
    expect(p.addrs).toEqual([{ host: '203.0.113.5', port: 50551, via: 'mapped' }]);
    expect(p.anchors).toEqual([{ fp: FP_A, host: '198.51.100.7', port: 50551, name: 'berlin' }]);
    expect(peers()[0].anchors).toEqual(p.anchors);
    // a v2 code (the shared secret) never carries roads: an anchor needs a pinned certificate
    const v2 = parsePeerQr(JSON.stringify({ ...code, v: 2, secret: 'a'.repeat(64), fp: undefined }));
    expect(v2.addrs).toBeUndefined();
    expect(v2.anchors).toBeUndefined();
  });
  it('joins natively and keeps the anchor as a pinned, paired peer reached at the address that answered', async () => {
    mockNative.joinAnswer = { fp: FP_A, name: 'Berlin Mac', host: '2001:db8::5', port: 50551, via: 'ipv6', again: false, sharing: false };
    const r = await joinInvite(JSON.stringify(invite), 'mine');
    expect(mockNative.joins).toEqual([{ fp: FP_A, fpPrefix: null, pin: '0123456789abcdef', hpin: 'fedcba9876543210', name: 'Berlin Mac', ways: invite.addrs, whose: 'mine' }]);
    expect(r).toEqual(expect.objectContaining({ name: 'Berlin Mac', again: false, sharing: false }));
    const kept = peers()[0];
    expect(kept).toEqual(expect.objectContaining({ id: 'id-berlin', fp: FP_A, pin: null, anchor: true, kind: 'pc', route: { host: '2001:db8::5', port: 50551, via: 'ipv6' } }));
    expect(kept.paired_at).toBeTruthy();
  });
  it('a typed invite joins with the certificate start and learns the full certificate', async () => {
    mockNative.joinAnswer = { fp: FP_A, name: 'anchor a1a1a1a1', host: '203.0.113.5', port: 50551, via: 'mapped', again: false, sharing: true };
    await joinInvite('203.0.113.5:50551 0123456789abcdef a1a1a1a1a1a1a1a1', 'friend');
    expect(mockNative.joins[0]).toEqual(expect.objectContaining({ fp: '', fpPrefix: 'a1a1a1a1a1a1a1a1', hpin: null, whose: 'friend' }));
    expect(peers()[0]).toEqual(expect.objectContaining({ fp: FP_A, anchor: true, host: '203.0.113.5' }));
    expect(peers()[0].route).toBeUndefined(); // it answered at its first address: no route kept
  });
  it('the anchor’s refusal comes back in its plain words, nothing is kept', async () => {
    await expect(joinInvite(JSON.stringify(invite), 'friend')).rejects.toThrow('this invite was used already');
    expect(peers()).toEqual([]);
  });
  it('forgetting an anchor’s row leaves it natively, which takes its computer’s access (D4 #16)', async () => {
    mockNative.joinAnswer = { fp: FP_A, name: 'Berlin Mac', host: '2001:db8::5', port: 50551, via: 'ipv6', again: false, sharing: false };
    const { peer: anchor } = await joinInvite(JSON.stringify(invite), 'friend');
    rememberPeer(peer());
    // leaving fails natively: the row stays, so the person can try again
    mockNative.forgetFails = true;
    await expect(forgetPeerRow(anchor)).rejects.toThrow('no store');
    expect(peers().map((p) => p.id)).toContain(anchor.id);
    mockNative.forgetFails = false;
    await forgetPeerRow(anchor);
    expect(mockNative.forgets).toEqual([FP_A]);
    expect(peers().map((p) => p.id)).toEqual(['b']);
    // a device that is not an anchor is only forgotten here: its access is its own row's business
    await forgetPeerRow(peers()[0]);
    expect(mockNative.forgets).toEqual([FP_A]);
    expect(peers()).toEqual([]);
  });
});

describe('stored roads', () => {
  it('are healed like everything stored: good ones kept, bad ones dropped', () => {
    const raw = [{
      id: 'b', name: 'b', host: '192.168.1.20', port: 50551, secret: '', fp: FP_B, kind: 'pc', ram: null, bw: null, added_at: '',
      addrs: [{ host: '203.0.113.5', port: 50551, via: 'mapped' }, { host: 'evil.example', port: 1, via: 'mapped' }],
      anchors: [{ fp: FP_A, host: '198.51.100.7', port: 50551 }],
      anchor: 'yes',
      route: { via: 'anchor', anchor: FP_A, host: '198.51.100.7', port: 50551, name: 'berlin' },
    }, { id: 'c', name: 'c', host: '10.0.0.3', port: 1, secret: '', kind: 'phone', ram: null, bw: null, added_at: '', route: { via: 'anchor', anchor: 'nothex', host: '1.2.3.4', port: 1 } }];
    const [b, c] = healPeers(raw);
    expect(b.addrs).toEqual([{ host: '203.0.113.5', port: 50551, via: 'mapped' }]);
    expect(b.anchors).toEqual([{ fp: FP_A, host: '198.51.100.7', port: 50551 }]);
    expect(b.anchor).toBeUndefined();
    expect(b.route).toEqual({ via: 'anchor', anchor: FP_A, host: '198.51.100.7', port: 50551, name: 'berlin' });
    expect(c.route).toBeUndefined();
    expect(cleanRoad({ host: '203.0.113.5', port: 70000, via: 'mapped' })).toBeNull();
  });
  it('decodes a base64url line with any letters in it', () => {
    expect(fromBase64Url(b64url('{"name":"çapa Ünal 東京"}'))).toBe('{"name":"çapa Ünal 東京"}');
    expect(fromBase64Url('not base64!')).toBeNull();
  });
});
