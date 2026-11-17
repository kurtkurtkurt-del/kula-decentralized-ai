// god's eye on the brain tab (11.11.2026, components/brain/Eye.tsx): the twelve drawn with their
// names in the reader's language and the branches' own words, a tap opens a page, and a card shows
// the phone's button only when the phone can carry it out.
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { describe, expect, it, jest } from '@jest/globals';

jest.mock('expo-sqlite/kv-store', () => ({ __esModule: true, default: { getItemSync: () => null, setItemSync: () => {}, removeItemSync: () => {} } }));
jest.mock('@/i18n', () => {
  const core = jest.requireActual<typeof import('@/i18n/core')>('@/i18n/core');
  const v = { ...core.translator('tr'), lang: 'tr', setLang: () => {}, up: (s: string) => s.toUpperCase() };
  return { useLang: () => v, useT: () => v.t };
});

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { BRANCHES, dark, type EyeCard, type EyeView, type SuggestAction } from '@godseye/core';
import { EyeCards, EyeGrid, sayWord, toneOf } from '@/components/brain/Eye';

const render = (el: React.ReactElement) => {
  let r: ReactTestRenderer | undefined;
  act(() => {
    r = create(el);
  });
  return r!;
};
const labels = (r: ReactTestRenderer) => r.root.findAll((n) => typeof n.type === 'string' && typeof n.props.accessibilityLabel === 'string').map((n) => n.props.accessibilityLabel as string);

const card = (o: Partial<EyeCard> = {}): EyeCard => ({ id: 'advisor:x', kind: 'suggest', title: 'try qwen here', why: 'it fits', action: { do: 'load', model: 'qwen', mode: 'here', devices: [] }, weight: 2, branch: 'advisor', since: 1, change: true, confirm: false, ...o });
const view: EyeView = {
  at: 1,
  branches: BRANCHES.map((m) => ({ ...(m.id === 'review' ? dark() : { ...dark(), built: true, stat: `${m.id} words`, gauge: 50 }), ...m, ...(m.id === 'executor' ? { error: 'boom' } : {}) })),
  cards: [card({ id: 'limits:hot', kind: 'warn', branch: 'limits', action: null, title: 'pixel is hot', why: 'cool it', change: false })],
  events: [],
  box: null,
  undo: null,
};

