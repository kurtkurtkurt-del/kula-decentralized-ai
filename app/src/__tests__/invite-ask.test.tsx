// An anchor's invite pairs both ways (security review D4 #8): after the pair-back the anchor's
// computer may use this phone for good, so a scanned or pasted invite is joined only on an answer,
// as a computer's QR is (review 4.5). The answer says whose computer it is (D4 #10): the native join
// keeps it with the anchor (anchors.json `whose`, tested on the jvm in AnchorTest).
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockJoins: unknown[] = [];
const mockNative = {
  joinAnchor: async (inv: unknown) => {
    mockJoins.push(inv);
    return { fp: 'a1'.repeat(32), name: 'Berlin', host: '203.0.113.5', port: 50551, via: 'mapped', again: false, sharing: true };
  },
};

jest.mock('@/i18n', () => {
  const core = jest.requireActual<typeof import('@/i18n/core')>('@/i18n/core');
  const v = { ...core.translator('en'), lang: 'en', setLang: () => {}, up: (s: string) => s.toUpperCase() };
  return { useLang: () => v, useT: () => v.t };
});
jest.mock('@/lib/haptics', () => ({ tapDone: () => {}, tapSelect: () => {} }));
jest.mock('expo-camera', () => ({ CameraView: () => null, useCameraPermissions: () => [null, async () => null] }));
jest.mock('expo-clipboard', () => ({ getStringAsync: async () => '' }));
jest.mock('@/data/passport', () => ({ linkPassport: () => {}, deviceId: () => 'me', lastPassport: () => null }));
jest.mock('@/llm/store', () => ({ rememberPeer: () => {}, saveShare: () => {}, settings: () => ({ relayUrl: '' }), share: () => null, touchPeer: () => {} }));
jest.mock('@/llm/native', () => ({ get llama() { return mockNative; }, hasNative: () => true, GATE_PORT: 50551 }));

import { Alert } from 'react-native';
import { act, create } from 'react-test-renderer';
import { usePeerAdd } from '@/components/models/PeerScan';

// a typed invite: the anchor's address, its one-time code, the start of its certificate
const INVITE = '203.0.113.5:50551 0123456789abcdef 00112233445566778899';

type Button = { text: string; style?: string; onPress?: () => void };

async function scan() {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  let hook: ReturnType<typeof usePeerAdd> | undefined;
  function Probe() { hook = usePeerAdd(); return null; }
  let r: ReturnType<typeof create> | undefined;
  await act(async () => { r = create(<Probe />); });
  let taken = false;
  await act(async () => { taken = hook!.take(INVITE); });
  expect(taken).toBe(true);
  expect(alert).toHaveBeenCalledTimes(1);
  const [title, body, buttons] = alert.mock.calls[0] as [string, string, Button[]];
  alert.mockRestore();
  return { hook: () => hook!, title, body, buttons, done: async () => { await act(async () => { r!.unmount(); }); } };
}
const press = async (b: Button) => { await act(async () => { b.onPress!(); await new Promise((res) => setTimeout(res, 10)); }); };

describe('joining an anchor with its invite', () => {
  beforeEach(() => { mockJoins.length = 0; });

  it('asks first and says what the anchor gets; cancel joins nothing', async () => {
    const s = await scan();
    expect(mockJoins).toEqual([]);
    expect(s.title).toBe('join anchor 00112233?');
    expect(s.body).toContain('pairs both ways');
    expect(s.body).toContain('run models on this phone');
    expect(s.body).toContain('whose computer is it?');
    expect(s.buttons.map((b) => b.text)).toEqual(['cancel', 'my computer', 'a friend’s computer']);
    expect(s.buttons[0].style).toBe('cancel');
    expect(s.buttons[0].onPress).toBeUndefined();
    expect(mockJoins).toEqual([]);
    expect(s.hook().note).toBeNull();
    await s.done();
  });

  it('"my computer" joins and keeps the anchor as the person’s own', async () => {
    const s = await scan();
    await press(s.buttons[1]);
    expect(mockJoins).toEqual([expect.objectContaining({ fpPrefix: '00112233445566778899', pin: '0123456789abcdef', whose: 'mine' })]);
    expect(s.hook().note).toContain('joined berlin');
    // the anchor's computer keeps a new member as a friend's until its owner says yes on its row
    expect(s.hook().note).toContain('on that computer, in devices, press “yes, it is mine” on this phone’s row; until then it limits this phone like a friend’s');
    await s.done();
  });

  it('"a friend’s computer" joins and keeps the anchor as a friend’s', async () => {
    const s = await scan();
    await press(s.buttons[2]);
    expect(mockJoins).toEqual([expect.objectContaining({ fpPrefix: '00112233445566778899', whose: 'friend' })]);
    expect(s.hook().note).toContain('joined berlin');
    expect(s.hook().note).not.toContain('yes, it is mine');
    await s.done();
  });
});
