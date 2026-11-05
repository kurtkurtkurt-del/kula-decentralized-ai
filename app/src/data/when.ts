import { t, tx } from '@/i18n/core';

// Date and time formatted like the web: "thu 26.09". The weekday uses the language at
// call time (called during render). A project lives by its nights, not by a date, so
// only the labels remain here.
const two = (n: number) => String(n).padStart(2, '0');
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const dayName = (d: Date) => tx('day.' + DAYS[d.getDay()], DAYS[d.getDay()]);
export function dayLabel(iso: string | null): string {
  if (!iso) return t('when.tba');
  const d = new Date(iso);
  if (isNaN(d.getTime())) return t('when.tba');
  return `${dayName(d)} ${two(d.getDate())}.${two(d.getMonth() + 1)}`;
}
// "tonight", "tomorrow" or "fri 24.10" for a night (a date, yyyy-mm-dd).
export function nightLabel(night: string): string {
  const d = new Date(night + 'T12:00:00');
  const today = new Date(Date.now() - 12 * 3600_000);
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000);
  if (days === 0) return t('when.tonight');
  if (days === 1) return t('when.tomorrow');
  return `${dayName(d)} ${two(d.getDate())}.${two(d.getMonth() + 1)}`;
}
export const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};
