// beyin-net (docs/BEYIN-NET.md): twenty homes in four time zones over three days, run hour by hour
// with nothing but the pure functions of node/src/godseye/net and real ed25519 receipts. Thirteen
// homes are honest, four lazy (they lend one phone of three and drop half of what they take, and
// ask three times as much), two cheat from the start and one sleeps: honest for its first pieces, then it
// cheats. Homes ask for three days; a fourth day lets the last asks settle.
// Every home's brain keeps its own book; nobody sees the whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';

const net = await import('../src/godseye/net/index.ts');
type NetT = typeof import('../src/godseye/net/index.ts');
type Ring = import('../src/godseye/net/index.ts').Ring;
type Piece = import('../src/godseye/net/index.ts').Piece;
type Task = import('../src/godseye/net/index.ts').Task;
type Grant = import('../src/godseye/net/index.ts').Grant;
type Rep = import('../src/godseye/net/index.ts').Rep;
type Answer = import('../src/godseye/net/index.ts').Answer;
type ReceiptBody = import('../src/godseye/net/index.ts').ReceiptBody;
type Gave = import('../src/godseye/net/index.ts').Gave;

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 9, 0, 0, 0);
const DAYS = 3;                      // days on which homes ask
const RUN = DAYS + 1;                // and one more without new asks, so what was asked can settle
const HOMES = 20;
const ZONES = [0, 6, 12, 18];        // hours ahead of UTC; each zone's night (00–06 local) is a quarter of the day
const NIGHT = 6;
const PIECES = 50;                   // per project
const RATE = 50;                     // units per device per hour
const FRIEND_LIMIT = 100;
const CHEAT_RATE = 0.4;
const SLEEP_FOR = 12;                // pieces the sleeper does honestly first

type Kind = 'honest' | 'lazy' | 'cheat' | 'sleeper';
// placed so that every honest home keeps at least two honest friends (one lazy home per zone)
const KIND: Record<number, Kind> = { 3: 'cheat', 14: 'cheat', 9: 'sleeper', 1: 'lazy', 6: 'lazy', 12: 'lazy', 15: 'lazy' };
const OFFER_RING: Record<number, Ring> = { 2: 'circle', 7: 'circle' };   // two homes lend to friends only

interface Dev { id: string; home: string; maxB: number; signer: { id: string; sign(t: string): string }; done: number; wrong: number }
interface Home { id: string; n: number; zone: number; offset: number; kind: Kind; devs: Dev[]; signer: { id: string; sign(t: string): string } }
interface PState { piece: Piece; posted: number; want: number; answers: Answer[]; copies: number; done: boolean; digest?: string; at?: number }
interface Out { grant: Grant; canary: string | null; real: Piece; ran: boolean }
interface Accepted { piece: string; device: string; checked: boolean; at: number; hash: string; body: ReceiptBody }

const pad = (n: number) => String(n).padStart(2, '0');

