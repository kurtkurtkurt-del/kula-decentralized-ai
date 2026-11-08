// The share screen opened as pasaport://share?start=1 (a computer with the phone on a usb cable
// does that over adb when nobody is sharing): it presses start once, as a person would; it
// leaves a running worker alone; and without start=1 it waits for the button as before.
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

let mockParams: { start?: string } = {};
let mockState: 'stopped' | 'running' = 'stopped';
let mockMode: 'auto' | 'manual' | null = null;
const mockOpenPairing = jest.fn(async () => {});
const mockStartWorker = jest.fn(async (..._a: unknown[]) => {});
const mockWorkerStatus = jest.fn(async () => ({ state: mockState, error: null, peer: null, heldMb: 0, ramMb: 4000, bandwidth: 10, throttled: false, connects: 0, rejects: 0, id: 'x', batteryUnrestricted: true, fp: null, pin: null, mode: mockMode }));

jest.mock('expo-sqlite/kv-store', () => ({ __esModule: true, default: { getItemSync: () => null, setItemSync: () => {}, removeItemSync: () => {} } }));
jest.mock('expo-router', () => ({ useLocalSearchParams: () => mockParams }));
jest.mock('@/i18n', () => {
  const core = jest.requireActual<typeof import('@/i18n/core')>('@/i18n/core');
  const v = { ...core.translator('en'), lang: 'en', setLang: () => {}, up: (s: string) => s.toUpperCase() };
  return { useLang: () => v, useT: () => v.t };
});
jest.mock('@/components/StaffPage', () => ({ __esModule: true, default: ({ children }: { children: React.ReactNode }) => children }));
jest.mock('react-native-qrcode-svg', () => ({ __esModule: true, default: () => null }));
jest.mock('expo-brightness', () => ({ getBrightnessAsync: async () => 0.5, setBrightnessAsync: async () => {}, restoreSystemBrightnessAsync: async () => {} }));
jest.mock('expo-clipboard', () => ({ setStringAsync: async () => true }));
jest.mock('@/lib/haptics', () => ({ tapDone: () => {}, tapSelect: () => {} }));
jest.mock('@/llm/peers', () => ({
  myPeerQr: async () => ({ qr: '{"k":"kula-peer"}', share: { port: 50551, secret: 'ab'.repeat(16), name: 'test phone' } }),
  relayUrlOf: (s: string) => s,
}));
jest.mock('@/llm/store', () => ({ saveSettings: () => {}, saveShare: () => {}, settings: () => ({ relayUrl: '' }), share: () => null, useShare: () => null }));
jest.mock('@/llm/native', () => ({
  hasNative: () => true,
  llama: {
    workerStatus: () => mockWorkerStatus(),
    startWorker: (...a: unknown[]) => mockStartWorker(...a),
    stopWorker: async () => {},
    keepScreenOn: async () => {},
    secureScreen: async () => {},
    info: async () => ({ wifiIp: '192.168.1.20' }),
    requestBatteryUnrestricted: async () => true,
    openPairing: () => mockOpenPairing(),
  },
}));

import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import ShareScreen from '@/app/share';

async function mount() {
  let r: ReactTestRenderer | undefined;
  await act(async () => { r = create(<ShareScreen />); });
  // the first status poll and whatever it started
  await act(async () => { await new Promise((res) => setTimeout(res, 20)); });
  return r!;
}

describe('share?start=1', () => {
  beforeEach(() => { mockStartWorker.mockClear(); mockWorkerStatus.mockClear(); mockOpenPairing.mockClear(); mockState = 'stopped'; mockMode = null; mockParams = {}; });

  it('starts sharing once when it is not on', async () => {
    mockParams = { start: '1' };
    const r = await mount();
    expect(mockStartWorker).toHaveBeenCalledTimes(1);
    expect(mockStartWorker.mock.calls[0][0]).toBe(50551);
    // the next polls do not press it again
    await act(async () => { await new Promise((res) => setTimeout(res, 2100)); });
    expect(mockStartWorker).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  it('leaves a running worker alone', async () => {
    mockParams = { start: '1' };
    mockState = 'running';
    const r = await mount();
    expect(mockStartWorker).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it('waits for the button without start=1', async () => {
    const r = await mount();
    expect(mockWorkerStatus).toHaveBeenCalled();
    expect(mockStartWorker).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  // "let my computers use this phone" (8.11.2026): a worker that started by itself on the home
  // wi-fi lets in only paired computers; the screen says so and opens a code only on a press
  it('in auto mode says ready for your computers, pauses, and opens a code on a press', async () => {
    mockParams = { start: '1' };
    mockState = 'running';
    mockMode = 'auto';
    const r = await mount();
    // a busy machine: give the first poll time to land before reading the screen
    for (let i = 0; i < 40 && !JSON.stringify(r.toJSON()).includes('ready for your computers'); i++) {
      await act(async () => { await new Promise((res) => setTimeout(res, 50)); });
    }
    expect(mockStartWorker).not.toHaveBeenCalled();
    const text = JSON.stringify(r.toJSON());
    expect(text).toContain('ready for your computers');
    expect(text).toContain('pause');
    const btn = r.root.findAll((n) => n.props.accessibilityLabel === 'code for a new device' && typeof n.props.onPress === 'function')[0];
    await act(async () => { btn.props.onPress(); });
    expect(mockOpenPairing).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });
});
