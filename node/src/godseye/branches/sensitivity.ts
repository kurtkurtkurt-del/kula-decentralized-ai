// How private a job is (11.11.2026), for the request review branch: which of the three rings it
// may go to. Rules only, in this file, each one a pattern with a name the person can read: no
// model, no cloud classifier, nothing that cannot say why. (The research behind it is in
// docs/AUDIT.md, "rings and request review": Presidio-style recognizers, a pattern with a
// checksum and context words; gitleaks-style secret rules; GDPR art. 9 / KVKK art. 6 for the
// special categories. A small injection classifier such as Prompt Guard 2 would be a model to
// ship and could not say why, so injection is a handful of phrases too.)
//
//   private    personal data and secrets: an e-mail, a phone number, an iban, a card, a turkish id
//              number, a password or key, a street address, a birth date, a named person, the
//              person's own files and photos, something marked confidential, their own health or
//              money (a health or money word next to "my", "ben", "annem", a name, or a turkish
//              first-person ending: "kanserim", "maaşım")
//   circle-ok  nothing personal, but not for strangers: a health topic, pasted code, the person's
//              own company and clients
//   world-ok   none of the above
//
// A ring takes: home everything, circle circle-ok and world-ok, world world-ok only.
// Nothing here keeps or returns text: the answers are kind names and counts.
import type { EyeDevice, Ring } from '../types.js';

export type Level = 'private' | 'circle-ok' | 'world-ok';
export const RINGS: Ring[] = ['home', 'circle', 'world'];
const LEVELS: Level[] = ['world-ok', 'circle-ok', 'private'];

export const ringOf = (d: Pick<EyeDevice, 'ring'> | undefined | null): Ring => (d?.ring === 'circle' || d?.ring === 'world' ? d.ring : 'home');
/** the wider of rings: world over circle over home */
export const widest = (rings: Ring[]): Ring => rings.reduce((a, b) => (RINGS.indexOf(b) > RINGS.indexOf(a) ? b : a), 'home' as Ring);
/** the stricter of levels */
export const strictest = (levels: Level[]): Level => levels.reduce((a, b) => (LEVELS.indexOf(b) > LEVELS.indexOf(a) ? b : a), 'world-ok' as Level);
/** may material of this level go to a device of this ring */
// the person's decision (11.11.2026): what is theirs may go to their friends' devices too; only
// strangers would be held to world-ok pieces (and strangers take no part today)
export const mayGo = (level: Level, ring: Ring): boolean => ring !== 'world' || level === 'world-ok';

// ---- finders: each returns the spans it found

type Span = [number, number];
type Finder = (text: string) => Span[];

const all = (re: RegExp, text: string, keep: (m: string) => boolean = () => true): Span[] => {
  const out: Span[] = [];
  for (const m of text.matchAll(re)) if (keep(m[0])) out.push([m.index!, m.index! + m[0].length]);
  return out;
};
const digits = (s: string) => s.replace(/\D/g, '');

// e-mail addresses in linear time. The plain pattern restarts at every character of a long run with
// no '@' in it (a DNA sequence, a hex dump) and scans it to its end again: quadratic. Every start
// inside one run of local-part characters reaches the same '@' and the same domain, so a match can
// only begin where such a run begins (the lookbehind) or right where the last match ended inside one
// (the sticky try): the same matches as the plain pattern.
const EMAIL = '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}';
const EMAIL_START = new RegExp(`(?<![A-Za-z0-9._%+-])${EMAIL}`, 'g');
const EMAIL_GLUED = new RegExp(EMAIL, 'y');
const LOCAL_CHAR = /[A-Za-z0-9._%+-]/;
function emails(text: string): Span[] {
  const out: Span[] = [];
  for (let i = 0; ;) {
    let m: RegExpExecArray | null = null;
    if (i > 0 && LOCAL_CHAR.test(text[i - 1])) { EMAIL_GLUED.lastIndex = i; m = EMAIL_GLUED.exec(text); }
    if (!m) { EMAIL_START.lastIndex = i; m = EMAIL_START.exec(text); }
    if (!m) return out;
    out.push([m.index, m.index + m[0].length]);
    i = m.index + m[0].length;
  }
}