function simulate() {
  const pubs: Record<string, KeyObject> = {};
  const keyed = (id: string) => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    pubs[id] = publicKey;
    return { id, sign: (t: string) => sign(null, Buffer.from(t), privateKey).toString('base64') };
  };
  const homes: Home[] = [];
  for (let i = 0; i < HOMES; i++) {
    const id = `h${pad(i)}`;
    const devs = [8, 8, 4].map((maxB, k) => ({ id: `${id}d${k}`, home: id, maxB, signer: keyed(`${id}d${k}`), done: 0, wrong: 0 }));
    homes.push({ id, n: i, zone: i % 4, offset: ZONES[i % 4], kind: KIND[i] ?? 'honest', devs, signer: keyed(id) });
  }
  const H = Object.fromEntries(homes.map((h) => [h.id, h]));
  const D = Object.fromEntries(homes.flatMap((h) => h.devs.map((d) => [d.id, d] as [string, Dev])));
  // friendships: each home with the next one and the one five on, both ways (across time zones)
  const trust = homes.flatMap((h) => [1, 5].flatMap((k) => {
    const o = homes[(h.n + k) % HOMES].id;
    return [{ from: h.id, to: o, limit: FRIEND_LIMIT }, { from: o, to: h.id, limit: FRIEND_LIMIT }];
  }));
  const trusts = (x: string, y: string) => trust.some((t) => t.from === x && t.to === y);
  const rel = (x: string, y: string): Ring => (x === y ? 'home' : trusts(x, y) ? 'circle' : 'world');
  const verifyFn = (id: string, text: string, sig: string) => !!pubs[id] && verify(null, Buffer.from(text), pubs[id], Buffer.from(sig, 'base64'));

  const books: Record<string, Record<string, Rep>> = Object.fromEntries(homes.map((h) => [h.id, {}]));
  const pieces = new Map<string, PState>();
  let open: Task[] = [];
  let out: Out[] = [];
  const accepted: Record<string, Accepted[]> = Object.fromEntries(homes.map((h) => [h.id, []]));
  const receipts: { line: string; body: ReceiptBody; hash: string }[] = [];
  const revoked = new Set<string>();
  const gave: Gave = {};
  const pending: Record<string, Record<string, number>> = {};
  const add = (g: Record<string, Record<string, number>>, x: string, y: string, u: number) => { g[x] ??= {}; g[x][y] = (g[x][y] ?? 0) + u; };

  const m = {
    leaks: 0, homeOut: 0, circleOut: 0, ran: 0, ranCross: 0, ranDay: 0,
    canaries: 0, checks: 0, tiebreaks: 0, late: 0, recalled: 0, expired: { home: 0, circle: 0, world: 0 } as Record<Ring, number>,
    catches: [] as { device: string; by: string; at: number; done: number; wrong: number; why: string }[],
    afterCaught: 0, byZoneHour: Array.from({ length: 24 }, () => [0, 0, 0, 0]),
    asked: {} as Record<string, number>, lost: {} as Record<string, number>, completed: {} as Record<string, number>,
    latency: { home: [] as number[], circle: [] as number[], world: [] as number[] },
  };
  const firstCaught = new Map<string, number>();       // device → when its first home caught it
  const caughtBy = new Map<string, Set<string>>();     // device → homes that banned it first-hand
  const catchAt = new Map<string, number>();           // "device|home" → when that home caught it

  const truth = (pid: string) => `ok:${pid}`;
  const localHour = (h: Home, t: number) => (((t - T0) / HOUR + h.offset) % 24 + 24) % 24;

  function receipt(g: Grant, pid: string, copy: number, digest: string, checked: boolean, now: number, p: Piece) {
    const body: ReceiptBody = {
      v: 1, kind: 'receipt', t: now, job: p.job, piece: pid, copy, units: g.units, model: p.model, ring: p.ring, result: digest,
      device: g.device, giver: g.home, taker: g.asker, via: g.path.slice(1, -1), gift: g.gift, checked,
    };
    const line = net.countersign(net.signGiver(body, D[g.device].signer), H[g.asker].signer);
    const hash = createHash('sha256').update(line).digest('hex');
    receipts.push({ line, body, hash });
    const path = g.path.length ? g.path : [g.home, g.asker];
    for (let i = 0; i + 1 < path.length; i++) add(gave, path[i], path[i + 1], g.units);
    return { hash, body };
  }

  function caught(asker: string, device: string, why: string, now: number) {
    const d = D[device];
    m.catches.push({ device, by: asker, at: now, done: d.done, wrong: d.wrong, why });
    if (!firstCaught.has(device)) firstCaught.set(device, now);
    if (!caughtBy.has(device)) caughtBy.set(device, new Set());
    caughtBy.get(device)!.add(asker);
    catchAt.set(`${device}|${asker}`, now);
    // what it gave this home unchecked runs again; those receipts are taken back
    for (const a of net.recall(accepted[asker], device)) {
      revoked.add(a.hash);
      const path = [a.body.giver, ...a.body.via, a.body.taker];
      for (let i = 0; i + 1 < path.length; i++) add(gave, path[i], path[i + 1], -a.body.units);
      const ps = pieces.get(a.piece)!;
      ps.done = false; ps.digest = undefined; ps.answers = []; ps.want = 1;
      ps.piece = { ...ps.piece, deadline: Math.max(ps.piece.deadline, now + 12 * HOUR) };
      open.push({ piece: ps.piece, copy: ps.copies++, exclude: [d.home], avoid: [] });
      m.recalled++;
    }
    accepted[asker] = accepted[asker].filter((a) => !(a.device === device && !a.checked));
    // friends hear of it, with the proof
    for (const t of trust) if (t.from === asker) books[t.to][device] = net.observe(books[t.to][device], 'warned', now);
  }

  function judgeOutcomes(asker: string, outcomes: { device: string; outcome: import('../src/godseye/net/index.ts').Outcome }[], now: number) {
    for (const o of outcomes) {
      if (D[o.device].home === asker) continue;
      const before = net.banned(books[asker][o.device], now);
      books[asker][o.device] = net.observe(books[asker][o.device], o.outcome, now);
      if (!before && net.banned(books[asker][o.device], now)) caught(asker, o.device, o.outcome, now);
    }
  }

  for (let hour = 0; hour < RUN * 24; hour++) {
    const now = T0 + hour * HOUR;

    // 1. asks: each home thinks of a project at 09:00 local (lazy ones at 15:00 too), wants it in a day
    for (const h of homes) {
      const lh = localHour(h, now);
      if (!(lh === 9 || (h.kind === 'lazy' && (lh === 13 || lh === 17)))) continue;
      const day = Math.floor((hour + h.offset) / 24);
      if (hour >= DAYS * 24) continue;
      const kind = (['world', 'circle', 'private'] as const)[(h.n + day + (lh - 9) / 4) % 3];
      const job = `${h.id}-${day}-${lh}`;
      for (let k = 0; k < PIECES; k++) {
        const id = `${job}-${pad(k)}`;
        const c = net.coin('ring', id);
        const ring: Ring = kind === 'private' ? 'home' : kind === 'circle' ? (c < 0.3 ? 'home' : 'circle') : c < 0.1 ? 'home' : 'world';
        const modelB = net.coin('model', id) < 0.5 ? 8 : 3;
        const units = modelB * (1 + Math.floor(net.coin('len', id) * 2));
        const piece: Piece = { id, job, home: h.id, ring, modelB, model: `sha-${modelB}b`, units, deadline: now + 24 * HOUR };
        pieces.set(id, { piece, posted: now, want: 1, answers: [], copies: 1, done: false });
        open.push({ piece, copy: 0, exclude: [], avoid: [] });
        m.asked[h.id] = (m.asked[h.id] ?? 0) + 1;
      }
    }

    // 2. grants not answered by their due time: late; the copy goes back without that home
    for (const o of out.filter((o) => !o.ran && o.grant.due <= now)) {
      const g = o.grant;
      if (g.home !== g.asker) {
        books[g.asker][g.device] = net.observe(books[g.asker][g.device], 'late', now);
        add(pending, g.home, g.asker, -g.units);
      }
      m.late++;
      const ps = pieces.get(g.piece)!;
      if (!ps.done) open.push({ piece: ps.piece, copy: g.copy, exclude: [g.home], avoid: [] });
    }
    out = out.filter((o) => !(!o.ran && o.grant.due <= now));
    // 3. copies past their deadline are dropped
    for (const t of open) if (t.piece.deadline <= now && t.copy === 0 && !pieces.get(t.piece.id)!.done) { m.expired[t.piece.ring]++; m.lost[t.piece.home] = (m.lost[t.piece.home] ?? 0) + 1; }
    open = open.filter((t) => t.piece.deadline > now && !pieces.get(t.piece.id)!.done);

    // 4. each asker's own lists: devices it will not take, homes it no longer works with
    const avoid: Record<string, string[]> = {}, shut: Record<string, string[]> = {};
    for (const h of homes) {
      const bad = Object.entries(books[h.id]).filter(([, r]) => !net.usable(r, now)).map(([d]) => d);
      avoid[h.id] = bad;
      shut[h.id] = [...new Set(Object.entries(books[h.id]).filter(([, r]) => net.banned(r, now)).map(([d]) => D[d].home))];
    }

    // 5. offers from the homes whose night it is; each giving brain matches what it heard
    const offerOf = (h: Home, devs: Dev[], ring: Ring, tag: string) => ({
      v: 1 as const, type: 'offer' as const, id: `${h.id}@${hour}${tag}`, home: h.id, at: now, from: now, to: now + HOUR, ring, gift: 0.2,
      devices: devs.map((d) => ({ id: d.id, maxB: d.maxB, rate: RATE, units: RATE })),
    });
    // a lazy home lends one phone; its other two only do its own work
    const offers = homes.filter((h) => localHour(h, now) < NIGHT)
      .flatMap((h) => h.kind === 'lazy'
        ? [offerOf(h, h.devs.slice(1), 'home', 'h'), offerOf(h, h.devs.slice(0, 1), 'world', '')]
        : [offerOf(h, h.devs, OFFER_RING[h.n] ?? 'world', '')])
      .sort((a, b) => net.coin(hour, a.id) - net.coin(hour, b.id));
    const fresh: Out[] = [];
    for (const offer of offers) {
      const askers = [...new Set(open.map((t) => t.piece.home))];
      const view = {
        rel: Object.fromEntries(askers.map((a) => [a, rel(offer.home, a)])),
        back: Object.fromEntries(askers.map((a) => [a, rel(a, offer.home)])),
        room: Object.fromEntries(askers.map((a) => {
          const r = net.room(trust, gave, offer.home, a);
          return [a, { units: Math.max(0, r.units - (pending[offer.home]?.[a] ?? 0)), path: r.path }];
        })),
        balance: Object.fromEntries(askers.map((a) => [a, net.owed(gave, offer.home, a) + (pending[offer.home]?.[a] ?? 0)])),
        refuse: shut[offer.home],
      };
      const tasks = open.map((t) => ({ ...t, exclude: [...t.exclude, ...shut[t.piece.home]], avoid: avoid[t.piece.home] }));
      const grants = net.match(offer, tasks, view, now);
      for (const g of grants) {
        const i = open.findIndex((t) => t.piece.id === g.piece && t.copy === g.copy);
        const task = open[i];
        open.splice(i, 1);
        const p = task.piece;
        // the asker checks every grant again before a word of content goes
        if (!net.within(rel(p.home, g.home), p.ring)) m.leaks++;
        if (p.ring === 'home' && g.home !== p.home) m.homeOut++;
        if (p.ring === 'circle' && g.home !== p.home && !trusts(p.home, g.home)) m.circleOut++;
        let canary: string | null = null;
        if (g.home !== g.asker) {
          add(pending, g.home, g.asker, g.units);
          if (g.copy === 0) {
            const pl = net.plan(p.id, g.device, books[g.asker][g.device], now, 'sim');
            if (pl.canary) {
              // a known-answer piece goes in its place; the real one waits for the next grant
              canary = `${p.id}~c${hour}`;
              m.canaries++;
              open.push(task);
            } else if (pl.check) {
              const ps = pieces.get(p.id)!;
              ps.want = 2;
              open.push({ piece: p, copy: ps.copies++, exclude: [g.home], avoid: [] });
              m.checks++;
            }
          }
        }
        fresh.push({ grant: g, canary, real: p, ran: false });
      }
    }
    out.push(...fresh);

    // 6. the devices run what they were granted this hour and the askers judge what comes back
    for (const o of fresh) {
      const g = o.grant;
      const dev = D[g.device];
      const giver = H[g.home];
      const cross = g.home !== g.asker;
      const pid = o.canary ?? g.piece;
      if (cross && giver.kind === 'lazy' && net.coin('drop', pid, g.copy, g.device) < 0.5) continue;   // took it, never did it
      let right = true;
      if (cross && giver.kind === 'cheat') right = net.coin('cheat', pid, g.device) >= CHEAT_RATE;
      if (cross && giver.kind === 'sleeper' && dev.done >= SLEEP_FOR) right = net.coin('cheat', pid, g.device) >= 0.5;
      o.ran = true;
      m.ran++;
      if (cross) {
        dev.done++;
        if (!right) dev.wrong++;
        m.ranCross++;
        if (localHour(giver, now) >= NIGHT) m.ranDay++;
        m.byZoneHour[hour % 24][giver.zone] += g.units;
        add(pending, g.home, g.asker, -g.units);
        if ((catchAt.get(`${g.device}|${g.asker}`) ?? Infinity) < g.at) m.afterCaught++;
      }
      // the same wrong answer from every cheater: two of them on one piece would agree
      const digest = right ? truth(pid) : `bad:${pid}`;

      if (o.canary) {
        const j = net.judge([{ device: g.device, home: g.home, digest }], 1, truth(pid));
        if (j.state === 'accept') {
          judgeOutcomes(g.asker, j.outcomes, now);
          if (digest === truth(pid)) receipt(g, pid, g.copy, digest, true, now, o.real);
        }
        continue;
      }
      const ps = pieces.get(g.piece)!;
      if (ps.done) continue;
      ps.answers.push({ device: g.device, home: g.home, digest });
      let j = cross ? net.judge(ps.answers, ps.want) : net.judge(ps.answers, 1);
      if (j.state === 'tiebreak') {
        // the asker runs it on its own devices: the answer it trusts
        m.tiebreaks++;
        j = net.judge(ps.answers, ps.want, truth(g.piece));
      }
      if (j.state !== 'accept') continue;
      ps.done = true; ps.digest = j.digest; ps.at = now;
      open = open.filter((t) => t.piece.id !== g.piece);
      if (!cross) continue;
      judgeOutcomes(g.asker, j.outcomes, now);
      // receipts for every answer that was right (by the accepted digest)
      const grantsOf = [...out.filter((x) => x.grant.piece === g.piece && !x.canary && x.ran)];
      for (const a of ps.answers) {
        if (a.digest !== j.digest || a.home === g.asker) continue;
        const gr = grantsOf.find((x) => x.grant.device === a.device)?.grant ?? g;
        if (net.banned(books[g.asker][a.device], now)) continue;
        const r = receipt(gr, g.piece, gr.copy, a.digest, j.checked, now, ps.piece);
        accepted[g.asker].push({ piece: g.piece, device: a.device, checked: j.checked, at: now, hash: r.hash, body: r.body });
      }
    }
    out = out.filter((o) => !o.ran);
  }

  // what each home got done, and how fast
  for (const ps of pieces.values()) {
    if (!ps.done) continue;
    m.completed[ps.piece.home] = (m.completed[ps.piece.home] ?? 0) + 1;
    m.latency[ps.piece.ring].push((ps.at! - ps.posted) / HOUR);
  }
  return { homes, H, D, m, receipts, revoked, gave, pieces, books, verifyFn, firstCaught, caughtBy, trust };
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const S = simulate();
const { m } = S;
const live = S.receipts.filter((r) => !S.revoked.has(r.hash));
const given = (h: string) => live.filter((r) => r.body.giver === h && r.body.taker !== h).reduce((s, r) => s + r.body.units, 0);
const got = (h: string) => live.filter((r) => r.body.taker === h && r.body.giver !== h).reduce((s, r) => s + r.body.units, 0);
const byKind = (k: string) => S.homes.filter((h) => h.kind === k);