describe('the twelve on the brain tab', () => {
  it('draws twelve tiles, in turkish, with each branch\'s words, its stop or its darkness, and opens a page on a tap', () => {
    const opened: string[] = [];
    const r = render(<EyeGrid view={view} onOpen={(id) => opened.push(id)} />);
    const l = labels(r);
    expect(l).toHaveLength(12);
    expect(l[0]).toBe('1. duyular: senses words');
    expect(l).toContain('7. yürütücü: durdu: boom');
    expect(l).toContain('11. istek incelemesi: henüz kurulmadı');
    act(() => {
      r.root.findAll((n) => n.props.accessibilityLabel === '9. sınırlar: limits words' && typeof n.props.onPress === 'function')[0].props.onPress();
    });
    expect(opened).toEqual(['limits']);
    expect(toneOf(view.branches[8], view.cards)).toBe('warn');
    expect(toneOf(view.branches[6], view.cards)).toBe('broken');
    expect(toneOf(view.branches[10], view.cards)).toBe('dark');
    expect(toneOf(view.branches[0], view.cards)).toBe('ok');
  });

  it('waits for the first look', () => {
    expect(JSON.stringify(render(<EyeGrid view={null} onOpen={() => {}} />).toJSON())).toContain('ilk bakış birazdan geliyor');
  });

  it('a look card: the phone\'s button when it can, "only the computer" when it cannot, a dismiss always, no accept or reject; a tap says what it did', async () => {
    const applied: string[] = [];
    const dismissed: string[] = [];
    const probe: SuggestAction = { do: 'probe', devices: ['p1'] };
    const cards = [card({ change: false, action: probe }), card({ change: false, action: probe, id: 'advisor:mac', title: 'on the mac' })];
    const r = render(<EyeCards cards={cards} actOf={(c) => (c.id === 'advisor:x' ? { kind: 'probe' } : null)} apply={async (id) => { applied.push(id); return 'looked again: 1 answered, 2 did not'; }} reject={() => true} dismiss={(id) => dismissed.push(id)} />);
    const text = JSON.stringify(r.toJSON());
    expect(text).toContain('yeniden bak');
    expect(text).not.toContain('kabul et');
    expect(text).not.toContain('reddet');
    expect(text).toContain('bunu yalnızca bilgisayar yapabilir');
    expect(text).toContain('danışman dalından');
    // the buttons, each once (a press handler shows on more than one layer of the tree)
    const presses = () => [...new Set(r.root.findAll((n) => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function').map((n) => n.props.onPress as () => void))].map((onPress) => ({ props: { onPress } }));
    expect(presses()).toHaveLength(3);   // one apply, two dismiss
    await act(async () => {
      presses()[0].props.onPress();
    });
    expect(applied).toEqual(['advisor:x']);
    expect(JSON.stringify(r.toJSON())).toContain('looked again: 1 answered, 2 did not');
    act(() => {
      presses()[2].props.onPress();
    });
    expect(dismissed).toEqual(['advisor:mac']);
  });

  it('a change card the phone can carry out: what accept does in the reader\'s words, then accept, reject and the quiet dismiss; accept applies, reject rejects', async () => {
    const applied: string[] = [];
    const rejected: unknown[] = [];
    const dismissed: string[] = [];
    const shown: SuggestAction = { do: 'load', model: 'qwen', mode: 'here', devices: [] };
    const c = card({ action: shown, does: 'Loads qwen on this computer alone; undo unloads it.' });
    const r = render(<EyeCards cards={[c]} actOf={() => ({ kind: 'load', does: { key: 'alone', vars: { model: 'Qwen' } } })} apply={async (id) => { applied.push(id); return 'loaded Qwen (alone)'; }} reject={(id, a) => { rejected.push([id, a]); return true; }} dismiss={(id) => dismissed.push(id)} />);
    const text = JSON.stringify(r.toJSON());
    // the phone's own sentence: this phone, no undo (the computer's sentence is not shown)
    expect(text).toContain('Qwen yalnızca bu telefona yüklenir.');
    expect(text).not.toContain('this computer');
    expect(text).not.toContain('yükle"');   // accept, not the old 'load' word
    const buttons = () => r.root.findAll((n) => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function');
    const press = (word: string) => [...new Set(buttons().filter((n) => n.findAll((k) => k.props.children === word).length > 0).map((n) => n.props.onPress as () => void))];
    expect(press('kabul et')).toHaveLength(1);
    expect(press('reddet')).toHaveLength(1);
    expect(press('kapat')).toHaveLength(1);
    act(() => {
      press('reddet')[0]();
    });
    expect(rejected).toEqual([['advisor:x', shown]]);
    expect(applied).toEqual([]);
    await act(async () => {
      press('kabul et')[0]();
    });
    expect(applied).toEqual(['advisor:x']);
    expect(JSON.stringify(r.toJSON())).toContain('loaded Qwen (alone)');
    act(() => {
      press('kapat')[0]();
    });
    expect(dismissed).toEqual(['advisor:x']);
  });

  it('a reject the eye no longer takes (the card changed or went) says so', () => {
    const r = render(<EyeCards cards={[card()]} actOf={() => ({ kind: 'load' })} apply={async () => ''} reject={() => false} dismiss={() => {}} />);
    const reject = r.root.findAll((n) => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function' && n.findAll((k) => k.props.children === 'reddet').length > 0)[0];
    act(() => {
      reject.props.onPress();
    });
    expect(JSON.stringify(r.toJSON())).toContain('kart değişti, yeniden bak');
  });

  it('a cap, anchor or cancel card: "only the computer can do this one", no accept, the computer\'s sentence, and reject still works', () => {
    const actions: SuggestAction[] = [
      { do: 'cap', gb: 4, from: 2 },
      { do: 'anchor', on: true },
      { do: 'cancel', project: 'n1' },
    ];
    for (const action of actions) {
      const rejected: string[] = [];
      const does = `the computer's words for ${action.do}`;
      const c = card({ id: `x:${action.do}`, action, does, confirm: action.do !== 'cap' });
      // a confirm card is the computer's even if something answered for it
      const r = render(<EyeCards cards={[c]} actOf={() => (action.do === 'cap' ? null : { kind: action.do })} apply={async () => ''} reject={(id) => { rejected.push(id); return true; }} dismiss={() => {}} />);
      const text = JSON.stringify(r.toJSON());
      expect(text).toContain('bunu yalnızca bilgisayar yapabilir');
      expect(text).toContain(does);
      expect(text).not.toContain('kabul et');
      const buttons = [...new Set(r.root.findAll((n) => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function').map((n) => n.props.onPress as () => void))];
      expect(buttons).toHaveLength(2);   // reject and dismiss
      act(() => {
        buttons[0]();
      });
      expect(rejected).toEqual([`x:${action.do}`]);
    }
  });

  it('a tap that says nothing, or only "opened", says done', async () => {
    for (const word of ['', 'opened']) {
      const r = render(<EyeCards cards={[card()]} actOf={() => ({ kind: 'load' })} apply={async () => word} reject={() => true} dismiss={() => {}} />);
      const apply = r.root.findAll((n) => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')[0];
      await act(async () => {
        apply.props.onPress();
      });
      expect(JSON.stringify(r.toJSON())).toContain('tamam');
    }
    expect(sayWord('  loaded Qwen (split)  ', 'done')).toBe('loaded Qwen (split)');
    expect(sayWord(7, 'done')).toBe('done');
    expect(sayWord('   ', 'done')).toBe('done');
    expect(sayWord('x'.repeat(200), 'done')).toHaveLength(120);
  });
});
