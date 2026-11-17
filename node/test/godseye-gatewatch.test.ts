// the gate watch (16.11.2026, P4): this computer's own gate (host.gate, from its own signed ledger)
// in the trust branch. Scanners are counted, not alarmed; a burst of far refusals against the usual
// of that hour of day is a card, never a red check; the rpc guard and 5+ guesses are; a device's own
// rpc guard is a card that never bars it; the anchor's daily cap (per friend's device: memberMaxDay
// only, no card without it) has a card with a 0.95 hold; a new far level refits the burst. A look
// without host.gate makes the same report as before, and the fit (`~gate`) survives a reload.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { create } = await import('../src/godseye/branches/trust.ts');
const { classOf, GATE_KEY, BACKSTOP, hoursOf, gateStep, freshGate } = await import('../src/godseye/branches/gatewatch.ts');
const { untrusted } = await import('../src/godseye/branches/decide.ts');
const { nodeKeys } = await import('../src/godseye/node.ts');
const { generate, publicKeyDer } = await import('../src/audit/key.ts');
const { makeLine, GENESIS, sha256Hex } = await import('../src/audit/ledger.ts');
const { selfSigned, newP256 } = await import('../src/tls.ts');

const H = 3_600_000;
const T0 = Math.floor(1.7e12 / H) * H;     // a running hour's start

/** the gate as the feed hands it at the running hour `run`: 26 hours, the last running */
function gateAt(run: number, farOf: (start: number) => number, o: { by?: (start: number) => Record<string, number>; guard?: { t: number; why: string }[]; nets?: number } = {}) {
  const hours = [];
  for (let i = 25; i >= 0; i--) {
    const start = run - i * H;
    const far = farOf(start);
    hours.push({ start, by: o.by ? o.by(start) : far > 0 ? { 'no hello': far } : {}, far });
  }
  return { hours, nets: o.nets ?? 3, guard: o.guard ?? [] };
}
const plainDev = (id = 'p9') => ({ id, name: id, kind: 'phone', via: 'wifi', where: 'x', reachable: true, reachMs: 1, reason: null, checkedAt: 1, lastOk: null, ramMb: 1000, bwGBs: 10, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, trust: null });
const snap = (devices: any[], host: Record<string, unknown> = {}, at = 5_000) => ({
  at, host: { name: 'mac', freeMb: 4000, ledger: { ok: true, count: 3, problem: null }, ...host }, devices,
  work: { loaded: null, loading: null, chatting: 0, plan: [], decisions: [], llama: true }, models: [], projects: [],
});
function branch(initial: unknown = {}) {
  let notes: unknown = structuredClone(initial);
  const events: string[] = [];
  const b = create({ now: () => 9_000, load: <T>(f: T) => (structuredClone(notes) as T) ?? f, save: (x: unknown) => { notes = structuredClone(x); }, emit: (t: string) => events.push(t), peek: () => null, keys: nodeKeys });
  return { b, events, notes: () => notes as any };
}
const gateCheckOf = (v: any) => v.report.host.checks.find((c: any) => c.k === 'gate');
const card = (v: any, id: string) => (v.suggestions ?? []).find((c: any) => c.id === id);
const quiet = (start: number) => 2 + ((start / H) % 3);   // 2, 3, 4 scanner knocks an hour

// a real device whose trust answer holds (as in the trust tests)
function device() {
  const key = generate();
  const certDer = selfSigned(newP256(), key.id);
  const lines: string[] = [];
  let prev = GENESIS;
  for (let t = 1_000; t < 1_003; t++) {
    const { line } = makeLine(key, t, 'connect', '192.168.1.5', {}, prev);
    lines.push(line);
    prev = sha256Hex(line);
  }
  return { key, certDer, lines };
}
const trustOf = (d: ReturnType<typeof device>, o: Record<string, unknown> = {}) => ({
  at: 1_000_000_000, error: null, id: d.key.id, alg: d.key.alg, pub: publicKeyDer(d.key.publicKey).toString('base64'), store: 'keystore',
  cert: d.certDer.toString('base64'), certPinned: true, v1: false, paired: 1, self: 'ok', count: d.lines.length,
  head: sha256Hex(d.lines.at(-1)!), lines: [...d.lines], restartedAt: null, rejectsDay: {}, rejectsLast: [], ...o,
});
const eyeDev = (trust: unknown, o: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'pixel', kind: 'phone', via: 'wifi', where: '192.168.1.33:50551', reachable: true, reachMs: 12, reason: null,
  checkedAt: 1, lastOk: null, ramMb: 3400, bwGBs: 60, gpu: null, tls: true, waitingPair: false, plugged: null, holds: null, trust, ...o,
});