test('sim: the numbers', (t) => {
  const done = [...S.pieces.values()].filter((p) => p.done).length;
  const rows = S.homes.map((h) => `${h.id} ${h.kind.padEnd(7)} gave ${String(given(h.id)).padStart(5)} got ${String(got(h.id)).padStart(5)} done ${m.completed[h.id] ?? 0}/${m.asked[h.id]} lost ${m.lost[h.id] ?? 0}`);
  t.diagnostic(`pieces ${S.pieces.size}, done ${done}, ran ${m.ran} (${m.ranCross} for other homes), canaries ${m.canaries}, checked twice ${m.checks}, home re-runs ${m.tiebreaks}, late ${m.late}, recalled ${m.recalled}, expired ${JSON.stringify(m.expired)}`);
  t.diagnostic(`receipts ${S.receipts.length}, revoked ${S.revoked.size}; median hours to done: world ${median(m.latency.world)}, circle ${median(m.latency.circle)}, home ${median(m.latency.home)}`);
  const wrong = [...S.pieces.values()].filter((p) => p.done && p.digest !== `ok:${p.piece.id}`).length;
  const sum = (hs: { id: string }[], f: (h: string) => number) => hs.reduce((s, h) => s + f(h.id), 0);
  const share = (hs: { id: string }[]) => (sum(hs, (h) => m.completed[h] ?? 0) / sum(hs, (h) => m.asked[h])).toFixed(2);
  t.diagnostic(`wrong answers accepted at the end ${wrong}; honest homes gave ${sum(byKind('honest'), given)} got ${sum(byKind('honest'), got)}; done of asked: honest ${share(byKind('honest'))}, lazy ${share(byKind('lazy'))}, cheating ${share([...byKind('cheat'), ...byKind('sleeper')])}`);
  for (const d of Object.values(S.D).filter((d) => S.H[d.home].kind === 'cheat' || S.H[d.home].kind === 'sleeper')) {
    const c = m.catches.find((x) => x.device === d.id);
    t.diagnostic(`${d.id} first caught after ${c?.done} pieces (${c?.wrong} wrong); stopped by ${S.caughtBy.get(d.id)?.size ?? 0} homes first-hand; ran ${d.done} in all`);
  }
  for (const c of m.catches) t.diagnostic(`caught ${c.device} (${S.H[S.D[c.device].home].kind}) by ${c.by} ${c.why} after ${c.done} pieces, ${c.wrong} wrong`);
  for (const r of rows) t.diagnostic(r);
});

