// A simulated night for the night replay (src/godseye/replay.ts, the page's replay.js): the real
// god's eye with its twelve branches looks at a made-up cluster every 10 s from 18:00 to 09:00 and
// writes its black box into $KULA_NODE_HOME/godseye/box, the box `kula-node ui` reads.
//
//   KULA_NODE_HOME=/tmp/kula-sim npx tsx tools/sim-night.ts [yyyy-mm-dd of the evening]
//
// three devices around this computer: a phone on the wi-fi, a tablet on the cable, an old phone
// that drops off for an hour. A model is loaded at 19:30 (apart), the night's work comes in bursts,
// the phone answers for 40 minutes straight (the limits branch says it should rest), the eye is
// stopped for half an hour at 02:10, the model goes at 06:30. Nothing here touches a device.
import fs from 'node:fs';
import path from 'node:path';
import { GodsEye } from '../src/godseye/index.js';
import type { Snapshot, EyeDevice } from '../src/godseye/index.js';

const home = process.env.KULA_NODE_HOME;
if (!home) { console.error('set KULA_NODE_HOME to a scratch folder first: this writes a black box there'); process.exit(2); }
const arg = process.argv[2];
const evening = arg && /^\d{4}-\d{2}-\d{2}$/.test(arg) ? new Date(`${arg}T18:00:00`) : (() => { const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(18, 0, 0, 0); return d; })();
const T0 = evening.getTime();
const MIN = 60_000;
const at = (h: number, m = 0): number => T0 + ((h < 18 ? h + 24 : h) - 18) * 60 * MIN + m * MIN;

let now = T0;
const dir = path.join(home, 'godseye');
fs.mkdirSync(dir, { recursive: true });

const dev = (id: string, name: string, kind: string, via: EyeDevice['via'], o: Partial<EyeDevice> = {}): EyeDevice => ({
  id, name, kind, via, where: via === 'cable' ? 'usb cable' : '192.168.1.20:50551', reachable: true, reachMs: via === 'cable' ? 3 : 18,
  reason: null, checkedAt: now - 2000, lastOk: new Date(now).toISOString(), ramMb: 5200, bwGBs: 40, gpu: null, tls: true,
  waitingPair: false, plugged: via === 'cable' ? true : null, holds: null, trust: null, ...o,
});

// the work: who is answering when, and their counters
const done: Record<string, number> = { local: 0, pixel: 0, tab: 0, old: 0 };
const busyAt = (id: string, t: number): boolean => {
  const m = Math.floor((t - T0) / MIN);
  if (t < at(19, 40) || t >= at(6, 30)) return false;
  if (id === 'pixel' && t >= at(1, 0) && t < at(1, 40)) return true;            // forty minutes straight
  if (id === 'pixel') return m % 23 < 7;
  if (id === 'tab') return t >= at(22, 0) && t < at(3, 30) && m % 17 < 9;
  if (id === 'old') return t >= at(23, 0) && t < at(4, 0) && m % 29 < 6;
  if (id === 'local') return m % 41 < 4;
  return false;
};
const TPS: Record<string, number> = { local: 31.5, pixel: 14.2, tab: 9.8, old: 4.1 };
let wasBusy: Record<string, boolean> = {};

function snapshot(): Snapshot {
  const t = now;
  const oldThere = !(t >= at(4, 0) && t < at(5, 0));
  const devices = [
    dev('pixel', 'pixel 8', 'phone', 'wifi'),
    dev('tab', 'galaxy tab', 'phone', 'cable'),
    dev('old', 'old moto', 'phone', 'wifi', oldThere ? {} : { reachable: false, reason: 'timed out' }),
  ];
  const loadedNow = t >= at(19, 30) && t < at(6, 30);
  const ids = ['local', 'pixel', 'tab', ...(oldThere ? ['old'] : [])];
  const work: Snapshot['work'] = {
    loaded: loadedNow ? {
      mode: 'apart', model: { id: 'qwen2.5-3b', name: 'qwen 2.5 3b', file: 'qwen2.5-3b-instruct-q4_k_m.gguf', size: 2_100_000_000 }, ctx: 4096, since: at(19, 30),
      devices: ids.map((id) => {
        const busy = busyAt(id, t);
        if (wasBusy[id] && !busy) done[id]++;
        wasBusy[id] = busy;
        return { id, name: id === 'local' ? 'this computer' : id, local: id === 'local', busy, tps: busy || done[id] ? TPS[id] : null, done: done[id] };
      }),
    } : null,
    loading: t >= at(19, 28) && t < at(19, 30) ? { mode: 'apart', model: 'qwen 2.5 3b', since: at(19, 28), line: 'sending to the phones' } : null,
    chatting: ids.filter((id) => loadedNow && busyAt(id, t)).length,
    plan: loadedNow ? ['apart: each device holds a copy'] : [], decisions: [], llama: true,
  };
  if (!loadedNow) wasBusy = {};
  return {
    at: t, host: { name: 'mac mini', freeMb: 9000, ledger: { ok: true, count: 12, problem: null } }, devices, work,
    models: [{ id: 'qwen2.5-3b', name: 'qwen 2.5 3b', file: 'qwen2.5-3b-instruct-q4_k_m.gguf', size: 2_100_000_000, quant: 'q4_k_m', params_b: 3, catalog: true, here: true, needMb: 2600 }],
    projects: [{ id: 'p1', title: 'summarise the notes', request: 'private words', start: at(22, 0), end: at(3, 0), state: t < at(22, 0) ? 'waiting' : t < at(3, 30) ? 'running' : 'done', mode: 'apart', model: 'qwen2.5-3b', peers: ['pixel', 'tab', 'old'] }],
  };
}

const eye = new GodsEye({ snapshot, dir, now: () => now, everyMs: 1e9, box: { dir: path.join(dir, 'box') }, log: () => {} });
const STEP = 10_000;
const started = Date.now();
eye.start();
let off = false;
for (now = T0 + STEP; now <= at(9, 0); now += STEP) {
  if (!off && now >= at(2, 10) && now < at(2, 40)) { eye.stop(); off = true; continue; }
  if (off && now < at(2, 40)) continue;
  if (off) { off = false; eye.start(); continue; }
  eye.tick();
}
eye.stop();
const v = eye.view();
console.log(`a night from ${evening.toString()}: ${v.box?.count ?? 0} records, chain ${v.box?.ok ? 'ok' : v.box?.problem} (${Math.round((Date.now() - started) / 1000)} s)`);
