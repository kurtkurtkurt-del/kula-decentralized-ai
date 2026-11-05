// What the model writes, made ready to speak (voice/text.ts): think blocks and markdown out,
// sentences out as soon as they end while the tokens stream in.
import { describe, expect, it } from '@jest/globals';
import { cap, Chunker, sentences, speakable, stripThink } from '@/voice/text';

describe('stripThink', () => {
  it('drops closed and unclosed think blocks', () => {
    expect(stripThink('<think>hmm, the user wants…</think>Hello there.')).toBe('Hello there.');
    expect(stripThink('Hi.<think>still thinking')).toBe('Hi.');
    expect(stripThink('reasoning without opening</think>Answer.')).toBe('Answer.');
    expect(stripThink('plain')).toBe('plain');
  });
});

describe('speakable', () => {
  it('turns markdown into plain words', () => {
    expect(speakable('**Sure!** Here is _one_ idea: `run`.')).toBe('Sure! Here is one idea: run.');
    expect(speakable('# Title\nSome text')).toBe('Title\nSome text');
    expect(speakable('- milk\n- bread\n- eggs')).toBe('milk.\nbread.\neggs.');
    expect(speakable('1. first\n2) second.')).toBe('first.\nsecond.');
    expect(speakable('see [the docs](https://x.y/z) or https://a.b/c')).toBe('see the docs or');
    expect(speakable('code:\n```js\nlet x = 1;\n```\ndone')).toBe('code:\ndone');
    expect(speakable('> quoted 😀 text 🎉')).toBe('quoted text');
    expect(speakable('<think>a</think>**Merhaba** dünya.')).toBe('Merhaba dünya.');
  });
});

describe('sentences', () => {
  it('splits at sentence ends, not inside numbers or abbreviations', () => {
    expect(sentences('Hello. How are you? Fine!')).toEqual(['Hello.', 'How are you?', 'Fine!']);
    expect(sentences('Meet at 18.30 today. Bring Dr. Kaya.')).toEqual(['Meet at 18.30 today.', 'Bring Dr. Kaya.']);
    expect(sentences('Bu toplantı z.B. morgen. Gut.')).toEqual(['Bu toplantı z.B. morgen.', 'Gut.']);
    expect(sentences('Line one\nLine two')).toEqual(['Line one', 'Line two']);
    expect(sentences('No end yet')).toEqual(['No end yet']);
    expect(sentences('Wow!! Really?" Yes.')).toEqual(['Wow!!', 'Really?"', 'Yes.']);
  });
  it('cuts a very long sentence at a comma or a space', () => {
    const long = `${'word '.repeat(40)}, ${'more '.repeat(40)}`.trim();
    const parts = cap(long, 120);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((x) => x.length <= 120)).toBe(true);
    expect(parts.join(' ').replace(/\s+/g, ' ')).toBe(long.replace(/\s+/g, ' '));
  });
});

describe('Chunker', () => {
  const feed = (tokens: string[]) => {
    const c = new Chunker();
    const out: string[][] = tokens.map((t) => c.push(t));
    return { out, end: c.end(), c };
  };

  it('hands out each sentence once it ends, the rest at the end', () => {
    const { out, end } = feed(['Hel', 'lo there', '. How', ' are', ' you', '? I am', ' fine'] );
    expect(out.flat()).toEqual(['Hello there.', 'How are you?']);
    // "Hello there." is only known complete when the space after it arrives
    expect(out[2]).toEqual(['Hello there.']);
    expect(end).toEqual(['I am fine']);
  });

  it('holds back a think block and drops it', () => {
    const { out, end } = feed(['<thi', 'nk>', 'Let me think. ', 'Okay.', '</think>', '\n\nYarın 18:00. ', 'Tamam mı?']);
    expect([...out.flat(), ...end]).toEqual(['Yarın 18:00.', 'Tamam mı?']);
  });

  it('strips markdown per sentence and keeps the screen text', () => {
    const { out, end, c } = feed(['**Sure.** ', 'Here:\n', '- one\n', '- two']);
    expect([...out.flat(), ...end]).toEqual(['Sure.', 'Here:', 'one.', 'two.']);
    expect(c.text()).toBe('Sure. Here:\none.\ntwo.');
  });

  it('speaks a long run-on without punctuation in pieces', () => {
    const c = new Chunker(100);
    const got: string[] = [];
    for (let i = 0; i < 60; i++) got.push(...c.push('word '));
    expect(got.length).toBeGreaterThan(0);
    got.push(...c.end());
    expect(got.join(' ').split(' ').filter(Boolean).length).toBe(60);
  });

  it('nothing at all gives nothing', () => {
    expect(feed(['<think>only thoughts</think>']).end).toEqual([]);
  });
});