test('sim: no private piece ever leaves home, no circle piece goes past a friend', () => {
  assert.equal(m.leaks, 0);
  assert.equal(m.homeOut, 0);
  assert.equal(m.circleOut, 0);
  for (const r of S.receipts) {
    if (r.body.ring === 'home') assert.equal(r.body.giver, r.body.taker);
    if (r.body.ring === 'circle') assert.ok(S.trust.some((t) => t.from === r.body.taker && t.to === r.body.giver));
  }
  // and an honest home's private work still gets done, at home, in its own night
  for (const p of S.pieces.values()) if (p.piece.ring === 'home' && S.H[p.piece.home].kind === 'honest') assert.ok(p.done, p.piece.id);
});

test('sim: every receipt holds both signatures, and the balances are nothing but the receipts', () => {
  for (const r of S.receipts) assert.ok(net.checkReceipt(r.line, S.verifyFn).ok);
  const fromReceipts = net.tally(S.receipts.map((r) => ({ body: r.body, hash: r.hash })), S.revoked);
  for (const x of Object.keys({ ...fromReceipts, ...S.gave })) for (const y of Object.keys({ ...fromReceipts[x], ...S.gave[x] })) {
    assert.equal(fromReceipts[x]?.[y] ?? 0, S.gave[x]?.[y] ?? 0, `${x}→${y}`);
  }
});

