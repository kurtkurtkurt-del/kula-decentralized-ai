// Small helpers the branches share.
import type { EyeDevice } from '../types.js';

export const hhmm = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
export const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
export const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
export const reachWord = (d: EyeDevice) => (d.reachable == null ? 'not checked yet' : d.reachable ? `reachable${d.reachMs != null ? ` · ${d.reachMs} ms` : ''}` : `not reachable: ${d.reason ?? 'no answer'}`);
/** a device counts as active when it answered the last look (a cable phone also needs to be plugged in) */
export const active = (d: EyeDevice) => d.reachable === true && d.plugged !== false;
