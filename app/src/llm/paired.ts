import type { PairedDevice } from '@/llm/native';

// "devices that can use this phone" (10.11.2026, docs/GATE.md "remove a device's access"): the
// masters paired with this phone's gate. Each paired once with a one-time code and gets in by
// its certificate alone from then on, until it is removed here. The native side (Unpair.kt)
// lists and removes; this file only words the list.

/** The fingerprint as the app shows it everywhere: the first 16 hex in two groups. */
export const shortFp = (fp: string): string => `${fp.slice(0, 8)} ${fp.slice(8, 16)}`;

/** A name for a device: the one it has, else its short fingerprint. */
export const pairedName = (d: Pick<PairedDevice, 'name' | 'fp'>): string => (d.name?.trim() ? d.name.trim().toLowerCase() : shortFp(d.fp));

/** How long ago, as a dictionary key (comp.ago.*) and its number. */
export function agoOf(t: number, now = Date.now()): { key: string; vars?: Record<string, string> } {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 90) return { key: 'comp.ago.now' };
  if (s < 90 * 60) return { key: 'comp.ago.min', vars: { n: String(Math.round(s / 60)) } };
  if (s < 48 * 3600) return { key: 'comp.ago.h', vars: { n: String(Math.round(s / 3600)) } };
  return { key: 'comp.ago.d', vars: { n: String(Math.round(s / 86400)) } };
}

/** Is this device the one working through the gate right now (the worker reports the address)? */
export const isConnected = (d: Pick<PairedDevice, 'address'>, peer: string | null | undefined): boolean => !!peer && !!d.address && d.address === peer;

/** The list without the devices another part of the screen already shows (the computers screen's own list). */
export const withoutFps = (list: PairedDevice[], fps: string[]): PairedDevice[] => {
  const skip = new Set(fps.map((f) => f.toLowerCase()));
  return list.filter((d) => !skip.has(d.fp));
};