const CATCH_WITHIN = 15;     // pieces a cheater runs for others before its first home stops it

test(`sim: cheaters are caught within ${CATCH_WITHIN} pieces, lose their standing, and their wrong answers do not stay`, () => {
  for (const h of [...byKind('cheat'), ...byKind('sleeper')]) {
    for (const d of h.devs) {
      if (d.done === 0) continue;
      const first = m.catches.find((c) => c.device === d.id);
      assert.ok(first, `${d.id} was never caught (${d.done} pieces, ${d.wrong} wrong)`);
      const turned = h.kind === 'sleeper' ? SLEEP_FOR : 0;
      assert.ok(first.done - turned <= CATCH_WITHIN, `${d.id} caught after ${first.done} pieces`);
      // the homes that caught it, and their friends who heard, no longer take work from it
      const end = T0 + RUN * 24 * HOUR;
      const knew = new Set([...S.caughtBy.get(d.id)!].flatMap((c) => [c, ...S.trust.filter((t) => t.from === c).map((t) => t.to)]));
      for (const home of knew) if (home !== h.id) assert.ok(!net.usable(S.books[home][d.id], end), `${d.id} still used by ${home}`);
    }
  }
  assert.equal(m.afterCaught, 0, 'a home that caught a device granted it nothing after');
  // honest devices are never caught
  for (const c of m.catches) assert.notEqual(S.H[S.D[c.device].home].kind, 'honest');
  // wrong answers that were accepted and not taken back
  const wrong = [...S.pieces.values()].filter((p) => p.done && p.digest !== `ok:${p.piece.id}`).length;
  const done = [...S.pieces.values()].filter((p) => p.done && p.piece.ring !== 'home').length;
  assert.ok(wrong <= 0.01 * done, `${wrong} wrong of ${done}`);
});

