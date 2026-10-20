import Storage from 'expo-sqlite/kv-store';
import { dict, type CountKey, type Key } from './dict';

// Translation core with no React or auth dependencies, so the data layer and
// AuthContext can import it without a cycle. Components use '@/i18n'.

// Three languages: English · Deutsch · Türkçe. Same strings and precedence as the website:
//   1. the language chosen on this device (kv-store 'pasaport.lang')
//   2. the account's language (profile_settings.locale) when the device has no choice
//   3. the phone's language
//   4. English
// Strings live in src/i18n/parts/*.ts, three languages side by side. Keys are typed:
// a missing key fails tsc.

export type Lang = 'en' | 'de' | 'tr';
export const langs: Lang[] = ['en', 'de', 'tr'];
export const langNames: Record<Lang, string> = { en: 'english', de: 'deutsch', tr: 'türkçe' };

const KEY = 'pasaport.lang';
type Vars = Record<string, string | number>;
type Entry = { en: string; de: string; tr: string };

export function known(code: unknown): Lang | null {
  const two = String(code ?? '').toLowerCase().slice(0, 2);
  return (langs as string[]).includes(two) ? (two as Lang) : null;
}

function fromDevice(): Lang | null {
  try {
    return known(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return null;
  }
}

export function remembered(): Lang | null {
  try {
    return known(Storage.getItemSync(KEY));
  } catch {
    return null;
  }
}

// Module-level language for code outside components (data layer, error strings).
let current: Lang = remembered() ?? fromDevice() ?? 'en';
export const getLang = () => current;
export function setCurrentLang(lang: Lang) {
  current = lang;
  try {
    Storage.setItemSync(KEY, lang);
  } catch {}
}

function fill(text: string, vars?: Vars) {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (vars[name] == null ? whole : String(vars[name])));
}

function word(lang: Lang, key: string): string | undefined {
  const entry = (dict as Record<string, Entry>)[key];
  if (!entry) return undefined;
  return entry[lang] ?? entry.en;
}

function build(lang: Lang) {
  const t = (key: Key, vars?: Vars) => fill(word(lang, key) ?? key, vars);
  // One night, three nights. Turkish keeps the singular after numbers: both forms match.
  const tn = (key: CountKey, n: number, vars?: Vars) =>
    fill(word(lang, `${key}.${n === 1 ? 'one' : 'other'}`) ?? word(lang, `${key}.other`) ?? key, { n, ...vars });
  // Strings whose key is built at runtime (type, weekday, server code).
  // Returns the given fallback when missing, else the key itself.
  const tx = (key: string, fallback?: string, vars?: Vars) => fill(word(lang, key) ?? fallback ?? key, vars);
  return { t, tn, tx };
}

// One translator per language, built once.
const translators = { en: build('en'), de: build('de'), tr: build('tr') };
export const translator = (lang: Lang) => translators[lang];
export type Translator = ReturnType<typeof build>;
type T = Translator['t'];

// For use OUTSIDE components; reads the current language. Inside components use useT(),
// otherwise the screen does not re-render when the language changes.
export const t: T = (key, vars) => translators[current].t(key, vars);
export const tx = (key: string, fallback?: string, vars?: Vars) => translators[current].tx(key, fallback, vars);


// Uppercasing happens here, not in styles: React Native's textTransform uses the
// phone's locale, not the app's. Turkish maps i→İ and ı→I; toUpperCase() is
// locale-independent (toLocaleUpperCase is never used without a locale).
export function upper(text: string, lang: Lang) {
  if (lang === 'tr') return text.replace(/i/g, 'İ').replace(/ı/g, 'I').toUpperCase();
  return text.toUpperCase();
}

// For data that is NOT in the app's language: titles, venues, artists, cities,
// handles, type names, English brand words. "pitbull" → "PITBULL".
export const upperData = (text: string) => text.toUpperCase();
