import { describe, expect, it } from '@jest/globals';
import { autoLine, hostErr, isHostQr, netLabel, parseHostQr, setupMissing } from '@/llm/hosts';
import type { AutoStatus } from '@/llm/native';

// "let my computers use this phone" (8.11.2026): the computer's QR as the Mac's chat page shows
// it, and the words the setup screen picks for each state. The native side (Auto.kt) is tested
// on the jvm (AutoTest, GateHostTest).
const NOW = 1_900_000_000_000;
const qr = (o: Record<string, unknown> = {}) =>
  JSON.stringify({ k: 'kula-host', v: 1, id: 'host-1', name: 'Mac Studio', fp: 'AB'.repeat(32), pin: '0123456789abcdef', exp: NOW + 600_000, ...o });

const base: AutoStatus = {
  on: true, onlyCharging: false, paused: false, home: { subnet: '192.168.1.0/24', gateway: '192.168.1.1', domain: null, ssid: null }, now: null,
  atHome: true, charging: true, decision: 'start', running: true, mode: 'auto', why: null,
  batteryUnrestricted: true, notifications: true, maker: 'google', sdk: 35, hosts: [],
};

describe('the computer qr', () => {
  it('reads the shared contract', () => {
    const h = parseHostQr(qr(), NOW);
    expect(h).toEqual({ k: 'kula-host', v: 1, id: 'host-1', name: 'Mac Studio', fp: 'ab'.repeat(32), pin: '0123456789abcdef', exp: NOW + 600_000 });
    expect(isHostQr(qr())).toBe(true);
    expect(isHostQr(JSON.stringify({ k: 'kula-peer', v: 3 }))).toBe(false);
    expect(isHostQr('not json')).toBe(false);
  });
  it('refuses a wrong or expired one', () => {
    expect(() => parseHostQr('{', NOW)).toThrow('notHost');
    expect(() => parseHostQr(qr({ v: 2 }), NOW)).toThrow('notHost');
    expect(() => parseHostQr(qr({ fp: 'xyz' }), NOW)).toThrow('notHost');
    expect(() => parseHostQr(qr({ pin: 'short' }), NOW)).toThrow('notHost');
    expect(() => parseHostQr(qr({ exp: 'soon' }), NOW)).toThrow('notHost');
    expect(() => parseHostQr(qr({ id: '' }), NOW)).toThrow('notHost');
    expect(() => parseHostQr(qr({ exp: NOW - 1 }), NOW)).toThrow('expired');
    // a nameless computer still reads
    expect(parseHostQr(qr({ name: '' }), NOW).name).toBe('computer');
  });
  it('names the native errors', () => {
    expect(hostErr(new Error('used'))).toBe('used');
    expect(hostErr({ code: 'expired', message: 'x' })).toBe('expired');
    expect(hostErr(new Error("Call to function 'KulaLlama.addHost' has been rejected.\n→ Caused by: nowifi"))).toBe('nowifi');
    expect(hostErr(new Error('something else'))).toBeNull();
  });
});

describe('the setup screen words', () => {
  it('says what the phone is doing', () => {
    expect(autoLine(base, null).key).toBe('comp.state.ready');
    expect(autoLine(base, { state: 'running', peer: '192.168.1.20' } as never)).toEqual({ key: 'comp.state.working', vars: { peer: '192.168.1.20' } });
    expect(autoLine(base, { state: 'running', pairFor: 'mac' } as never)).toEqual({ key: 'comp.state.pairing', vars: { name: 'mac' } });
    expect(autoLine({ ...base, mode: 'manual' }, null).key).toBe('comp.state.manual');
    expect(autoLine({ ...base, on: false, running: false }, null).key).toBe('comp.state.off');
  });
  it('says why it is not ready', () => {
    const off = { ...base, running: false, mode: null };
    expect(autoLine({ ...off, decision: 'paused' }, null).key).toBe('comp.state.paused');
    expect(autoLine({ ...off, decision: 'away' }, null)).toEqual({ key: 'comp.state.away', vars: { home: 'wi-fi 192.168.1.0/24' } });
    expect(autoLine({ ...off, decision: 'unplugged' }, null).key).toBe('comp.state.unplugged');
    expect(autoLine({ ...off, decision: 'nohome' }, null).key).toBe('comp.state.nohome');
    expect(autoLine({ ...off, decision: 'start' }, null).key).toBe('comp.state.starting');
    expect(autoLine({ ...off, decision: 'start', batteryUnrestricted: false }, null).key).toBe('comp.state.blocked');
  });
  it('lists what the setup lacks', () => {
    expect(setupMissing(base)).toEqual([]);
    expect(setupMissing({ ...base, batteryUnrestricted: false, notifications: false, home: null })).toEqual(['battery', 'notifications', 'home']);
    expect(setupMissing({ ...base, notifications: false, sdk: 32 })).toEqual([]); // no permission before android 13
    expect(netLabel({ ...base.home!, ssid: 'home' })).toBe('home');
  });
});
