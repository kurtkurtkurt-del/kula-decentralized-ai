// The brain tab's trust card renders (components/brain/Trust.tsx): the verdict word, the
// headline, a line per device, and the whole of it said to a screen reader.
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { describe, expect, it, jest } from '@jest/globals';

jest.mock('expo-sqlite/kv-store', () => ({ __esModule: true, default: { getItemSync: () => null, setItemSync: () => {}, removeItemSync: () => {} } }));
jest.mock('@/i18n', () => {
  const core = jest.requireActual<typeof import('@/i18n/core')>('@/i18n/core');
  const v = { ...core.translator('en'), lang: 'en', setLang: () => {}, up: (s: string) => s.toUpperCase() };
  return { useLang: () => v, useT: () => v.t };
});

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import Trust from '@/components/brain/Trust';
import { clusterReport, deviceReport, failed, hostCheck, takeIn } from '@/llm/trust';
import type { Peer } from '@/llm/store';

const render = (el: React.ReactElement) => {
  let r: ReactTestRenderer | undefined;
  act(() => {
    r = create(el);
  });
  return r!;
};
const peer = (id: string, name: string, o: Partial<Peer> = {}): Peer => ({ id, name, host: 'h', port: 1, secret: '', fp: 'f'.repeat(64), kind: 'phone', ram: null, bw: null, added_at: '', ...o });
const fine = takeIn(null, { id: 'a'.repeat(32), alg: 'p256', pub: 'p', store: 'keystore', cert: 'c', v1: false, self: 'ok', found: null, more: false, lines: ['x'], rejectsDay: {} },
  { certPinned: true, cnMatches: true, keyIdMatches: true, keyId: 'a'.repeat(32), verified: 1, lastHash: '1'.repeat(64), problem: null, problemLine: null }, null, 1);

describe('the trust card', () => {
  it('all clear: the word and the headline', () => {
    const r = render(<Trust report={clusterReport([deviceReport(peer('a', 'Pixel'), fine)], hostCheck(null))} self="this phone" />);
    const text = JSON.stringify(r.toJSON());
    expect(text).toContain('all clear');
    expect(text).toContain('1 device: every link pinned and encrypted, every ledger holds');
  });

  it('look at this: names what is wrong, device by device, and says it all', () => {
    const report = clusterReport([deviceReport(peer('a', 'Pixel'), fine), deviceReport(peer('b', 'Mac', { fp: null, secret: 's' }), fine), deviceReport(peer('c', 'Tab'), failed(null, 'no answer in time', 1))], hostCheck(null));
    const r = render(<Trust report={report} self="this phone" onPress={() => {}} />);
    const text = JSON.stringify(r.toJSON());
    expect(text).toContain('look at this');
    expect(text).toContain('older pairing');
    const label = r.root.findAll((n) => typeof n.type === 'string' && typeof n.props.accessibilityLabel === 'string')[0].props.accessibilityLabel as string;
    expect(label).toMatch(/^look at this\. mac: older pairing/);
    expect(label).toContain('tab: not checked yet');
    expect(label).toContain('pixel: all clear');
  });
});
