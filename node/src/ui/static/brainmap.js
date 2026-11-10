// The brain panel as a map (10.11.2026, the owner's pick of five designs: "the map, then four
// numbers"). The pure part, shared with the tests: which state each branch is in, which branch
// the panel opens first, the four numbers and where the twelve sit around this computer.
// app.js draws it; god's eye (src/godseye) says what each branch sees.
//
// A branch is in one of five states, drawn as one colour language instead of twelve hues:
//   look   red: something needs you (trust found a problem, a limit warns, a broken branch)
//   know   gold: worth knowing (a device not answering, an advice to act on, a request waiting)
//   fine   sage: working, nothing to do
//   quiet  grey, dashed: nothing to say yet (idle, still learning, no device)
//   off    not built yet
// The states are read from the eye's own words (its stat line and the trust report); a branch
// that later says more about itself only needs a line here.

export const STATES = ['look', 'know', 'fine', 'quiet', 'off'];
export const STATE_WORD = { look: 'look at this', know: 'worth knowing', fine: 'fine', quiet: 'quiet', off: 'not built yet' };

const QUIET = {
  senses: /^no device/,
  memory: /^0 events/,
  forecast: /^still learning|^no (known )?device|^looking/,
  learning: /^nothing to learn/,
  connections: /^0 cable · 0 wi-fi$/,
  planner: /^nothing planned/,
  executor: /^idle$/,
  review: /^nothing waiting|^no night project/,
  advisor: /^nothing to suggest|^no device to advise on/,
  trust: /^nothing to check|^not checked/,
};

/** One branch's state from its view of the eye (null: not heard yet). */
export function branchState(id, v) {
  if (!v) return 'quiet';
  if (!v.built) return 'off';
  if (v.error) return 'look';
  const stat = String(v.stat ?? '');
  if (/^looking/.test(stat)) return 'quiet';
  if (id === 'trust') {
    const verdict = v.report?.verdict;
    if (verdict === 'bad' || /to look at/.test(stat)) return 'look';
    if (verdict === 'ok' || /^all clear/.test(stat)) return 'fine';
    return 'quiet';
  }
  if (id === 'limits') return /warning/.test(stat) ? 'look' : 'fine';
  if (QUIET[id]?.test(stat)) return 'quiet';
  if (id === 'senses') { const m = /^(\d+) of (\d+)/.exec(stat); return m && Number(m[1]) < Number(m[2]) ? 'know' : 'fine'; }
  if (id === 'advisor') return /^night project: /.test(stat) ? 'look' : /^keep /.test(stat) ? 'fine' : 'know';
  if (id === 'review') return /to look at again/.test(stat) ? 'know' : 'fine';
  return 'fine';
}

/** Every branch's state, in map order: [{ id, state }]. `views(id)` gives the eye's view or null. */
export function statesOf(ids, views) { return ids.map((id) => ({ id, state: branchState(id, views(id)) })); }

/** How many branches are in each state (for the legend). */
export function counts(list) {
  const c = { look: 0, know: 0, fine: 0, quiet: 0, off: 0 };
  for (const x of list) c[x.state]++;
  return c;
}

/** The branch the panel opens first: the first that needs you, else the first worth knowing, else the executor. */
export function firstOpen(list) {
  return list.find((x) => x.state === 'look')?.id ?? list.find((x) => x.state === 'know')?.id ?? 'executor';
}

/** The notices under the open card: the other branches that need you or are worth knowing,
 *  less the ones the numbers card already says (`inCard`). */
export function notices(list, open, inCard = ['senses']) {
  return list.filter((x) => x.id !== open && !inCard.includes(x.id) && (x.state === 'look' || x.state === 'know'));
}

/** The four numbers, read from the eye's stat lines; a number that is not there yet is null. */
export function fourNumbers({ senses = '', learning = '', memory = '' } = {}) {
  const dev = /^(\d+) of (\d+)/.exec(senses);
  const reach = /(\d+(?:\.\d+)?)%/.exec(learning);
  const mem = /^(\d+) events kept(?: · (\d+) today)?/.exec(memory);
  return {
    devices: dev ? { on: Number(dev[1]), of: Number(dev[2]) } : null,
    reach: reach ? Number(reach[1]) : null,
    events: mem ? { n: Number(mem[1]), today: mem[2] != null ? Number(mem[2]) : null } : null,
  };
}

/** Where the k-th of twelve sits on the ring (clockwise from the top), and its label's line. */
export const MAP = { w: 348, h: 320, top: 12, cx: 174, cy: 172, rx: 122, ry: 124, r: 17, core: 54 };
export function nodeAt(k) {
  const a = ((-90 + 30 * k) * Math.PI) / 180;
  const x = MAP.cx + MAP.rx * Math.cos(a), y = MAP.cy + MAP.ry * Math.sin(a);
  // the three at the top carry their label above, the rest below
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, ly: Math.round((k === 11 || k === 0 || k === 1 ? y - 24 : y + 31) * 10) / 10 };
}
