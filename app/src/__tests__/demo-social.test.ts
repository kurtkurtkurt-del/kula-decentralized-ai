// The test people (data/local/testPeople.ts): made-up friends on the phone who take requests
// and answer messages with canned lines after a short pause.
import { describe, expect, it, jest } from '@jest/globals';
import * as test from '@/data/local/testPeople';

// jest.mock is hoisted above the imports

jest.mock('expo-sqlite/kv-store', () => {
  const m = new Map<string, string>();
  return { __esModule: true, default: { getItemSync: (k: string) => m.get(k) ?? null, setItemSync: (k: string, v: string) => void m.set(k, v) } };
});

const who = (handle: string) => test.testPerson({ handle })!;

describe('the test people', () => {
  it('are clearly test people, each with a face, a bio and a phone', () => {
    expect(test.TEST_PEOPLE.length).toBeGreaterThanOrEqual(4);
    for (const p of test.TEST_PEOPLE) {
      expect(test.isTestHandle(p.handle)).toBe(true);
      expect(test.isTestId(p.id)).toBe(true);
      expect(p.bio && p.device && p.display_name).toBeTruthy();
    }
    expect(test.isTestHandle('deniz')).toBe(false);
    expect(test.isTestId(test.threadOf('test_ayla'))).toBe(false);
    expect(test.testPerson({ thread: test.threadOf('test_ayla') })?.handle).toBe('test_ayla');
  });

  it('start as friends, a request to you, and people to add', () => {
    const s = test.freshSocial();
    const rel = test.TEST_PEOPLE.map((p) => test.relationOf(s, p, 0));
    expect(rel).toContain('friend');
    expect(rel).toContain('incoming');
    expect(rel).toContain('none');
  });

  it('say yes to a request a few seconds later', () => {
    const s = test.freshSocial();
    const kerem = who('test_kerem');
    expect(test.request(s, kerem, 1000)).toBe('sent');
    expect(test.relationOf(s, kerem, 1000 + test.ACCEPT_AFTER - 1)).toBe('outgoing');
    expect(test.relationOf(s, kerem, 1000 + test.ACCEPT_AFTER)).toBe('friend');
    expect(test.request(s, kerem, 1000 + test.ACCEPT_AFTER)).toBe('accepted');
  });

  it('can be accepted and removed', () => {
    const s = test.freshSocial();
    const mira = who('test_mira');
    test.accept(s, mira, 0);
    expect(test.relationOf(s, mira, 0)).toBe('friend');
    test.unfriend(s, mira, 1);
    expect(test.relationOf(s, mira, 1)).toBe('none');
  });
});

describe('a conversation with a test person', () => {
  it('gets an answer after the pause, not before', () => {
    const s = test.freshSocial();
    const ayla = who('test_ayla');
    const { id, due } = test.say(s, ayla, 'hello!', 10_000);
    expect(due - 10_000).toBe(test.replyDelay('hello!'));
    expect(test.linesAfter(s, 'test_ayla', 0, 10_000).map((l) => l.mine)).toEqual([true]);
    const later = test.linesAfter(s, 'test_ayla', id, due);
    expect(later).toHaveLength(1);
    expect(later[0].mine).toBe(false);
    expect(later[0].id).toBeGreaterThan(id);
    expect(later[0].body).toMatch(/test person/); // the first answer says what they are
    expect(test.unread(s, 'test_ayla')).toBe(1);
    test.markSeen(s, 'test_ayla', later[0].id);
    expect(test.unread(s, 'test_ayla')).toBe(0);
  });

  it('keeps ids growing when you write again before the answer came', () => {
    const s = test.freshSocial();
    const ayla = who('test_ayla');
    const a = test.say(s, ayla, 'one', 0);
    const b = test.say(s, ayla, 'two', 100);
    const seen = test.linesAfter(s, 'test_ayla', b.id, 100);
    expect(seen).toEqual([]);
    const both = test.linesAfter(s, 'test_ayla', b.id, b.due);
    expect(both.map((l) => l.mine)).toEqual([false, false]);
    expect(both[0].id).toBeGreaterThan(b.id);
    expect(a.id).toBeLessThan(b.id);
  });

  it('answers in kind: a greeting, a question, the night, in the language you wrote', () => {
    const jonas = who('test_jonas');
    expect(test.replyTo(jonas, 'hi', 1)).toMatch(/hi|hey|hello/);
    expect(test.replyTo(jonas, 'are you there?', 1)).toMatch(/question|sure|ask/);
    expect(test.replyTo(jonas, 'plug in tonight for the coop', 1)).toMatch(/tonight/);
    expect(test.langOf('merhaba, nasılsın')).toBe('tr');
    expect(test.langOf('hallo, wie geht es dir')).toBe('de');
    expect(test.langOf('good evening')).toBe('en');
    expect(test.replyTo(jonas, 'merhaba', 1)).toMatch(/selam|merhaba/);
    expect(test.replyTo(jonas, 'something else', 0)).toMatch(/test person/);
    expect(jonas.lines).toContain(test.replyTo(jonas, 'something else', 4));
  });

  it('lists only started conversations, and takes back your own line', () => {
    const s = test.freshSocial();
    expect(test.startedThreads(s)).toEqual([]);
    const { id } = test.say(s, who('test_mehmet'), 'yo', 0);
    expect(test.startedThreads(s)).toEqual(['test_mehmet']);
    test.unsay(s, 'test_mehmet', id);
    expect(test.linesAfter(s, 'test_mehmet', 0, 0)).toEqual([]);
  });

  it('is kept on the phone, with the switch', () => {
    const s = test.loadSocial();
    test.request(s, who('test_lena'), 5);
    test.saveSocial(s);
    expect(test.loadSocial().rel.test_lena.r).toBe('outgoing');
    expect(test.testSwitch()).toBeNull();
    test.setTestSwitch(false);
    expect(test.testSwitch()).toBe(false);
    test.setTestSwitch(true);
    expect(test.testSwitch()).toBe(true);
  });
});