function luhn(num: string): boolean {
  let sum = 0;
  for (let i = 0; i < num.length; i++) {
    let d = Number(num[num.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function ibanOk(raw: string): boolean {
  const s = raw.replace(/\s/g, '').toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of v) rest = (rest * 10 + Number(c)) % 97;
  }
  return rest === 1;
}

/** a turkish id number (T.C. kimlik no): 11 digits, no leading zero, two check digits */
export function tcknOk(raw: string): boolean {
  const d = digits(raw);
  if (d.length !== 11 || d[0] === '0') return false;
  const n = [...d].map(Number);
  const odd = n[0] + n[2] + n[4] + n[6] + n[8], even = n[1] + n[3] + n[5] + n[7];
  if ((((odd * 7 - even) % 10) + 10) % 10 !== n[9]) return false;
  return n.slice(0, 10).reduce((a, b) => a + b, 0) % 10 === n[10];
}

const SECRETS: RegExp[] = [
  /(?<![\p{L}\d])(?:password|passwd|pwd|passcode|passphrase|parola|şifre|sifre)\s*[:=]\s*\S+/giu,
  /\b(?:api[ _-]?key|apikey|access[ _-]?key|secret|token|auth)\s*[:=]\s*\S{8,}/gi,
  /\b[A-Z][A-Z0-9_]*_(?:KEY|SECRET|TOKEN|PASSWORD|PASS|PWD)\s*[:=]\s*\S{6,}/g,      // an .env line
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[^\s:@/]+:[^\s@/]+@\S+/gi, // a password in a url
  /\bhooks\.slack\.com\/services\/[A-Za-z0-9/]+/g,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(?:sk|pk|rk)[-_](?:live[-_]|test[-_]|proj[-_]|ant[-_])?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g,   // a jwt
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /\b[A-Fa-f0-9]{32,}\b/g,                                          // a long hex key
];
// a long run that mixes upper, lower and digits looks like a key, not a word
const RANDOMISH = /[A-Za-z0-9+/_-]{28,}/g;
const randomish = (m: string) => /[A-Z]/.test(m) && /[a-z]/.test(m) && /\d/.test(m) && !/^[a-z]+(?:[-_][a-z]+)+$/i.test(m);

// a word boundary that knows turkish letters (\b does not: "ş" is no word char to it)
const L = '(?<![\\p{L}\\p{N}_])';
const R = '(?![\\p{L}\\p{N}_])';
const words = (list: string, flags = 'giu') => new RegExp(`${L}(?:${list})${R}`, flags);

// a name: a capital, then small letters (turkish ones too)
const NAME = '\\p{Lu}[\\p{Ll}\'’]+';
// a word list matched with its first letter in either case, the rest as written (an /i flag would
// let \p{Lu} match small letters too)
const eitherCase = (list: string) => list.split('|').map((w) => `[${w[0]}${w[0].toLocaleUpperCase('tr')}]${w.slice(1)}`).join('|');
const PERSON: RegExp[] = [
  new RegExp(`${L}(?:Mr|Mrs|Ms|Miss|Dr|Prof|Doç|Av|Sayın|Bay|Bayan)\\.?\\s+${NAME}(?:\\s+${NAME})?`, 'gu'),
  new RegExp(`${NAME}\\s+(?:Hanım|Bey|Hanımefendi|Beyefendi|Hoca)${R}`, 'gu'),
  new RegExp(`${L}(?:[Mm]y|[Oo]ur)\\s+(?:friend|boss|colleague|neighbou?r|wife|husband|son|daughter|mother|father|mom|mum|dad|brother|sister|partner|girlfriend|boyfriend|teacher|doctor|client|cousin|aunt|uncle|grandma|grandpa)\\s+${NAME}`, 'gu'),
  new RegExp(`${L}(?:${eitherCase('annem|babam|eşim|kocam|karım|oğlum|kızım|kardeşim|ablam|abim|dedem|ninem|teyzem|halam|amcam|dayım|arkadaşım|sevgilim|patronum|komşum|müdürüm|hocam|doktorum')})\\s+${NAME}`, 'gu'),
  new RegExp(`${L}(?:named|called|${eitherCase('adı|ismi')})\\s+${NAME}`, 'gu'),
  new RegExp(`${NAME}\\s+(?:adında|adlı|isimli)${R}`, 'gu'),
  new RegExp(`${L}(?:Dear|Sevgili|Değerli)\\s+${NAME}`, 'gu'),
];

const ADDRESS: RegExp[] = [
  /\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St\.|Avenue|Ave\.|Road|Rd\.|Lane|Ln\.|Boulevard|Blvd\.?|Drive|Dr\.)(?=\W|$)/g,
  new RegExp(`${L}(?:sokak|sokağı|sk\\.?|cadde|caddesi|cad\\.?|bulvarı|mahallesi|mah\\.?)\\s*(?:no\\s*[:.]?\\s*)?\\d+(?:\\s*/\\s*\\d+)?`, 'giu'),
  new RegExp(`${L}(?:daire|kat|apt\\.?|apartmanı|flat|apartment)\\s*[:.]?\\s*\\d+`, 'giu'),
];

const BIRTH = new RegExp(`${L}(?:born on|date of birth|dob|doğum tarihi(?:m)?|doğum günüm|doğdum)\\s*[:]?\\s*\\d{1,4}[./ -]\\d{1,2}(?:[./ -]\\d{1,4})?`, 'giu');

const FILES: RegExp[] = [
  /(?:~|\/Users|\/home|[A-Z]:\\Users)[\\/][^\s"'<>]+/g,                                   // a path on someone's own disk
  /\b[\w-]+\.(?:jpe?g|png|heic|webp|pdf|docx?|xlsx?|csv|pptx?|mov|mp4|m4a|txt|eml)\b/gi,
  words('my (?:photos?|pictures?|files?|documents?|diary|journal|messages|e-?mails|inbox|notes|contacts|calendar|gallery|camera roll|recordings?)'),
  words('fotoğraflarım\\p{L}*|resimlerim\\p{L}*|dosyalarım\\p{L}*|belgelerim\\p{L}*|günlüğüm\\p{L}*|mesajlarım\\p{L}*|e-?postalarım\\p{L}*|notlarım\\p{L}*|rehberim\\p{L}*|galerim\\p{L}*|takvimim\\p{L}*'),
];

const CONFIDENTIAL = words('confidential|do not share|don\'t share|internal only|top secret|under nda|gizlidir|gizli tut\\p{L}*|kimseyle paylaşma\\p{L}*|paylaşmayın|sır olarak');

// first person, a close relative, a name: the health or money word is about someone, not a topic
const ANCHOR_EN = /(?<![\p{L}'’])(?:i|i'm|i’m|i've|i’ve|i'd|i’d|me|my|mine|myself|we|our|ours|we're|we’re)(?![\p{L}'’])/iu;
const ANCHOR_TR = words('ben|benim|bana|beni|bende|benden|kendim\\p{L}*|biz|bizim|bize|annem\\p{L}*|babam\\p{L}*|eşim\\p{L}*|kocam\\p{L}*|karım\\p{L}*|oğlum\\p{L}*|kızım\\p{L}*|kardeşim\\p{L}*|ablam\\p{L}*|abim\\p{L}*|dedem\\p{L}*|ninem\\p{L}*|anneannem\\p{L}*|babaannem\\p{L}*|teyzem\\p{L}*|halam\\p{L}*|amcam\\p{L}*|dayım\\p{L}*|arkadaşım\\p{L}*|sevgilim\\p{L}*|çocuğum\\p{L}*|bebeğim\\p{L}*', 'iu');
// a turkish word whose ending says "my" or "I am", the stem's ending taken off: kanser-im, kira-m,
// borc-umu, hastalı-ğım, ilaç-larım, hasta-yım, depresyon-dayım, şeker hastası-yım
const FIRST_PERSON_TAIL = /^(?:ğ?[ıiuü]?m|l[ae]r[ıi]m)(?:[ıiuü]z)?(?:[ıiuü]|y[ıiuü]|[ae]|y[ae]|d[ae]|t[ae]|d[ae]n|t[ae]n|[ıiuü]n|n[ıiuü]n|l[ae]|l[ae]r)?$|^(?:y[ıiuü]m|y[ıiuü]z|[dt][ae]y[ıiuü]m|s[ıiuü]y[ıiuü]m)$/u;

const HEALTH_EN = "diagnos\\w*|diabet\\w*|cancer|tumou?rs?|(?<!great )depress(?:ion|ed)|anxiety|panic attacks?|adhd|autism|bipolar|schizophreni\\w*|medications?|prescri(?:ption|bed)\\w*|dosage|blood (?:test|pressure|sugar)|lab results|mri|x-rays?|therap(?:y|ist)|psychiatr\\w*|pregnan\\w*|miscarriage|abortion|hiv|hepatitis|stds?|surgery|chemo\\w*|insulin|antidepressants?|symptoms?|allerg\\w*|asthma|epilep\\w*|migraines?|cholesterol|illness|disease|sick|hospital|clinic|doctor";
const HEALTH_TR = 'diyabet|şeker hastalı|şeker hastası|kanser|tümör|depresyon|anksiyete|panik atak|bipolar|şizofreni|ilaç|ilac|reçete|tahlil|teşhis|tedavi|terapi|psikiyatr|psikolog|hamile|gebelik|kürtaj|ameliyat|kemoterapi|insülin|antidepresan|tansiyon|kolesterol|migren|astım|epilepsi|alerji|hepatit|hastalı|hasta|hastane|doktor|muayene|semptom|belirti';
const MONEY_EN = 'salary|salaries|wages?|paycheck|payslip|debts?|loans?|mortgage|credit score|bank account|bank statement|savings|tax return|income|rent|invoices?|pension|net worth|credit card bill';
const MONEY_TR = 'maaş|borç|borc|kredi|banka hesab|hesap özeti|birikim|vergi|gelir|kira|fatura|emekli|ipotek|harcama|aidat';

/** health or money words that are about the person (anchored); `topic` gives the unanchored ones instead */
function aboutSomeone(en: string, tr: string, topic: boolean): Finder {
  const reEn = new RegExp(`\\b(?:${en})\\b`, 'gi');
  const reTr = new RegExp(`${L}(?:${tr})(\\p{L}*)`, 'giu');
  return (text) => {
    const out: Span[] = [];
    const people = PERSON.flatMap((re) => all(re, text));
    const sentenceOf = (at: number): [number, number] => {
      const a = Math.max(text.lastIndexOf('.', at - 1), text.lastIndexOf('!', at - 1), text.lastIndexOf('?', at - 1), text.lastIndexOf('\n', at - 1)) + 1;
      const ends = ['.', '!', '?', '\n'].map((c) => text.indexOf(c, at)).filter((i) => i >= 0);
      return [a, ends.length ? Math.min(...ends) : text.length];
    };
    const anchored = (a: number, b: number, tail: string): boolean => {
      if (tail && FIRST_PERSON_TAIL.test(tail)) return true;
      const [x, y] = sentenceOf(a);
      const s = text.slice(x, y);
      return ANCHOR_EN.test(s) || ANCHOR_TR.test(s) || people.some(([p, q]) => p < y && x < q);
    };
    for (const m of text.matchAll(reEn)) { const a = m.index!, b = a + m[0].length; if (anchored(a, b, '') !== topic) out.push([a, b]); }
    for (const m of text.matchAll(reTr)) {
      const a = m.index!, b = a + m[0].length;
      if (anchored(a, b, m[1] ?? '') !== topic) out.push([a, b]);
    }
    return out;
  };
}

// pasted source code: a fence, or two lines that read like code
const CODE_LINE = /^\s*(?:(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(|def\s+\w+\s*\(|class\s+\w+[\s:({]|import\s+[\w{*]|from\s+\S+\s+import\s|#include\s*<|(?:const|let|var)\s+\w+\s*=|(?:public|private|static)\s+\w+|return\s+[^;]*;|\}\s*(?:else\b.*)?$|.*\)\s*\{\s*$|.*=>\s*\{?\s*$)/;
const findCode: Finder = (t) => {
  const fences = all(/```[\s\S]*?(?:```|$)/g, t);
  if (fences.length) return fences;
  const lines: Span[] = [];
  let at = 0;
  for (const line of t.split('\n')) { if (CODE_LINE.test(line)) lines.push([at, at + line.length]); at += line.length + 1; }
  return lines.length >= 2 ? lines : [];
};

const WORK = words("my company|our company|my startup|our startup|my clients?|our clients?|my customers?|our customers?|my employer|our team's|our roadmap|our revenue|şirketim\\p{L}*|şirketimiz\\p{L}*|müşterilerim\\p{L}*|müşterilerimiz\\p{L}*|iş yerim\\p{L}*|ekibimiz\\p{L}*|cirom\\p{L}*|ciromuz\\p{L}*");

const INJECTION: RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+|your\s+)*(?:previous|prior|above|earlier|preceding|system)\s+(?:instructions?|prompts?|rules|messages?)/gi,
  /\b(?:reveal|print|show|repeat)\s+(?:me\s+)?(?:your|the)\s+(?:system\s+prompt|hidden\s+instructions|instructions)\b/gi,
  /\byou are now\s+(?:in\s+)?(?:dan|developer mode|jailbroken|an? unrestricted)/gi,
  /\b(?:do anything now|jailbreak(?:ed)?|developer mode enabled)\b/gi,
  /<\/?(?:system|im_start|im_end)\b[^>]*>/gi,
  words('önceki (?:tüm )?(?:talimatları|komutları|yönergeleri|kuralları) (?:unut|yok say|görmezden gel|dikkate alma)\\p{L}*'),
  words('sistem (?:istemini|promptunu|talimatlarını) (?:göster|yaz|söyle)\\p{L}*'),
];

export interface Kind { kind: string; words: string; level: Level; find: Finder }

/** every kind, in the order a span is claimed: a span counts once, for the first kind that finds it */
export const KINDS: Kind[] = [
  { kind: 'email', words: 'an e-mail address', level: 'private', find: emails },
  { kind: 'iban', words: 'an iban', level: 'private', find: (t) => all(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/gi, t, ibanOk) },
  { kind: 'card', words: 'a card number', level: 'private', find: (t) => all(/\b\d(?:[ -]?\d){12,18}\b/g, t, (m) => luhn(digits(m))) },
  { kind: 'tckn', words: 'a turkish id number', level: 'private', find: (t) => all(/\b[1-9]\d{10}\b/g, t, tcknOk) },
  {
    kind: 'phone', words: 'a phone number', level: 'private',
    find: (t) => [
      ...all(/(?:\+|\b00|\b0)\d[\d ().-]{6,}\d\b/g, t, (m) => { const n = digits(m).length; return n >= 10 && n <= 15; }),
      ...all(/(?<![\d+])\(\d{3}\)\s?\d{3}[-.\s]\d{4}\b/g, t),
      ...all(/\b\d{3}[-.]\d{3}[-.]\d{4}\b/g, t),
      ...all(/(?<![\d+])\b5\d{2} ?\d{3} ?\d{2} ?\d{2}\b/g, t),                  // a turkish mobile without its 0
    ],
  },
  { kind: 'secret', words: 'a password, key or token', level: 'private', find: (t) => [...SECRETS.flatMap((re) => all(re, t)), ...all(RANDOMISH, t, randomish)] },
  { kind: 'address', words: 'a street address', level: 'private', find: (t) => ADDRESS.flatMap((re) => all(re, t)) },
  { kind: 'birth', words: 'a birth date', level: 'private', find: (t) => all(BIRTH, t) },
  { kind: 'person', words: 'a named person', level: 'private', find: (t) => PERSON.flatMap((re) => all(re, t)) },
  { kind: 'files', words: 'your own files or photos', level: 'private', find: (t) => FILES.flatMap((re) => all(re, t)) },
  { kind: 'confidential', words: 'something marked confidential', level: 'private', find: (t) => all(CONFIDENTIAL, t) },
  { kind: 'health', words: 'your own health', level: 'private', find: aboutSomeone(HEALTH_EN, HEALTH_TR, false) },
  { kind: 'money', words: 'your own money', level: 'private', find: aboutSomeone(MONEY_EN, MONEY_TR, false) },
  { kind: 'health-topic', words: 'a health topic', level: 'circle-ok', find: aboutSomeone(HEALTH_EN, HEALTH_TR, true) },
  { kind: 'code', words: 'pasted code', level: 'circle-ok', find: findCode },
  { kind: 'work', words: 'your own company or clients', level: 'circle-ok', find: (t) => all(WORK, t) },
];
const KIND_BY = new Map(KINDS.map((k) => [k.kind, k]));
export const kindWords = (kind: string): string => (kind === 'injection' ? 'text that tries to give the model new orders' : KIND_BY.get(kind)?.words ?? kind);


// a secret is claimed first (a password in a url is a secret, not an e-mail address); the answer
// keeps KINDS order
const CLAIM = [KINDS.find((k) => k.kind === 'secret')!, ...KINDS.filter((k) => k.kind !== 'secret')];

/** the kinds found in a text, in KINDS order; a span counts once, for the first kind that claims it */
export function kindsIn(text: string): string[] {
  const taken: Span[] = [];
  const found = new Set<string>();
  for (const k of CLAIM) {
    const spans = k.find(text).filter(([a, b]) => !taken.some(([x, y]) => a < y && x < b));
    if (spans.length) { found.add(k.kind); taken.push(...spans); }
  }
  return KINDS.filter((k) => found.has(k.kind)).map((k) => k.kind);
}

/** does the text try to give the model new orders (pasted from a page, a mail, a file) */
export const injection = (text: string): boolean => INJECTION.some((re) => all(re, text).length > 0);

export interface Sense {
  level: Level;
  kinds: string[];      // what made it so, kind names in KINDS order
  flags: string[];      // 'injection': a look-again that is not about privacy
}

/** a text's level, its kinds and its flags */
export function sense(text: string): Sense {
  const t = String(text ?? '');
  const kinds = kindsIn(t);
  return { level: strictest(kinds.map((k) => KIND_BY.get(k)!.level)), kinds, flags: injection(t) ? ['injection'] : [] };
}

/** the private kinds only (what review called personal data before the rings) */
export const privateKinds = (text: string): string[] => kindsIn(text).filter((k) => KIND_BY.get(k)!.level === 'private');

/** the text with everything any kind finds replaced by "…" */
export function masked(text: string): string {
  const spans = KINDS.flatMap((k) => k.find(text)).sort((a, b) => a[0] - b[0]);
  let out = '', at = 0;
  for (const [a, b] of spans) {
    if (b <= at) continue;
    out += text.slice(at, Math.max(a, at)) + (a >= at ? '…' : '');
    at = b;
  }
  return out + text.slice(at);
}

// ---- pieces: what of a job could go further than the whole of it

const ABBREV = /(?:^|[\s(])(?:dr|mr|mrs|ms|prof|doç|av|st|no|nr|vs|etc|e\.g|i\.e|örn|bkz|yy|sn)\.$/iu;

/** where a text could be cut into pieces of work: blank lines, list items, then sentences (not
 *  after "Dr." or "No."); a code fence stays whole. Spans, so that each piece can be held against
 *  what the whole text holds. */
export function pieceSpans(text: string): Span[] {
  const t = String(text ?? '');
  const fences = all(/```[\s\S]*?(?:```|$)/g, t);
  const inFence = (i: number) => fences.some(([a, b]) => i > a && i < b);
  const cuts = new Set<number>([0, t.length]);
  for (const [a, b] of fences) { cuts.add(a); cuts.add(b); }
  for (const m of t.matchAll(/\n\s*\n|\n(?=\s*(?:[-*•]|\d+[.)])\s)/g)) if (!inFence(m.index!)) cuts.add(m.index!);
  for (const m of t.matchAll(/[.!?…]\s+(?=[\p{Lu}\d"“'(])/gu)) {
    const at = m.index! + 1;
    if (inFence(at) || ABBREV.test(t.slice(Math.max(0, at - 6), at))) continue;
    cuts.add(at);
  }
  const at = [...cuts].sort((a, b) => a - b);
  const out: Span[] = [];
  for (let i = 0; i + 1 < at.length; i++) {
    let a = at[i], b = at[i + 1];
    while (a < b && /\s/.test(t[a])) a++;
    while (b > a && /\s/.test(t[b - 1])) b--;
    if (b > a) out.push([a, b]);
  }
  return out;
}

/** the pieces themselves (the tests read them; one day a runner may send them) */
export const pieces = (text: string): string[] => pieceSpans(text).map(([a, b]) => text.slice(a, b));

export interface Parts { total: number; world: number; circle: number; home: number }

/** how many pieces of a text each ring could take: world counts the world-ok ones, circle adds the
 *  circle-ok ones, home is every piece. A piece is judged on its own and against the whole text (a
 *  name found across a cut holds back both sides); one that gives the model orders goes nowhere
 *  further. The pieces are counted, never kept. */
export function parts(text: string): Parts {
  const t = String(text ?? '');
  const whole = KINDS.flatMap((k) => k.find(t).map(([a, b]) => ({ a, b, level: k.level })));
  const ps = pieceSpans(t);
  let world = 0, circle = 0;
  for (const [a, b] of ps) {
    const s = sense(t.slice(a, b));
    if (s.flags.length) continue;
    const level = strictest([s.level, ...whole.filter((x) => x.a < b && a < x.b).map((x) => x.level)]);
    if (level === 'world-ok') { world++; circle++; } else if (level === 'circle-ok') circle++;
  }
  return { total: ps.length, world, circle, home: ps.length };
}
