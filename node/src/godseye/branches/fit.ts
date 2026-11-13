// one fit for review and the advisor (P39, 13.11.2026): which devices a night project would use and
// whether its model fits them, under the same shares as kula's engine (decide.ts: LOCAL_SHARE of
// this computer's free memory, WORKER_SHARE of a device's). review says 'too-big' from `fits`; the
// advisor says `gone` and `problems`. Pure: it reads the snapshot, it never decides anything.
import type { EyeDevice, EyeModel, EyeProject, Snapshot } from '../types.js';
import { active, gb } from './util.js';
import { LOCAL_SHARE, WORKER_SHARE, heldHere } from './decide.js';

/** a device the fit counts, with what a model may take of it (null: its memory is not known) */
export interface Counted { device: EyeDevice; capMb: number | null }

export interface Fit {
  devices: (EyeDevice | undefined)[];   // the devices the project would use (a chosen one gone from the book stays undefined)
  counted: Counted[];                   // of those, the ones active now or expected by the start
  gone: string[];                       // chosen ids missing from the book, or neither active nor expected
  fits: boolean | null;                 // null: not known
  problems: string[];                   // in words, for a person
}

/** an "apart" project with no device chosen runs on every paired one */
export const implicit = (p: EyeProject): boolean => p.mode === 'apart' && !p.peers.length;

/** The devices a project would use: 'here' none; the chosen ones as they are; with none chosen, every paired one in 'apart' and none in 'phone' or 'split'. */
export function projectDevices(p: EyeProject, s: Snapshot): (EyeDevice | undefined)[] {
  if (p.mode === 'here') return [];
  if (!p.peers.length) return p.mode === 'apart' ? s.devices : [];
  return p.peers.map((id) => s.devices.find((d) => d.id === id));
}

/** whether a project's model fits the devices it would use; `expected` are ids away now that the forecast has back by the start */
export function projectFit(s: Snapshot, p: EyeProject, m: EyeModel | null, expected: Set<string> = new Set<string>()): Fit {
  const devices = projectDevices(p, s);
  const counts = (d: EyeDevice) => active(d) || expected.has(d.id);
  const counted: Counted[] = devices
    .filter((d): d is EyeDevice => !!d && counts(d))
    .map((d) => ({ device: d, capMb: d.ramMb ? Math.floor(d.ramMb * WORKER_SHARE) : null }));
  const gone = implicit(p) || p.mode === 'here' ? [] : p.peers.filter((id) => {
    const d = s.devices.find((x) => x.id === id);
    return !d || !counts(d);
  });
  // a chosen device not looked at yet (reachable null) may hold anything: the fit is not known
  const unseen = !implicit(p) && devices.some((d) => !!d && !counts(d) && d.reachable == null);
  const problems: string[] = [];
  if (!m) return { devices, counted, gone, fits: null, problems };

  const need = m.needMb;
  const llama = !!s.work.llama;
  // the project's load unloads the model here first (engine.load), so what it holds counts back (C2)
  const hostCap = s.host.freeMb == null ? null : Math.floor((s.host.freeMb + heldHere(s)) * LOCAL_SHARE);
  const needs = `${m.name} needs about ${gb(need)}`;
  let fits: boolean | null;

  if (p.mode === 'here') {
    if (!llama) { fits = false; problems.push('this computer cannot run a model itself'); }
    else if (hostCap == null) fits = null;
    else { fits = need <= hostCap; if (!fits) problems.push(`${needs}, this computer has ${gb(hostCap)} to spare`); }
    return { devices, counted, gone, fits, problems };
  }

  if ((p.mode === 'phone' || p.mode === 'split') && !p.peers.length) problems.push('no device chosen');

  if (p.mode === 'split') {
    if (unseen || counted.some((c) => c.capMb == null) || (llama && hostCap == null)) fits = null;
    else {
      const sum = counted.reduce((t, c) => t + c.capMb!, 0) + (llama ? hostCap! : 0);
      fits = need <= sum;
      if (!fits) problems.push(`${needs}, together they offer ${gb(sum)}`);
    }
    return { devices, counted, gone, fits, problems };
  }

  // phone / apart: a whole copy has to fit one place (apart may also run on this computer)
  const known = counted.filter((c) => c.capMb != null);
  const sizes = known.map((c) => c.capMb!);
  if (p.mode === 'apart' && llama && hostCap != null) sizes.push(hostCap);
  fits = sizes.length ? sizes.some((x) => need <= x) : null;
  if (unseen && fits === false) fits = null;
  if (implicit(p)) { if (fits === false) problems.push(`${needs}, no device offers more than ${gb(Math.max(...sizes))}`); }
  else for (const c of known) if (need > c.capMb!) problems.push(`${needs}, ${c.device.name} offers ${gb(c.capMb!)}`);
  return { devices, counted, gone, fits, problems };
}
