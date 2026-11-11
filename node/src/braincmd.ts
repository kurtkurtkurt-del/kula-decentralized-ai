// `kula-node brain replay`: the black box of god's eye read back as a short story of a night
// (godseye/replay.ts). The box is opened for reading only, so it is safe while `kula-node ui`
// writes to it.
import fs from 'node:fs';
import path from 'node:path';
import { home } from './paths.js';
import { openBox } from './godseye/box.js';
import { replayBox, nightOf, replayText } from './godseye/replay.js';

export function boxDir(): string {
  return path.join(home(), 'godseye', 'box');
}

/** a moment from the command line: ms since 1970, a local date and time (2026-11-10T18:00 or
 *  "2026-11-10 18:00"), or a local date (its midnight); null when it is none of these */
export function timeArg(v: string | boolean | undefined): number | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  if (/^\d{9,}$/.test(s)) return Number(s);
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (d) return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])).getTime();
  const t = Date.parse(s.replace(' ', 'T'));
  return Number.isFinite(t) ? t : null;
}

export function brainCommand(sub: string | undefined, flags: Record<string, string | boolean>, out: (s: string) => void = console.log, now = Date.now()): number {
  if (sub !== 'replay') {
    console.error('usage: kula-node brain replay [--from <time>] [--to <time>] [--night <yyyy-mm-dd>] [--json]');
    return 2;
  }
  const q: { from?: number; to?: number } = {};
  if (typeof flags.night === 'string') {
    const n = nightOf(flags.night);
    if (!n) { console.error('--night wants a date: yyyy-mm-dd (the evening the night starts)'); return 2; }
    Object.assign(q, n);
  }
  for (const k of ['from', 'to'] as const) {
    if (flags[k] === undefined) continue;
    const t = timeArg(flags[k]);
    if (t === null) { console.error(`--${k} wants a time: 2026-11-10T18:00, a date, or ms since 1970`); return 2; }
    q[k] = t;
  }
  if (q.from !== undefined && q.to === undefined) q.to = now;
  if (q.to !== undefined && q.from === undefined) q.from = q.to - 12 * 3_600_000;
  const dir = boxDir();
  if (!fs.existsSync(dir)) { out(`no black box yet (${dir}): it is written while kula-node ui runs`); return 1; }
  const r = replayBox(openBox({ dir, readOnly: true }), q, now);
  if (flags.json === true) {
    // the summary and the chain; the frames are for the page
    out(JSON.stringify({ from: r.from, to: r.to, range: r.range, records: r.records, summary: r.summary, chain: r.chain }, null, 2));
  } else out(replayText(r));
  return r.chain.ok ? 0 : 1;
}
