import type { Translator } from '@/i18n/core';

// Download arithmetic (5.11.2026), pure: the smoothed rate and the "time left" words.
/** Bytes per second from two readings, smoothed into the previous estimate. */
export function rate(prev: number | null, dBytes: number, dMs: number): number | null {
  if (dMs <= 0 || dBytes < 0) return prev;
  const now = (dBytes / dMs) * 1000;
  return prev == null ? now : prev * 0.7 + now * 0.3;
}

/** "4 min left" · "25 s left" · "almost there"; empty while the rate is unknown. */
export function leftText(t: Translator['t'], bytesLeft: number, bps: number | null): string {
  if (!bps || bps < 1024) return '';
  const s = bytesLeft / bps;
  if (s < 8) return t('dl.leftSoon');
  if (s < 90) return t('dl.left', { t: t('dl.sec', { n: Math.max(5, Math.round(s / 5) * 5) }) });
  return t('dl.left', { t: t('dl.min', { n: Math.max(1, Math.round(s / 60)) }) });
}