test('the class table: strangers, guesses, the guard, the rest', () => {
  for (const w of ['no hello', 'bad hello', 'tls', 'no tls', 'not paired', 'overloaded', 'bad channel', 'bad nonce', 'no client cert', 'no v1', 'pin expired']) assert.equal(classOf(w), 'stranger', w);
  for (const w of ['wrong pin', 'wrong secret', 'bad proof']) assert.equal(classOf(w), 'guess', w);
  for (const w of ['rpc guard', 'rpc guard: op 12 (set tensor graph)', 'rpc guard: too big']) assert.equal(classOf(w), 'guard', w);
  for (const w of ['replay', 'something new', 'rpc', 'guard']) assert.equal(classOf(w), 'other', w);
});

test('30 quiet days of scanners, then an hour of 60: the burst card, a calm check, the verdict not bad', () => {
  const { b, events } = branch();
  const start = T0 - 30 * 24 * H;
  for (let run = start; run < T0; run += H) b.observe(snap([plainDev()], { gate: gateAt(run, quiet) }) as any, null);
  let v = b.view() as any;
  assert.equal(card(v, 'trust:gate-burst'), undefined, 'quiet days: no card');
  const calm = gateCheckOf(v);
  assert.equal(calm.ok, true);
  assert.match(calm.text, /^its gate refused \d+ strangers today \(no hello ×\d+\) from about 3 networks: scanners find every open port; none got in$/);
  assert.equal(events.length, 0, 'scanners make no feed line');

  // the running hour holds 60 far refusals
  b.observe(snap([plainDev()], { gate: gateAt(T0, (s) => (s === T0 ? 60 : quiet(s))) }) as any, null);
  v = b.view() as any;
  const c = card(v, 'trust:gate-burst');
  assert.ok(c, 'the burst card shows');
  assert.equal(c.weight, 2);
  assert.equal(c.title, "more knocking on this computer's gate than usual");
  assert.match(c.why, /^60 knocks from outside the lan in the last hour, usually about [23]\.\d at this hour of day; all refused\. scanners knock on every open port; none got in\.$/);
  assert.deepEqual(c.action, { do: 'open', panel: 'branch', branch: 'trust' });
  assert.equal(gateCheckOf(v).ok, true, 'the check stays calm');
  assert.notEqual(v.report.verdict, 'bad');
  assert.equal(events.length, 1, 'one feed line when the card comes');
  assert.match(events[0], /^more knocking on this computer's gate than usual: 60 /);

  // the hour finishes: the card stays (the last finished hour was a burst), no new line
  b.observe(snap([plainDev()], { gate: gateAt(T0 + H, (s) => (s === T0 ? 60 : quiet(s))) }) as any, null);
  v = b.view() as any;
  assert.match(card(v, 'trust:gate-burst').why, /^60 knocks from outside the lan in the last finished hour, usually about [23]\.\d at that hour of day/);
  assert.equal(events.length, 1);
  // a quiet hour finishes: gone, one line
  b.observe(snap([plainDev()], { gate: gateAt(T0 + 2 * H, (s) => (s === T0 ? 60 : quiet(s))) }) as any, null);
  v = b.view() as any;
  assert.equal(card(v, 'trust:gate-burst'), undefined);
  assert.deepEqual(events.slice(1), ["the knocking on this computer's gate is back to its usual"]);
});

test('14 days of no far knock, then 60 days at 5 an hour (the gate opened to the internet): a new level, the burst card off within 72 hours', () => {
  const { b, events } = branch();
  const change = T0 - 60 * 24 * H;
  const far = (s: number) => (s >= change ? 5 : 0);
  let firstOn = Infinity;
  let lastOn = -Infinity;
  for (let run = change - 14 * 24 * H; run < T0; run += H) {
    b.observe(snap([plainDev()], { gate: gateAt(run, far) }) as any, null);
    if (card(b.view(), 'trust:gate-burst')) { firstOn = Math.min(firstOn, run); lastOn = run; }
  }
  assert.equal(firstOn, change, 'the change shows at once');
  const stayed = (lastOn - change) / H + 1;
  assert.ok(lastOn < change + 72 * H, `the card stayed ${stayed} hours after the change (to ${(T0 - change) / H} hours shown)`);
  assert.equal(events.filter((e) => /a new level: learning what is usual again$/.test(e)).length, 1, 'one feed line for the new level');
  const v = b.view() as any;
  assert.equal(gateCheckOf(v).ok, true, 'the check stays calm');
  assert.doesNotMatch(gateCheckOf(v).text, /still learning/, 'the new level is learned');
});

test('14 days of no far knock, then one hour of 60: the card shows and stays for the finished hour, no new level', () => {
  const { b, events } = branch();
  const burst = T0;
  const far = (s: number) => (s === burst ? 60 : 0);
  for (let run = T0 - 14 * 24 * H; run < T0; run += H) b.observe(snap([plainDev()], { gate: gateAt(run, far) }) as any, null);
  assert.equal(card(b.view(), 'trust:gate-burst'), undefined, 'quiet days: no card');
  b.observe(snap([plainDev()], { gate: gateAt(T0, far) }) as any, null);
  assert.match(card(b.view(), 'trust:gate-burst')?.why ?? '', /^60 knocks from outside the lan in the last hour/, 'the running hour');
  b.observe(snap([plainDev()], { gate: gateAt(T0 + H, far) }) as any, null);
  assert.match(card(b.view(), 'trust:gate-burst')?.why ?? '', /^60 knocks from outside the lan in the last finished hour/, 'the finished hour still says it');
  b.observe(snap([plainDev()], { gate: gateAt(T0 + 2 * H, far) }) as any, null);
  assert.equal(card(b.view(), 'trust:gate-burst'), undefined, 'a quiet hour: gone');
  assert.equal(events.filter((e) => /a new level/.test(e)).length, 0, 'one loud hour is no new level');
  assert.doesNotMatch(gateCheckOf(b.view()).text, /still learning/, 'the fit was not started again');
});

test('while learning: no burst card, except the backstop of 1000 in the running hour', () => {
  const { b } = branch();
  b.observe(snap([plainDev()], { gate: gateAt(T0, (s) => (s === T0 ? 60 : 0)) }) as any, null);
  let v = b.view() as any;
  assert.equal(card(v, 'trust:gate-burst'), undefined, 'learning: 60 is no card');
  assert.match(gateCheckOf(v).text, /\(still learning what is usual: 25 of 24 hours\)|\(still learning what is usual at this hour of day\)/);
  const fresh = branch();
  fresh.b.observe(snap([plainDev()], { gate: gateAt(T0, (s) => (s === T0 ? 3 : 0)) }) as any, null);
  // 25 finished hours taken in at once; this hour of day has one hour of weight: still learning
  assert.match(gateCheckOf(fresh.b.view()).text, /still learning what is usual at this hour of day/);

  const one = branch();
  one.b.observe(snap([plainDev()], { gate: { hours: [{ start: T0, by: { 'no hello': 5 }, far: 5 }], nets: 1, guard: [] } }) as any, null);
  assert.match(gateCheckOf(one.b.view()).text, /\(still learning what is usual: 0 of 24 hours\)$/);

  b.observe(snap([plainDev()], { gate: gateAt(T0, (s) => (s === T0 ? BACKSTOP - 1 : 0)) }) as any, null);
  assert.equal(card(b.view(), 'trust:gate-burst'), undefined, '999: no card yet');
  b.observe(snap([plainDev()], { gate: gateAt(T0, (s) => (s === T0 ? BACKSTOP : 0)) }) as any, null);
  v = b.view() as any;
  const c = card(v, 'trust:gate-burst');
  assert.ok(c, 'the backstop shows while learning');
  assert.match(c.why, /^1000 knocks from outside the lan in the last hour, still learning what is usual; all refused\./);
  assert.equal(gateCheckOf(v).ok, true, 'still a calm check');
});

test('the rpc guard: the card at once, the check red, one feed line, gone after 26 hours', () => {
  const { b, events } = branch();
  const g = T0 - 3 * H;                      // the hour the guard cut something
  const why = 'rpc guard: op 12 (set tensor graph)';
  const look = (run: number) => b.observe(snap([plainDev()], {
    gate: gateAt(run, quiet, { by: (s) => (s === g ? { 'no hello': quiet(s), [why]: 1 } : { 'no hello': quiet(s) }), guard: [{ t: g + 600_000, why }] }),
  }) as any, null);
  look(T0);
  let v = b.view() as any;
  const c = card(v, 'trust:gate-guard');
  assert.ok(c);
  assert.equal(c.weight, 3);
  assert.equal(c.title, "this computer's gate cut a split connection (rpc guard)");
  assert.match(c.why, /^1 time in the last 26 hours, the last: rpc guard: op 12 \(set tensor graph\)\. a paired device sent a command that can carry code; it was dropped before llama\.cpp saw it\. kula versions that differ can do this by accident\.$/);
  const chk = gateCheckOf(v);
  assert.equal(chk.ok, false);
  assert.match(chk.text, /rpc guard ×1 in the last 26 hours\): rpc guard: op 12/);
  assert.equal(v.report.verdict, 'bad', 'the cluster verdict says look');
  assert.match(v.report.headline, /^this computer: its gate cut a split connection/);
  assert.equal(v.report.devices[0].verdict, 'unknown', 'no device turns');
  assert.equal(events.length, 1);
  assert.match(events[0], /^this computer's gate cut a split connection \(rpc guard\): rpc guard: op 12/);
  // it stays while the 26 hours hold it, without a new line
  let run = T0;
  for (; run - 25 * H <= g; run += H) {
    look(run);
    assert.ok(card(b.view(), 'trust:gate-guard'), `still held at ${(run - T0) / H} h`);
  }
  assert.equal(events.length, 1, 'one feed line while it stays');
  look(run);                                  // the guard hour has left the window (its line is still listed)
  v = b.view() as any;
  assert.equal(card(v, 'trust:gate-guard'), undefined, 'gone after 26 hours');
  assert.equal(gateCheckOf(v).ok, true);
  assert.notEqual(v.report.verdict, 'bad');
  assert.deepEqual(events.slice(1), ["this computer's gate: no rpc guard refusal left in the last 26 hours"]);
});

test('five wrong codes in the day: the check red and the guess card; four are calm', () => {
  const { b } = branch();
  const four = (s: number) => (s === T0 - 2 * H ? { 'wrong pin': 4, 'no hello': 1 } : {});
  b.observe(snap([plainDev()], { gate: gateAt(T0, () => 1, { by: four }) }) as any, null);
  let v = b.view() as any;
  assert.equal(gateCheckOf(v).ok, true);
  assert.match(gateCheckOf(v).text, /; 4 wrong codes \(wrong pin ×4\)/);
  assert.equal(card(v, 'trust:gate-guess'), undefined);
  const five = (s: number) => (s === T0 - 2 * H ? { 'wrong pin': 3, 'bad proof': 2 } : {});
  b.observe(snap([plainDev()], { gate: gateAt(T0, () => 1, { by: five }) }) as any, null);
  v = b.view() as any;
  assert.equal(gateCheckOf(v).ok, false);
  assert.equal(gateCheckOf(v).text, '5 wrong codes today: someone may be guessing. all were refused');
  const c = card(v, 'trust:gate-guess');
  assert.ok(c);
  assert.equal(c.weight, 3);
  assert.match(c.why, /^5 wrong codes in the last 24 hours \(wrong pin ×3, bad proof ×2\); all were refused\.$/);
});

test("a device's own rpc guard: the card, its verdict unchanged, absent from untrusted()", () => {
  const d = device();
  const why = 'rpc guard: op 12 (set tensor graph)';
  const plain = branch();
  plain.b.observe(snap([eyeDev(trustOf(d, { rejectsDay: { 'no hello': 2 } }))]) as any, null);
  const was = (plain.b.view() as any).report.devices[0].verdict;
  const { b, events } = branch();
  b.observe(snap([eyeDev(trustOf(d, { rejectsDay: { 'no hello': 2, [why]: 2 }, rejectsLast: [{ t: 1_000_000, why, peer: '192.168.1.9' }] }))]) as any, null);
  const v = b.view() as any;
  const c = card(v, 'trust:rpc-guard:p1');
  assert.ok(c, 'the card');
  assert.equal(c.weight, 3);
  assert.equal(c.title, "pixel's gate cut a split connection (rpc guard)");
  assert.match(c.why, /^2 times today, the last: rpc guard: op 12 \(set tensor graph\)\. a paired device sent a command that can carry code; it was dropped before llama\.cpp saw it\. kula versions that differ can do this by accident\. it defended itself: its verdict does not change\.$/);
  assert.deepEqual(c.action, { do: 'open', panel: 'branch', branch: 'trust' });
  assert.equal(v.report.devices[0].verdict, was, 'its verdict does not change');
  assert.notEqual(v.report.devices[0].verdict, 'bad');
  assert.equal(untrusted({ peek: () => v }).has('p1'), false, 'it is not barred');
  assert.equal(events.filter((e) => e.includes('rpc guard')).length, 1, 'one feed line');
  assert.equal(gateCheckOf(v), undefined, 'no host.gate: no host check');
});

test("a friend's device past the anchor's daily cap (memberMaxDay): on at 1.01, held at 0.96, gone at 0.9; 0.96 alone is nothing", () => {
  const cap = 2e9;
  const anchor = (x: number) => ({ anchor: { on: true, reachable: true, links: 1, bytesDay: x * cap, capDay: cap, memberMaxDay: x * cap } });
  const { b, events } = branch();
  b.observe(snap([plainDev()], anchor(1.01)) as any, null);
  let c = card(b.view(), 'trust:anchor-cap');
  assert.ok(c);
  assert.equal(c.weight, 2);
  assert.equal(c.title, "a friend's device passed its daily limit through this anchor");
  assert.equal(c.why, "a friend's device passed 2.02 of its 2.00 GB daily limit through this anchor today (UTC), ciphertext only; your own devices have no limit. the anchor refuses its new streams and cut its running ones until 00:00 UTC; the brain switched nothing.");
  assert.doesNotMatch(c.why, /nothing was switched off/, 'the anchor does refuse and cut (anchor.ts run)');
  b.observe(snap([plainDev()], anchor(0.96)) as any, null);
  c = card(b.view(), 'trust:anchor-cap');
  assert.ok(c, 'held above 0.95');
  assert.equal(c.title, "a friend's device passed its daily limit through this anchor");
  assert.equal(c.why, "the most one friend's device has passed through this anchor today is now 1.92 of its 2.00 GB daily limit (ciphertext only): under the limit, so the anchor takes its new streams again; the brain switched nothing.");
  b.observe(snap([plainDev()], anchor(0.9)) as any, null);
  assert.equal(card(b.view(), 'trust:anchor-cap'), undefined, 'gone under 0.95');
  assert.ok(card(b.view(), 'trust:anchor-near-cap'), 'near the cap again');
  assert.deepEqual(events, [
    "a friend's device passed 2.02 of its 2.00 GB daily limit through this anchor",
    "a friend's device is near its daily limit through this anchor: 0.20 GB left",
    "every friend's device is back under its daily limit through this anchor",
  ]);
  const other = branch();
  other.b.observe(snap([plainDev()], anchor(0.96)) as any, null);
  assert.equal(card(other.b.view(), 'trust:anchor-cap'), undefined, '0.96 from below: no card');
  other.b.observe(snap([plainDev()], { anchor: { on: true, reachable: null, links: 0, bytesDay: 5 * cap, capDay: null, memberMaxDay: 5 * cap } }) as any, null);
  assert.equal(card(other.b.view(), 'trust:anchor-cap'), undefined, 'no cap: no card');
  // the report is not touched by the anchor
  assert.equal(gateCheckOf(other.b.view()), undefined);
});

test('E2: anchor-cap and anchor-near-cap carry the cap to 2x in whole GB, from the cap the card saw', () => {
  const at = (cap: number, x: number) => ({ anchor: { on: true, reachable: true, links: 1, bytesDay: x * cap, capDay: cap, memberMaxDay: x * cap } });
  const over = branch();
  over.b.observe(snap([plainDev()], at(2e9, 1.01)) as any, null);
  let c = card(over.b.view(), 'trust:anchor-cap');
  assert.deepEqual(c.action, { do: 'cap', gb: 4, from: 2 });
  assert.equal(c.label, 'raise the limit');
  const near = branch();
  near.b.observe(snap([plainDev()], at(5e9, 0.85)) as any, null);
  c = card(near.b.view(), 'trust:anchor-near-cap');
  assert.deepEqual(c.action, { do: 'cap', gb: 10, from: 5 });
  assert.equal(c.label, 'raise the limit');
  // a cap that is not whole GB: 2x rounded up to a whole GB, from exactly the cap seen
  const odd = branch();
  odd.b.observe(snap([plainDev()], at(1.3e9, 1.2)) as any, null);
  c = card(odd.b.view(), 'trust:anchor-cap');
  assert.deepEqual(c.action, { do: 'cap', gb: 3, from: 1.3 });
  assert.equal(Math.round(c.action.from * 1e9), 1.3e9, 'the server checks the cap seen against the engine in bytes');
  // a cap whose double is past what the engine takes (100000 GB): only a look
  const huge = branch();
  huge.b.observe(snap([plainDev()], at(1e14, 1.01)) as any, null);
  c = card(huge.b.view(), 'trust:anchor-cap');
  assert.deepEqual(c.action, { do: 'open', panel: 'branch', branch: 'trust' });
  assert.equal(c.label, 'look');
});

test('the cap is per friend device: memberMaxDay over and under, and without it no card', () => {
  const cap = 2e9;
  const anchor = (o: Record<string, unknown>) => ({ anchor: { on: true, reachable: true, links: 3, bytesDay: 5 * cap, capDay: cap, ...o } });
  // one friend's device past its limit with three linked: the card, held at 0.96, gone at 0.9
  const { b, events } = branch();
  b.observe(snap([plainDev()], anchor({ memberMaxDay: 1.01 * cap })) as any, null);
  assert.equal(card(b.view(), 'trust:anchor-cap')?.title, "a friend's device passed its daily limit through this anchor");
  b.observe(snap([plainDev()], anchor({ memberMaxDay: 0.96 * cap })) as any, null);
  assert.ok(card(b.view(), 'trust:anchor-cap'), 'held above 0.95');
  b.observe(snap([plainDev()], anchor({ memberMaxDay: 0.9 * cap })) as any, null);
  assert.equal(card(b.view(), 'trust:anchor-cap'), undefined, 'gone under 0.95');
  assert.equal(events.length, 3, 'the cap card came and went; the near-cap card came at 0.9');
  // every friend's device under its limit while all together (the owner's own too) are far over it: no card
  const under = branch();
  under.b.observe(snap([plainDev()], anchor({ memberMaxDay: 0.5 * cap })) as any, null);
  assert.equal(card(under.b.view(), 'trust:anchor-cap'), undefined, 'memberMaxDay under: no card, whatever bytesDay says');
  // three members and no memberMaxDay (absent, or null): bytesDay over the cap says nothing per member
  const three = branch();
  three.b.observe(snap([plainDev()], anchor({})) as any, null);
  assert.equal(card(three.b.view(), 'trust:anchor-cap'), undefined, 'links 3 without memberMaxDay: no card');
  three.b.observe(snap([plainDev()], anchor({ memberMaxDay: null })) as any, null);
  assert.equal(card(three.b.view(), 'trust:anchor-cap'), undefined, 'memberMaxDay null: no card');
  assert.deepEqual(three.events, []);
  // one link or none and no memberMaxDay: still no card (links is now, bytesDay the whole day, VERDICT 1 DO 1)
  for (const links of [1, 0]) {
    const one = branch();
    one.b.observe(snap([plainDev()], { anchor: { on: true, reachable: true, links, bytesDay: 6e9, capDay: 5e9 } }) as any, null);
    assert.equal(card(one.b.view(), 'trust:anchor-cap'), undefined, `links ${links}, bytesDay 6e9 over capDay 5e9, no memberMaxDay: no card`);
    assert.deepEqual(one.events, []);
  }
});

test('a gap in the hours (no ledger line seen): the last 24 hours are chosen by start time, not by count', () => {
  // 24 entries over 26 hours: T0-5h and T0-6h were not seen; the two oldest hold 5 wrong codes
  const full = gateAt(T0, () => 1, { by: (s) => (s === T0 - 25 * H ? { 'wrong pin': 3 } : s === T0 - 24 * H ? { 'wrong pin': 2 } : { 'no hello': 1 }) });
  const gap = { ...full, hours: full.hours.filter((h) => h.start !== T0 - 5 * H && h.start !== T0 - 6 * H) };
  assert.equal(gap.hours.length, 24);
  const { b } = branch();
  b.observe(snap([plainDev()], { gate: gap }) as any, null);
  const v = b.view() as any;
  assert.equal(gateCheckOf(v).ok, true, 'the wrong codes are older than 24 hours');
  assert.equal(card(v, 'trust:gate-guess'), undefined, 'no guess card from hours older than 24');
  assert.match(gateCheckOf(v).text, /^its gate refused 22 strangers today \(no hello ×22\) from about 3 networks/);
});

test('near the anchor cap: a suggest from 0.8, the GB left, the name in the card only; past the cap the cap card names it', () => {
  const cap = 5e9;
  const anchor = (x: number, o: Record<string, unknown> = {}) => ({ anchor: { on: true, reachable: true, links: 2, bytesDay: x * cap, capDay: cap, memberMaxDay: x * cap, since: 1, ...o } });
  const name = 'ayse pixel';
  const under = branch();
  under.b.observe(snap([plainDev()], anchor(0.79, { memberMaxName: name })) as any, null);
  assert.equal(card(under.b.view(), 'trust:anchor-near-cap'), undefined, '0.79: nothing');
  assert.deepEqual(under.events, []);

  const { b, events, notes } = branch();
  b.observe(snap([plainDev()], anchor(0.8, { memberMaxName: name })) as any, null);
  let c = card(b.view(), 'trust:anchor-near-cap');
  assert.ok(c, '0.8: the card');
  assert.equal(c.kind, 'suggest');
  assert.equal(c.weight, 1);
  assert.equal(c.title, 'ayse pixel is near its daily limit through this anchor');
  assert.equal(c.why, "ayse pixel passed 4.00 of its 5.00 GB daily limit through this anchor today (UTC), counted since sharing last started: 1.00 GB left. a split load passes about the model's size through the anchor. at the limit the anchor refuses its new streams, past it it cuts the running ones too, until 00:00 UTC; the brain switched nothing.");
  assert.equal(card(b.view(), 'trust:anchor-cap'), undefined);
  assert.deepEqual(events, ["a friend's device is near its daily limit through this anchor: 1.00 GB left"]);

  b.observe(snap([plainDev()], anchor(1.02, { memberMaxName: name })) as any, null);
  assert.equal(card(b.view(), 'trust:anchor-near-cap'), undefined, 'past the cap: the cap card instead');
  c = card(b.view(), 'trust:anchor-cap');
  assert.equal(c.title, 'ayse pixel passed its daily limit through this anchor');
  assert.equal(c.why, 'ayse pixel passed 5.10 of its 5.00 GB daily limit through this anchor today (UTC), ciphertext only; your own devices have no limit. the anchor refuses its new streams and cut its running ones until 00:00 UTC; the brain switched nothing.');
  assert.deepEqual(events.slice(1), [
    "a friend's device passed 5.10 of its 5.00 GB daily limit through this anchor",
    "no friend's device is near its daily limit through this anchor any more (under 80% of it, or past it)",
  ]);
  assert.ok(!events.some((e) => e.includes('ayse')), 'memberMaxName never reaches a feed line');
  assert.ok(!(JSON.stringify(notes() ?? null) ?? '').includes('ayse'), 'nor the notes');

  // no name: a friend's device; no memberMaxDay: nothing
  const anon = branch();
  anon.b.observe(snap([plainDev()], anchor(0.9)) as any, null);
  assert.equal(card(anon.b.view(), 'trust:anchor-near-cap')?.title, "a friend's device is near its daily limit through this anchor");
  const bare = branch();
  bare.b.observe(snap([plainDev()], { anchor: { on: true, reachable: true, links: 2, bytesDay: 0.9 * cap, capDay: cap, memberMaxName: name } }) as any, null);
  assert.deepEqual((bare.b.view() as any).suggestions ?? [], [], 'no memberMaxDay: no card');
  assert.deepEqual(bare.events, []);
});

test('anchor refusals: full, too many streams and too many dials a warn card with their meaning; not here and removed one calm line a day; the rest none', () => {
  const a = (refused: unknown, o: Record<string, unknown> = {}) => ({ anchor: { on: true, reachable: true, links: 2, bytesDay: 0, capDay: 5e9, memberMaxDay: 0, since: 1, refused, removed: 0, ...o } });
  const ids = (v: any) => (v.suggestions ?? []).map((s: any) => s.id);
  const { b, events } = branch();
  b.observe(snap([plainDev()], a({ 'byte limit': 3, other: 2, 'did not accept': 1, 'dialer gone': 1, 'target gone': 1 })) as any, null);
  assert.deepEqual(ids(b.view()), [], 'byte limit (the cap card says it) and the rest: no card');
  assert.deepEqual(events, []);

  b.observe(snap([plainDev()], a({ full: 2, 'too many streams': 1, 'byte limit': 3 })) as any, null);
  let c = card(b.view(), 'trust:anchor-refusing');
  assert.ok(c);
  assert.equal(c.kind, 'warn');
  assert.equal(c.weight, 2);
  assert.equal(c.title, 'this anchor refused streams today');
  assert.equal(c.why, "today (UTC), counted since sharing last started: full ×2: every stream through this anchor was taken, or friends' devices together held all of theirs (a share stays free for your own devices); too many streams ×1: one device already had its most streams open at once. a refused stream fails the connection that asked for it; the brain switched nothing.");
  assert.deepEqual(events, ['this anchor refused streams today: full ×2, too many streams ×1']);

  b.observe(snap([plainDev()], a({ full: 4, 'too many streams': 1, 'too many dials': 7 })) as any, null);
  c = card(b.view(), 'trust:anchor-refusing');
  assert.match(c.why, /; too many dials ×7: a friend's device opened connections faster than its limit; one refused connection stops a split load\./);
  assert.equal(events.length, 1, 'the counts grow: no new line');

  // not here and removed members: one calm line, no card
  b.observe(snap([plainDev()], a({ 'not here': 2 }, { removed: 1 })) as any, null);
  assert.deepEqual(ids(b.view()), [], 'no card for not here or removed');
  assert.deepEqual(events.slice(1), [
    "this computer's anchor today: 2 connections asked for a device that was not connected to it right then (not here); 1 member whose access was removed, cut at once. nothing to do",
    "this anchor: no stream refused as full, too many streams or too many dials in today's count",
  ]);
  b.observe(snap([plainDev()], a({ 'not here': 5 }, { removed: 2 })) as any, null);
  assert.equal(events.length, 3, 'the same day: no second calm line');
  b.observe(snap([plainDev()], a({}, { removed: 0 })) as any, null);
  assert.equal(events.length, 3, 'the day turns (counts at 0): nothing said');
  b.observe(snap([plainDev()], a({ 'not here': 1 })) as any, null);
  assert.deepEqual(events.slice(3), ["this computer's anchor today: 1 connection asked for a device that was not connected to it right then (not here). nothing to do"]);

  // absent or broken fields: nothing
  for (const anchor of [
    { on: true, reachable: true, links: 1, bytesDay: 0, capDay: 5e9 },
    { on: true, reachable: true, links: 1, bytesDay: 0, capDay: 5e9, refused: null, removed: null },
    { on: true, reachable: true, links: 1, bytesDay: 0, capDay: 5e9, refused: ['full'], removed: 'x' },
    { on: true, reachable: true, links: 1, bytesDay: 0, capDay: 5e9, refused: { full: 'x', 'too many dials': -3, 'not here': NaN } },
  ]) {
    const o = branch();
    o.b.observe(snap([plainDev()], { anchor }) as any, null);
    assert.deepEqual(ids(o.b.view()), [], JSON.stringify(anchor));
    assert.deepEqual(o.events, [], JSON.stringify(anchor));
  }
});

test('no host.gate: the report is the same as before, no notes key, no card', () => {
  const { b, notes } = branch();
  b.observe(snap([]) as any, null);
  assert.deepStrictEqual((b.view() as any).report, {
    verdict: 'unknown', headline: 'no devices to check yet', at: 5_000,
    host: { name: 'mac', checks: [{ k: 'ledger', ok: true, text: 'its own ledger: 3 lines, the chain and every signature hold' }] }, devices: [],
  });
  assert.deepStrictEqual(b.view(), { built: true, stat: 'nothing to check', gauge: null, rows: [], lines: [], report: (b.view() as any).report });
  b.observe(snap([plainDev()], { gate: null }) as any, null);
  const v = b.view() as any;
  assert.deepStrictEqual(v.report.host.checks.map((c: any) => c.k), ['ledger']);
  assert.deepStrictEqual(v.suggestions, []);
  assert.equal(GATE_KEY in notes(), false, 'nothing kept for the gate');
  // the same look with and without a gate: only the gate check differs
  const two = branch();
  two.b.observe(snap([plainDev()], { gate: gateAt(T0, quiet) }) as any, null);
  const w = two.b.view() as any;
  assert.deepStrictEqual({ ...w.report, host: { ...w.report.host, checks: w.report.host.checks.filter((c: any) => c.k !== 'gate') } }, v.report);
});

test('`~gate` survives a reload: the fit comes back, and no hour is taken in twice', () => {
  const one = branch();
  for (let run = T0 - 40 * H; run <= T0; run += H) one.b.observe(snap([plainDev()], { gate: gateAt(run, quiet) }) as any, null);
  const kept = one.notes()[GATE_KEY];
  assert.ok(kept, 'kept under ~gate');
  assert.equal(kept.at, T0 - H, 'the newest finished hour taken in');
  assert.equal(kept.burst.n, 25 + 40, 'every finished hour once');
  const json = JSON.parse(JSON.stringify(one.notes()));
  const two = branch(json);
  two.b.observe(snap([plainDev()], { gate: gateAt(T0, quiet) }) as any, null);
  assert.deepStrictEqual(two.notes()[GATE_KEY], kept, 'the same look teaches nothing again');
  assert.equal(gateCheckOf(two.b.view()).text, gateCheckOf(one.b.view()).text, 'the same check after the reload');
  two.b.observe(snap([plainDev()], { gate: gateAt(T0 + H, quiet) }) as any, null);
  assert.equal(two.notes()[GATE_KEY].burst.n, kept.burst.n + 1, 'the next hour is taken in once');
  // a device with the reserved id is a device like a bad id: nothing of it is kept under ~gate
  two.b.observe(snap([{ ...plainDev(GATE_KEY), trust: { at: 5, error: null, rejectsDay: { 'no hello': 9 } } }], { gate: gateAt(T0 + H, quiet) }) as any, null);
  assert.equal(two.notes()[GATE_KEY].burst.n, kept.burst.n + 1);
  assert.equal(two.notes()[GATE_KEY].rejTotal, 0);
});

test('gateStep alone: hours taken in once, a clock gone back re-anchors, a hostile gate is none', () => {
  const hours = hoursOf(gateAt(T0, quiet));
  assert.equal(hours.length, 26);
  const a = gateStep(freshGate(), hours);
  assert.equal(a.changed, true);
  assert.equal(a.st.fit.n, 25);
  const again = gateStep(a.st, hours);
  assert.equal(again.changed, false);
  assert.equal(again.st, a.st);
  const back = gateStep({ ...a.st, at: T0 + 100 * H }, hours);
  assert.equal(back.changed, true);
  assert.equal(back.st.at, T0 - H);
  assert.equal(back.st.fit.n, 25, 'nothing taken in');
  for (const bad of [null, 1, 'x', [], { hours: 'x' }, { hours: [null, { start: 'x' }, { start: -1 }, { start: NaN }] }]) assert.deepEqual(hoursOf(bad), []);
  const odd = hoursOf({ hours: [{ start: T0, by: { 'no hello': 2.9, x: -1, y: 'z' }, far: 1e20 }, { start: T0 - H, by: null, far: -4 }] });
  assert.deepEqual(odd, [{ start: T0 - H, by: [], far: 0 }, { start: T0, by: [['no hello', 2]], far: 1e9 }]);
});
