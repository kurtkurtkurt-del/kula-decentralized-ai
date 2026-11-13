// A peer's name as the screen may show it (13.11.2026: moved out of peers.ts, which
// re-exports both, so store.ts can heal a stored peer's name without importing peers.ts:
// peers.ts imports store.ts, and the way back would be a cycle).

/**
 * A device name as the screen may show it: controls (C0, DEL, C1) and the line and paragraph
 * separators become a space; zero-width marks, direction overrides and isolates, word joiners
 * and the byte order mark go; runs of space become one. The same rules as kula-node's guard
 * (node/src/godseye/branches/guard.ts cleanName), copied on purpose: no import across packages.
 */
export const cleanName = (s: string): string =>
  s
    .replace(/[\u{0}-\u{1f}\u{7f}-\u{9f}\u{2028}\u{2029}]/gu, ' ')
    .replace(/[\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2069}\u{feff}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * A stored peer's name as the screen may show it. A peer saved before names were checked can
 * carry a number, an object or an array there: then its host, then its id, then '?'.
 */
export function peerName(p: { name?: unknown; host?: unknown; id?: unknown }): string {
  const name = typeof p.name === 'string' ? cleanName(p.name).slice(0, 80) : '';
  if (name) return name;
  if (typeof p.host === 'string' && p.host) return p.host;
  if (typeof p.id === 'string' && p.id) return p.id;
  return '?';
}