test('sim: honest homes get back roughly what they give; lazy homes get less of what they ask', () => {
  for (const h of byKind('honest')) {
    const ratio = got(h.id) / Math.max(1, given(h.id));
    assert.ok(ratio > 0.5 && ratio < 2, `${h.id} gave ${given(h.id)} got ${got(h.id)}`);
  }
  const share = (hs: { id: string }[]) => hs.reduce((s, h) => s + (m.completed[h.id] ?? 0), 0) / hs.reduce((s, h) => s + m.asked[h.id], 0);
  assert.ok(share(byKind('honest')) > share(byKind('lazy')) + 0.1, `honest ${share(byKind('honest'))} lazy ${share(byKind('lazy'))}`);
  // what a lazy home takes beyond what it gives is bounded by the trust its friends gave it and a
  // gift cap per stranger, whatever it asks
  for (const h of byKind('lazy')) {
    const trusted = S.trust.filter((t) => t.to === h.id).reduce((s, t) => s + t.limit, 0);
    const bound = trusted + net.GIFT_CAP * (HOMES - 1);
    assert.ok(got(h.id) - given(h.id) <= bound, `${h.id} gave ${given(h.id)} got ${got(h.id)}, bound ${bound}`);
  }
});

test('sim: the night follows the sun', () => {
  assert.equal(m.ranDay, 0, 'other homes work only runs in the giver’s night');
  // in every hour of the day the work for others comes from the zone whose night it is
  for (let hr = 0; hr < 24; hr++) {
    const row = m.byZoneHour[hr];
    const z = row.indexOf(Math.max(...row));
    assert.equal((hr + ZONES[z]) % 24 < NIGHT, true, `at ${hr}:00 UTC zone ${z} worked most`);
    assert.ok(row[z] > 0, `nobody worked at ${hr}:00 UTC`);
  }
  // a project thought of at 09:00 is done by others' nights long before the home's own night (15 h away)
  assert.ok(median(m.latency.world) < 10, `world pieces median ${median(m.latency.world)} h`);
  assert.ok(median(m.latency.home) >= 15, `home pieces median ${median(m.latency.home)} h`);
});
