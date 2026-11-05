// Coops on the phone (data/local/coops.ts): make, join by code, members, leave; no server.
import { describe, expect, it, jest } from '@jest/globals';
import * as coops from '@/data/local/coops';

// jest.mock is hoisted above the imports

jest.mock('expo-sqlite/kv-store', () => {
  const m = new Map<string, string>();
  return { __esModule: true, default: { getItemSync: (k: string) => m.get(k) ?? null, setItemSync: (k: string, v: string) => void m.set(k, v) } };
});

const me = { id: 'u1', handle: 'deniz', name: 'deniz' };
const ayla = { id: 'test-ayla', handle: 'test_ayla', name: 'ayla' };
const form = { name: ' night shift ', emoji: '🌙', color: 'violet' as const };

describe('a coop of your own', () => {
  it('is made with you as owner and the friends you picked', () => {
    const s = coops.freshCoops();
    const id = coops.create(s, me, form, [ayla, ayla, me]);
    const c = coops.get(s, id);
    expect(c.name).toBe('night shift');
    expect(c.me).toBe('owner');
    expect(c.members.map((m) => [m.handle, m.role])).toEqual([['deniz', 'owner'], ['test_ayla', 'member']]);
    expect(coops.list(s)).toEqual([expect.objectContaining({ id, members: 2, role: 'owner', tonight_title: null })]);
  });
  it('needs a name and stays within twelve', () => {
    const s = coops.freshCoops();
    expect(() => coops.create(s, me, { ...form, name: '  ' }, [])).toThrow('name');
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, handle: `p${i}`, name: null }));
    expect(() => coops.create(s, me, form, many)).toThrow(/full/);
  });
  it('has a code that opens it on this phone', () => {
    const s = coops.freshCoops();
    const id = coops.create(s, me, form, []);
    const code = coops.invite(s, id);
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    expect(coops.peek(s, code.toLowerCase(), false)).toEqual(expect.objectContaining({ id, mine: true }));
    expect(coops.join(s, me, code, false)).toBe(id);
    expect(s.coops).toHaveLength(1);
  });
  it('takes tonight, members added and removed, edits, and goes when deleted', () => {
    const s = coops.freshCoops();
    const id = coops.create(s, me, form, []);
    coops.setTonight(s, id, { slug: 'x', title: 'a project', model: '3B' });
    expect(coops.list(s)[0].tonight_title).toBe('a project');
    expect(coops.add(s, id, [ayla, ayla])).toBe(1);
    coops.remove(s, id, ayla.id);
    coops.remove(s, id, me.id); // the owner stays
    expect(coops.get(s, id).members.map((m) => m.id)).toEqual(['u1']);
    coops.update(s, id, { ...form, name: 'owls' });
    expect(coops.get(s, id).name).toBe('owls');
    coops.leave(s, id);
    expect(coops.list(s)).toEqual([]);
    expect(() => coops.get(s, id)).toThrow(/not in this coop/);
  });
});

describe('a test coop', () => {
  it('opens with its code only while the test people are on', () => {
    const s = coops.freshCoops();
    const [code] = coops.testCodes();
    expect(coops.peek(s, code, false)).toBeNull();
    expect(() => coops.join(s, me, code, false)).toThrow(/no coop with that code/);
    expect(coops.peek(s, 'NOPE00', true)).toBeNull();
    expect(coops.peek(s, code, true)).toEqual(expect.objectContaining({ mine: false, open: true }));
  });
  it('is joined with the test people in it, and left again', () => {
    const s = coops.freshCoops();
    const [code] = coops.testCodes();
    const id = coops.join(s, me, ` ${code.toLowerCase()} `, true);
    const c = coops.get(s, id);
    expect(c.me).toBe('member');
    expect(c.members.some((m) => m.handle?.startsWith('test_') && m.role === 'owner')).toBe(true);
    expect(c.members.at(-1)).toEqual(expect.objectContaining({ id: 'u1', role: 'member' }));
    expect(coops.join(s, me, code, true)).toBe(id); // a second time: the same coop
    expect(coops.peek(s, code, true)?.mine).toBe(true);
    expect(() => coops.remove(s, id, c.members[0].id)).toThrow(/only the owner/);
    coops.leave(s, id);
    expect(coops.list(s)).toEqual([]);
  });
});

describe('on the phone', () => {
  it('is kept per account', () => {
    const s = coops.loadCoops('u1');
    coops.create(s, me, form, []);
    coops.saveCoops('u1', s);
    expect(coops.loadCoops('u1').coops).toHaveLength(1);
    expect(coops.loadCoops('u2').coops).toHaveLength(0);
  });
});
