import { t } from '@/i18n/core';
import type { Key } from '@/i18n/dict';

// The line the server raised, in the person's language (i18n/parts/server.ts).
// Each pattern is the English text as raise exception wrote it; the first match
// wins, an unknown message comes back as it was, lower-cased. Screens that have
// their own code tables (the night, auth) fall back to this one.
const known: [RegExp, Key][] = [
  [/^sign in first$|^signedout$/i, 'err.signin'],
  [/this account is closed/i, 'err.closed'],
  [/^noproject$|no such project/i, 'err.noproject'],
  [/^notkept$/i, 'err.notkept'],
  [/^nonight$/i, 'err.nonight'],
  [/that night has passed/i, 'err.passed'],
  [/the wave is 1, 2 or 3/i, 'err.wave'],
  [/five open calls/i, 'err.calls.max'],
  [/unknown city/i, 'err.city'],
  [/unknown colour/i, 'err.colour'],
  [/admins? only/i, 'err.admin'],
  [/^not yours$/i, 'err.not.yours'],
  [/only the owner/i, 'err.owner'],
  [/no such person/i, 'err.no.person'],
  [/no such conversation/i, 'err.no.chat'],
  [/not yourself/i, 'err.not.self'],
  [/^one emoji$/i, 'err.emoji'],
  [/only friends can be added/i, 'err.friends.only'],
  [/friends only/i, 'err.friends.only'],
  [/not in this coop/i, 'err.coop'],
  [/at most 12 in a coop|the coop is full/i, 'err.coop.full'],
  [/no coop with that code|used up/i, 'err.code'],
  [/^taken$|name is taken/i, 'err.handle.taken'],
  [/slow down|too many/i, 'err.too.many'],
  [/wrong password|invalid login credentials/i, 'err.wrong.password'],
  [/no such call/i, 'err.no.call'],
];


export function serverText(e: unknown): string {
  const m = String((e as { message?: string })?.message ?? e ?? '').trim();
  const hit = known.find(([re]) => re.test(m));
  return hit ? t(hit[1]) : m.toLowerCase();
}
