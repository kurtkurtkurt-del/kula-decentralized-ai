// What the model writes, made ready to be spoken (pure, no React Native).
//
// stripThink drops a reasoning model's <think>…</think> (qwen3); speakable turns markdown
// into plain sentences (no **, #, `code`, links as their words, lists as sentences, no
// emoji); Chunker takes the reply token by token and hands out whole sentences as soon as
// they end, so the phone starts speaking the first sentence while the model writes the next.

/** The text with every <think>…</think> removed; an unclosed one hides everything after it. */
export function stripThink(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  const open = out.indexOf('<think>');
  if (open >= 0) out = out.slice(0, open);
  // a closing tag without its opening (the opening was in the prompt template)
  const close = out.lastIndexOf('</think>');
  if (close >= 0) out = out.slice(close + 8);
  return out;
}

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{1F1E6}-\u{1F1FF}]/gu;

/** Markdown and decorations out, the words in. */
export function speakable(text: string): string {
  let s = stripThink(text);
  s = s.replace(/```[\s\S]*?```/g, ' '); // code blocks are not read aloud
  s = s.replace(/```[\s\S]*$/g, ' '); // an unfinished one neither
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  s = s.replace(/https?:\/\/\S+/g, ' ');
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/^\s*>\s?/gm, '');
  s = s.replace(/^\s*(?:[-*+•]|\d+[.)])\s+(.*)$/gm, (_, item: string) => (/[.!?:;…]$/.test(item.trim()) ? item : `${item}.`));
  s = s.replace(/^\s*[-*_]{3,}\s*$/gm, ' ');
  s = s.replace(/\|/g, ' ');
  s = s.replace(/(\*\*|__)(.+?)\1/g, '$2');
  s = s.replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,!?:;]|$)/g, '$1$2');
  s = s.replace(/[*#_~]{1,}/g, (m) => (m === '_' ? ' ' : ''));
  s = s.replace(EMOJI, '');
  s = s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n');
  return s.trim();
}

// a full stop after these is not the end of a sentence
const ABBR = new Set(['dr', 'mr', 'mrs', 'ms', 'prof', 'vs', 'etc', 'e.g', 'i.e', 'z.b', 'bzw', 'ca', 'nr', 'str', 'vb', 'örn', 'sn', 'av', 'no']);

/**
 * Where the first complete sentence in `s` ends (index after its punctuation), or -1. A
 * sentence ends at . ! ? … followed by space or a new line, or at a new line; not inside
 * a number (18.30, 3.5) and not after a known abbreviation or a single letter.
 */
export function sentenceEnd(s: string, from = 0): number {
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '\n') {
      if (s.slice(from, i).trim()) return i + 1;
      continue;
    }
    if (c !== '.' && c !== '!' && c !== '?' && c !== '…') continue;
    // take a run of punctuation and closing quotes/brackets: "wow!!" / "(yes.)"
    let j = i + 1;
    while (j < s.length && /[.!?…"'”’»)*_]/.test(s[j])) j++; // and a closing ** or _
    if (j >= s.length) return -1; // not known yet whether more follows
    if (!/\s/.test(s[j])) continue;
    if (c === '.') {
      const word = /([\p{L}.]+)$/u.exec(s.slice(from, i))?.[1] ?? '';
      // "dr. ozan", "z.b. morgen", an initial "j. smith"; "18.30" never gets here (no space)
      if (ABBR.has(word.toLowerCase()) || /^\p{Lu}$/u.test(word)) continue;
    }
    return j;
  }
  return -1;
}

/** Splits a text into sentences (pure; the last piece may not end in punctuation). */
export function sentences(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  for (;;) {
    const end = sentenceEnd(rest);
    if (end < 0) break;
    const piece = rest.slice(0, end).trim();
    if (piece) out.push(piece);
    rest = rest.slice(end);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

/** A long sentence cut at a comma or a space so no piece is longer than max. */
export function cap(sentence: string, max = 300): string[] {
  const out: string[] = [];
  let s = sentence.trim();
  while (s.length > max) {
    let cut = s.lastIndexOf(', ', max);
    if (cut < max / 3) cut = s.lastIndexOf(' ', max);
    if (cut < max / 3) cut = max;
    out.push(s.slice(0, cut + (s[cut] === ',' ? 1 : 0)).trim());
    s = s.slice(cut + 1).trim();
  }
  if (s) out.push(s);
  return out;
}

/**
 * Tokens in, speakable sentences out. push() returns the sentences completed by this token
 * (usually none, sometimes one); end() returns what is left. Everything inside <think> is
 * held back until it closes, and dropped.
 */
export class Chunker {
  private raw = '';
  private said = 0; // how much of the speakable text was already handed out
  constructor(private max = 300) {}

  private visible(): string {
    // hold back while a <think> is open, or while a tag may be starting at the very end
    const text = stripThink(this.raw);
    const lt = text.lastIndexOf('<');
    return lt >= 0 && lt > text.length - 9 && !text.slice(lt).includes('>') ? text.slice(0, lt) : text;
  }

  push(token: string): string[] {
    this.raw += token;
    return this.take(false);
  }

  end(): string[] {
    return this.take(true);
  }

  /** Everything spoken or to be spoken so far, as it would be read (for the screen). */
  text(): string {
    return speakable(this.raw);
  }

  private take(final: boolean): string[] {
    const text = final ? stripThink(this.raw) : this.visible();
    const rest = text.slice(this.said);
    const out: string[] = [];
    let used = 0;
    for (;;) {
      const end = sentenceEnd(rest, used);
      if (end < 0) break;
      const piece = speakable(rest.slice(used, end));
      used = end;
      if (piece) out.push(...cap(piece, this.max));
    }
    if (final) {
      const piece = speakable(rest.slice(used));
      used = rest.length;
      if (piece) out.push(...cap(piece, this.max));
    } else if (rest.length - used > this.max * 1.5) {
      // a run-on with no punctuation: speak what there is up to the last space
      const sp = rest.lastIndexOf(' ', used + this.max);
      if (sp > used) {
        const piece = speakable(rest.slice(used, sp));
        used = sp;
        if (piece) out.push(piece);
      }
    }
    this.said += used;
    return out;
  }
}
