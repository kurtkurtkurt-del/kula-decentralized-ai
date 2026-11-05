// The brain tab's pictures as plain numbers (5.11.2026): where the devices sit around this
// phone, how much of a ring a share fills, how the model's parts lie in one bar, a sparkline.
// Pure, so the tests need no phone and no svg.

export type Pt = { x: number; y: number };
export type Slot = Pt & { angle: number };

const rad = (deg: number) => (deg * Math.PI) / 180;
const round = (n: number) => Math.round(n * 10) / 10;
export const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * n places on an ellipse around (cx, cy), clockwise. One device sits to the right, two to
 * either side (the figure is wider than tall); from three on the first is at the top.
 */
export function orbit(n: number, cx: number, cy: number, rx: number, ry: number = rx): Slot[] {
  if (n <= 0) return [];
  const start = n <= 2 ? 0 : -90;
  return Array.from({ length: n }, (_, i) => {
    const angle = start + (360 / n) * i;
    return { angle, x: round(cx + rx * Math.cos(rad(angle))), y: round(cy + ry * Math.sin(rad(angle))) };
  });
}

/** At most max places: the first max-1 and a "+k" place when there are more. */
export function fit<T>(list: T[], max: number): { shown: T[]; more: number } {
  if (list.length <= max) return { shown: list, more: 0 };
  return { shown: list.slice(0, Math.max(0, max - 1)), more: list.length - Math.max(0, max - 1) };
}

/** A ring of radius r filled to frac, as a Circle's strokeDasharray (drawn from the top). */
export function ringDash(frac: number, r: number): { dash: string; length: number; circumference: number } {
  const circumference = 2 * Math.PI * r;
  const length = round(circumference * clamp01(frac));
  return { dash: `${length} ${round(circumference)}`, length, circumference: round(circumference) };
}

/** The point where a line from a toward b leaves a circle of radius r around a. */
export function edge(a: Pt, b: Pt, r: number): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1;
  return { x: round(a.x + (dx / d) * r), y: round(a.y + (dy / d) * r) };
}

export type Segment = { name: string; gb: number; frac: number; start: number };

/**
 * The model's parts as one stacked bar: each device's share of the whole, oldest order kept.
 * A part under min still shows (min of the bar), the rest give way so it adds up to 1.
 * Nothing measured (all 0 gb) → equal parts.
 */
export function shareSegments(split: { name: string; gb: number }[], min = 0.04): Segment[] {
  const parts = split.filter((s) => s.gb >= 0);
  if (!parts.length) return [];
  const total = parts.reduce((a, s) => a + s.gb, 0);
  const raw = parts.map((s) => (total > 0 ? s.gb / total : 1 / parts.length));
  const small = raw.filter((f) => f < min).length;
  const room = 1 - small * min;
  const bigSum = raw.filter((f) => f >= min).reduce((a, f) => a + f, 0);
  const fracs = small && room > 0 && bigSum > 0 ? raw.map((f) => (f < min ? min : (f / bigSum) * room)) : raw;
  let start = 0;
  return parts.map((s, i) => {
    const seg = { name: s.name, gb: s.gb, frac: fracs[i], start };
    start += fracs[i];
    return seg;
  });
}

/** What part of the model one device holds: split by its gb, apart and alone a whole copy each. */
export function nodeShare(mode: 'alone' | 'apart' | 'split', split: { name: string; gb: number }[], name: string, inModel: boolean): number {
  if (!inModel) return 0;
  if (mode !== 'split') return 1;
  const total = split.reduce((a, s) => a + s.gb, 0);
  const mine = split.find((s) => s.name.toLowerCase() === name.toLowerCase());
  return mine && total > 0 ? clamp01(mine.gb / total) : 0;
}

/** A sparkline through values, w by h, the highest touching the top; all zero lies on the floor. */
export function sparkPath(values: number[], w: number, h: number, pad = 1.5): string {
  if (!values.length) return '';
  const top = Math.max(...values, 0);
  const step = values.length > 1 ? w / (values.length - 1) : 0;
  const y = (v: number) => round(top > 0 ? h - pad - (v / top) * (h - pad * 2) : h - pad);
  return values.map((v, i) => `${i ? 'L' : 'M'}${round(i * step)} ${y(v)}`).join(' ');
}
