// "devices that can use this phone" (10.11.2026, docs/GATE.md "remove a device's access"): the
// words for the list, and the list itself: a remove asks first, removes only on yes, and the
// list after comes from the native side. The native side (Unpair.kt) is tested on the jvm
// (UnpairTest: the gate refuses a removed certificate, cuts its pipe, the ledger line).
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PairedDevice } from '@/llm/native';

const NOW = Date.now();
const A = 'a1'.repeat(32);
const B = 'b2'.repeat(32);
let mockList: PairedDevice[] = [];
const mockRemove = jest.fn(async (fp: string) => { mockList = mockList.filter((d) => d.fp !== fp); return mockList; });

jest.mock('@/i18n', () => {
  const core = jest.requireActual<typeof import('@/i18n/core')>('@/i18n/core');
  const v = { ...core.translator('en'), lang: 'en', setLang: () => {}, up: (s: string) => s.toUpperCase() };
  return { useLang: () => v, useT: () => v.t };
});
jest.mock('@/lib/haptics', () => ({ tapDone: () => {}, tapSelect: () => {} }));
jest.mock('@/llm/native', () => ({
  hasNative: () => true,
  llama: { pairedDevices: async () => mockList, removePaired: (fp: string) => mockRemove(fp) },
}));

import { Alert } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import PairedDevices from '@/components/PairedDevices';
import { agoOf, isConnected, pairedName, shortFp, withoutFps } from '@/llm/paired';
import { detailOf } from '@/llm/audit';

const dev = (o: Partial<PairedDevice>): PairedDevice => ({ fp: A, name: null, pairedAt: NOW - 3 * 86_400_000, lastSeen: null, address: null, computer: false, ...o });

describe('the words', () => {
  it('names a device by its name, else its short fingerprint', () => {
    expect(pairedName({ fp: A, name: 'Mac Studio' })).toBe('mac studio');
    expect(pairedName({ fp: A, name: '  ' })).toBe(shortFp(A));
    expect(shortFp(A)).toBe('a1a1a1a1 a1a1a1a1');
  });
  it('says how long ago', () => {
    expect(agoOf(NOW - 10_000, NOW)).toEqual({ key: 'comp.ago.now' });
    expect(agoOf(NOW - 5 * 60_000, NOW)).toEqual({ key: 'comp.ago.min', vars: { n: '5' } });
    expect(agoOf(NOW - 3 * 3600_000, NOW)).toEqual({ key: 'comp.ago.h', vars: { n: '3' } });
    expect(agoOf(NOW - 4 * 86_400_000, NOW)).toEqual({ key: 'comp.ago.d', vars: { n: '4' } });
  });
  it('the ledger page words a removal, not a battery', () => {
    const line = (fields: Record<string, unknown>) => ({ t: NOW, kind: 'health', peer: null, prev: '0'.repeat(64), sig: '', reject: null, warn: [], fields });
    expect(detailOf(line({ unpaired: A.slice(0, 16), name: 'mac' }))).toBe('access removed a1a1a1a1 (mac)');
    expect(detailOf(line({ batteryPct: 80, batteryC: 31, throttled: false }))).toBe('80% · 31°c');
  });
  it('knows the connected one by its address and leaves out what another list shows', () => {
    expect(isConnected({ address: '192.168.1.5' }, '192.168.1.5')).toBe(true);
    expect(isConnected({ address: null }, '192.168.1.5')).toBe(false);
    expect(isConnected({ address: '192.168.1.5' }, null)).toBe(false);
    expect(withoutFps([dev({ fp: A }), dev({ fp: B })], [A.toUpperCase()]).map((d) => d.fp)).toEqual([B]);
  });
});

const mounted: ReactTestRenderer[] = [];
async function mount(el: React.ReactElement) {
  let r: ReactTestRenderer | undefined;
  await act(async () => { r = create(el); });
  mounted.push(r!);
  await act(async () => { await new Promise((res) => setTimeout(res, 10)); });
  return r!;
}
const text = (r: ReactTestRenderer) => r.root.findAll((n) => typeof n.props.children === 'string' || Array.isArray(n.props.children)).map((n) => [].concat(n.props.children).filter((c) => typeof c === 'string').join('')).join('\n');

describe('the list', () => {
  // the list polls every few seconds: unmount, so no timer outlives the test
  afterEach(async () => { await act(async () => { mounted.splice(0).forEach((r) => r.unmount()); }); });
  beforeEach(() => {
    mockRemove.mockClear();
    mockList = [dev({ fp: A, name: 'mac studio', lastSeen: NOW - 120_000, address: '192.168.1.9', computer: true }), dev({ fp: B })];
  });

  it('shows every paired device with when it was last here', async () => {
    const r = await mount(<PairedDevices peer="192.168.1.9" />);
    const s = text(r);
    expect(s).toContain('DEVICES THAT CAN USE THIS PHONE');
    expect(s).toContain('mac studio');
    expect(s).toContain('connected now');
    expect(s).toContain(shortFp(B));
    expect(s).toContain('not back since it paired');
  });

  it('asks before it removes, and removes only on yes', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const r = await mount(<PairedDevices />);
    const btn = r.root.find((n) => n.props.testID === `unpair-${B.slice(0, 8)}` && typeof n.props.onPress === 'function');
    await act(async () => { btn.props.onPress(); });
    expect(alert).toHaveBeenCalledTimes(1);
    const [title, , buttons] = alert.mock.calls[0] as [string, string, { text: string; style?: string; onPress?: () => void }[]];
    expect(title).toBe(`remove ${shortFp(B)}?`);
    expect(mockRemove).not.toHaveBeenCalled();
    // cancel does nothing
    expect(buttons[0].style).toBe('cancel');
    await act(async () => { buttons[1].onPress!(); await new Promise((res) => setTimeout(res, 10)); });
    expect(mockRemove).toHaveBeenCalledWith(B);
    const s = text(r);
    expect(s).not.toContain(shortFp(B) + '\n');
    expect(s).toContain(`${shortFp(B)} can no longer use this phone.`);
    alert.mockRestore();
  });

  it('on the computers screen: only the devices beyond its own list, nothing when there are none', async () => {
    const r = await mount(<PairedDevices skip={[A]} others />);
    expect(text(r)).toContain('OTHER DEVICES THAT CAN USE THIS PHONE');
    expect(text(r)).not.toContain('mac studio');
    const r2 = await mount(<PairedDevices skip={[A, B]} others />);
    expect(r2.toJSON()).toBeNull();
  });
});
