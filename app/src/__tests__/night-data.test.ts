// data/night.ts: the morning report reaches the server as numbers only, through the outbox.
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockStore = new Map<string, string>();
jest.mock('expo-sqlite/kv-store', () => ({
  __esModule: true,
  default: {
    getItemSync: (k: string) => mockStore.get(k) ?? null,
    setItemSync: (k: string, v: string) => mockStore.set(k, v),
    removeItemSync: (k: string) => mockStore.delete(k),
    getAllKeysSync: () => [...mockStore.keys()],
  },
}));
let mockNet: ((s: { isConnected: boolean; isInternetReachable: boolean | null }) => void) | null = null;
jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: (fn: typeof mockNet) => (mockNet = fn) },
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { version: '1.4.0' } } }));
jest.mock('expo-device', () => ({ deviceType: 1, DeviceType: { TABLET: 2, DESKTOP: 3 }, osVersion: '14', totalMemory: 8e9 }));
jest.mock('@/passport/measure', () => ({ measureNative: async () => null, nativeAvailable: () => false }));
const mockRpc = jest.fn<(...a: unknown[]) => Promise<{ data?: unknown; error: unknown }>>();
jest.mock('@/lib/supabase', () => ({
  DEMO: false,
  supabase: { auth: { onAuthStateChange: jest.fn() }, rpc: (...a: unknown[]) => mockRpc(...a) },
}));

import { pendingJobs, startOffline } from '@/lib/offline';
import { deviceId } from '@/data/passport';
import { sendNightReport, toPayload } from '@/data/night';
import type { NightReport } from '@/night/report';

const report = (p: Partial<NightReport> = {}): NightReport => ({
  id: '2026-11-05', slug: 'koy-okulu-ogretmen', startedAt: 0, endedAt: 3600_000, seconds: 3600, segments: 2, tokens: 36000, units: 300, checked: 40, wrong: 4, kwh: 0.004, tps: 10,
  devices: [{ id: 'me', name: 'this phone', tokens: 24000, units: 200, tps: 6.7 }, { id: 'p1', name: 'tablet', tokens: 12000, units: 100, tps: 3.3 }],
  watts: 3, measured: false, wh: 3, model: 'tiny', real: true, sent: false, ...p,
});
const flushAll = () => new Promise((r) => setTimeout(r, 0));

beforeAll(() => startOffline());
beforeEach(() => {
  mockStore.delete('outbox');
  mockRpc.mockReset();
  mockNet?.({ isConnected: true, isInternetReachable: true });
});

describe('toPayload', () => {
  it('keeps the numbers, the device id and the version; drops names and whatever else is on the report', () => {
    const p = toPayload({ ...report(), ...({ prompt: 'translate this', samples: [{ text: 'x' }] } as object) });
    expect(p).toMatchObject({ id: '2026-11-05', slug: 'koy-okulu-ogretmen', units: 300, checked: 40, wrong: 4, tokens: 36000, seconds: 3600, segments: 2, tps: 10, wh: 3, model: 'tiny', real: true, app_version: '1.4.0' });
    expect(p.device_id).toBe(deviceId());
    expect(p.device_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.devices).toEqual([{ id: 'me', tokens: 24000, units: 200, tps: 6.7 }, { id: 'p1', tokens: 12000, units: 100, tps: 3.3 }]);
    expect(JSON.stringify(p)).not.toMatch(/translate|samples|this phone|watts|startedAt/);
  });
  it('rounds counts and never sends a negative or a NaN', () => {
    const p = toPayload(report({ units: 12.6, tokens: Number.NaN, wrong: -3 }));
    expect(p).toMatchObject({ units: 13, tokens: 0, wrong: 0 });
  });
});

describe('sendNightReport', () => {
  it('calls night_report with the payload and the job id as client id', async () => {
    mockRpc.mockResolvedValue({ data: 'row-1', error: null });
    expect(await sendNightReport(report())).toBe(true);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [name, args] = mockRpc.mock.calls[0] as [string, { p_report: Record<string, unknown>; p_client_id: string }];
    expect(name).toBe('night_report');
    expect(args.p_client_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(args.p_report).toMatchObject({ units: 300, device_id: deviceId() });
    expect(pendingJobs('nightReport')).toHaveLength(0);
  });
  it('waits in the outbox while offline and goes out, once, when the connection returns', async () => {
    mockNet?.({ isConnected: false, isInternetReachable: false });
    expect(await sendNightReport(report())).toBe(true);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(pendingJobs('nightReport')).toHaveLength(1);
    const jobId = pendingJobs('nightReport')[0].id;
    mockRpc.mockResolvedValue({ data: 'row-1', error: null });
    mockNet?.({ isConnected: true, isInternetReachable: true });
    await flushAll();
    await flushAll();
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect((mockRpc.mock.calls[0][1] as { p_client_id: string }).p_client_id).toBe(jobId);
    expect(pendingJobs('nightReport')).toHaveLength(0);
  });
  it('a lost connection mid-send keeps the job for a retry with the same id', async () => {
    mockRpc.mockRejectedValueOnce(new Error('Network request failed')).mockResolvedValue({ data: 'row-1', error: null });
    expect(await sendNightReport(report())).toBe(true);
    expect(pendingJobs('nightReport')).toHaveLength(1);
    const jobId = pendingJobs('nightReport')[0].id;
    mockNet?.({ isConnected: false, isInternetReachable: false });
    mockNet?.({ isConnected: true, isInternetReachable: true });
    await flushAll();
    await flushAll();
    expect(mockRpc).toHaveBeenCalledTimes(2);
    expect(mockRpc.mock.calls.map((c) => (c[1] as { p_client_id: string }).p_client_id)).toEqual([jobId, jobId]);
    expect(pendingJobs('nightReport')).toHaveLength(0);
  });
  it('says false when the server refuses (an old server without the rpc) and queues nothing', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'function public.night_report does not exist' } });
    expect(await sendNightReport(report())).toBe(false);
    expect(pendingJobs('nightReport')).toHaveLength(0);
  });
});
