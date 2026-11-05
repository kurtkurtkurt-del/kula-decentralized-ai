// The dictionary after a merge: every key has all three languages, and no key is defined
// in two parts (dict.ts spreads them in order, so a duplicate would silently win).
import { describe, expect, it } from '@jest/globals';
import { audit } from '@/i18n/parts/audit';
import { bench } from '@/i18n/parts/bench';
import { common } from '@/i18n/parts/common';
import { coops } from '@/i18n/parts/coops';
import { home } from '@/i18n/parts/home';
import { models } from '@/i18n/parts/models';
import { pages } from '@/i18n/parts/pages';
import { server } from '@/i18n/parts/server';
import { staff } from '@/i18n/parts/staff';
import { tabs } from '@/i18n/parts/tabs';
import { tips } from '@/i18n/parts/tips';
import { ux } from '@/i18n/parts/ux';
import { brain } from '@/i18n/parts/brain';
import { voice } from '@/i18n/parts/voice';
import { tasks } from '@/i18n/parts/tasks';
import { dict } from '@/i18n/dict';

const parts: Record<string, Record<string, Record<string, string>>> = { common, home, tabs, pages, staff, tips, coops, server, models, audit, ux, brain, bench, voice, tasks };

describe('i18n dict', () => {
  it('has no key in two parts', () => {
    const seen = new Map<string, string>();
    const dups: string[] = [];
    for (const [name, part] of Object.entries(parts)) {
      for (const k of Object.keys(part)) {
        if (seen.has(k)) dups.push(`${k} (${seen.get(k)} and ${name})`);
        seen.set(k, name);
      }
    }
    expect(dups).toEqual([]);
    expect(Object.keys(dict).length).toBe(seen.size);
  });

  it('has en, de and tr for every key', () => {
    const missing: string[] = [];
    for (const [k, v] of Object.entries(dict as Record<string, Record<string, unknown>>)) {
      for (const l of ['en', 'de', 'tr']) if (typeof v[l] !== 'string' || !v[l]) missing.push(`${k}:${l}`);
    }
    expect(missing).toEqual([]);
  });
});
