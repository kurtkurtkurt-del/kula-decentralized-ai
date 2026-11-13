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
import { BRANCHES, dark, type EyeCard, type EyeView } from '@godseye/core';
import { EyeCards, EyeGrid, sayWord, toneOf } from '@/components/brain/Eye';

const render = (el: React.ReactElement) => {
  let r: ReactTestRenderer | undefined;
  act(() => {
    r = create(el);
  });
  return r!;
};
const labels = (r: ReactTestRenderer) => r.root.findAll((n) => typeof n.type === 'string' && typeof n.props.accessibilityLabel === 'string').map((n) => n.props.accessibilityLabel as string);

const card = (o: Partial<EyeCard> = {}): EyeCard => ({ id: 'advisor:x', kind: 'suggest', title: 'try qwen here', why: 'it fits', action: { do: 'load', model: 'qwen', mode: 'here', devices: [] }, weight: 2, branch: 'advisor', since: 1, ...o });
const view: EyeView = {
  at: 1,
  branches: BRANCHES.map((m) => ({ ...(m.id === 'review' ? dark() : { ...dark(), built: true, stat: `${m.id} words`, gauge: 50 }), ...m, ...(m.id === 'executor' ? { error: 'boom' } : {}) })),
  cards: [card({ id: 'limits:hot', kind: 'warn', branch: 'limits', action: null, title: 'pixel is hot', why: 'cool it' })],
  events: [],
  box: null,
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

  it('a card: the phone\'s button when it can, "only the computer" when it cannot, a dismiss always; a tap says what it did', async () => {
    const applied: string[] = [];
    const dismissed: string[] = [];
    const cards = [card(), card({ id: 'advisor:mac', title: 'on the mac' })];
    const r = render(<EyeCards cards={cards} actOf={(c) => (c.id === 'advisor:x' ? { kind: 'load' } : null)} apply={async (id) => { applied.push(id); return 'looked again: 1 answered, 2 did not'; }} dismiss={(id) => dismissed.push(id)} />);
    const text = JSON.stringify(r.toJSON());
    expect(text).toContain('yükle');
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

  it('a tap that says nothing, or only "opened", says done', async () => {
    for (const word of ['', 'opened']) {
      const r = render(<EyeCards cards={[card()]} actOf={() => ({ kind: 'load' })} apply={async () => word} dismiss={() => {}} />);
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
