// The brain tab's pieces render (components/brain/*.tsx): the figure with every node state and
// a "+k" place, the share bar, the timeline (folded and opened), the ledger tiles, the night
// ring, an empty place; and each says its sentence to a screen reader.
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { describe, expect, it, jest } from '@jest/globals';

jest.mock('expo-sqlite/kv-store', () => ({ __esModule: true, default: { getItemSync: () => null, setItemSync: () => {}, removeItemSync: () => {} } }));
// the words in english, without the auth context the real provider sits in
jest.mock('@/i18n', () => {
  const core = jest.requireActual<typeof import('@/i18n/core')>('@/i18n/core');
  const v = { ...core.translator('en'), lang: 'en', setLang: () => {}, up: (s: string) => s.toUpperCase() };
  return { useLang: () => v, useT: () => v.t };
});
// reanimated's own mock (no native worklets in jest), with the one hook it leaves out
jest.mock('react-native-worklets', () => jest.requireActual('react-native-worklets/lib/module/mock'));
jest.mock('react-native-reanimated', () => {
  const mock = jest.requireActual<Record<string, unknown> & { default: unknown }>('react-native-reanimated/mock');
  return { ...mock, __esModule: true, default: mock.default, useReducedMotion: () => false };
});

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import BrainFigure, { type FigureNode } from '@/components/brain/BrainFigure';
import Empty from '@/components/brain/Empty';
import Ledger from '@/components/brain/Ledger';
import Night from '@/components/brain/Night';
import Now from '@/components/brain/Now';
import Timeline from '@/components/brain/Timeline';
import { group } from '@/components/brain/grouping';
import type { BrainEntry } from '@/llm/brainlog';

const render = (el: React.ReactElement) => {
  let r: ReactTestRenderer | undefined;
  act(() => {
    r = create(el);
  });
  return r!;
};
// the labels on what is drawn (host elements), once each
const labels = (r: ReactTestRenderer) => r.root.findAll((n) => typeof n.type === 'string' && typeof n.props.accessibilityLabel === 'string').map((n) => n.props.accessibilityLabel as string);

describe('the brain tab pieces', () => {
  it('draws the figure with every state and folds many devices into "+k"', () => {
    const states = ['idle', 'busy', 'out', 'refused', 'saved'] as const;
    const peers: FigureNode[] = Array.from({ length: 11 }, (_, i) => ({ id: `p${i}`, name: `device number ${i}`, share: i / 10, state: states[i % 5], badge: i % 2 ? 'verified' : 'none', kind: i % 3 ? 'phone' : 'pc' }));
    const r = render(<BrainFigure center={{ id: 'me', name: 'this phone', share: 0.6, state: 'busy', badge: 'none' }} peers={peers} label="the whole cluster" />);
    expect(labels(r)).toContain('the whole cluster');
    expect(JSON.stringify(r.toJSON())).toContain('+4');
  });

  it('shows the speed, the bar and the devices', () => {
    const r = render(<Now speed={12.5} together split={[{ name: 'Me', gb: 2 }, { name: 'Tab', gb: 1 }]} devices={[{ id: 'me', busy: true }, { id: 'tab', busy: false }]} loading={null} aloneFaster generating onChat={() => {}} />);
    const all = labels(r).join(' | ');
    expect(all).toContain('~12.5 tok/s');
    expect(all).toContain('1 of 2 devices busy');
    expect(all).toContain('me 2 gb, tab 1 gb');
  });

  it('folds the timeline and opens a row on a tap', () => {
    const e = (at: number, p: Partial<BrainEntry>): BrainEntry => ({ at, kind: 'unit', key: 'brain.unit', vars: { device: 'a', n: 2, tokens: 10, right: 1 }, tone: 'ok', ...p });
    const groups = group([e(3, {}), e(2, { vars: { device: 'b', n: 1, tokens: 5, right: 0 } }), e(1, { kind: 'plan', key: 'brain.plan.alone', vars: { model: 'qwen' }, tone: 'info' })]);
    const r = render(<Timeline groups={groups} />);
    const text = () => JSON.stringify(r.toJSON());
    expect(text()).toContain('2 devices · 3 units · 15 tokens');
    expect(text()).toContain('qwen · alone');
    expect(labels(r)[0]).toContain('a: 2 units done');
    const row = r.root.findAll((n) => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')[0];
    act(() => row.props.onPress());
    expect(text()).toContain('a: 2 units done · 10 tokens · 1 known answers right');
  });

  it('shows the ledger tiles and the chain, the night ring, an empty place', () => {
    const l = render(<Ledger tiles={[{ n: 2, label: 'refused', color: '#c00', spark: [0, 1, 1] }]} chain={{ ok: false, text: 'chain broken', a11y: 'chain broken at line 3' }} />);
    expect(labels(l)).toEqual(['2 refused in the ledger, 2 in the last 24 hours', 'chain broken at line 3']);
    const n = render(<Night frac={0.4} color="#0a0" center="12" centerLabel="units" status="working" window="23:00–07:30" chips={['3 units']} noReport={null} a11y="working, the night window" />);
    expect(labels(n)).toEqual(['working, the night window']);
    const m = render(<Night frac={0} color="#999" center={null} centerLabel="" status="not working now" window="23:00–07:30" chips={[]} noReport="no morning report yet" a11y="idle" />);
    expect(JSON.stringify(m.toJSON())).toContain('no morning report yet');
    const x = render(<Empty kind="decisions" text="no decisions yet" a11y="the long sentence" />);
    expect(labels(x)).toEqual(['the long sentence']);
  });
});
