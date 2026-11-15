// security review 8B.1: what the secretary read out (messages, calendar, notes) never goes to another
// device; the model is told honestly where it runs
import { describe, expect, it } from '@jest/globals';
import { buildMessages, routeTalk, type Turn } from '@/voice/prompt';

const me = { id: 'me', local: true };
const pc = { id: 'pc', local: false };
const plain: Turn[] = [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'hello' }];
const readOut: Turn[] = [{ role: 'user', text: 'read my messages', private: true }, { role: 'assistant', text: 'Ada wrote: code 482193', private: true }];

describe('routeTalk', () => {
  it('with the secretary\'s read-outs in the history, the answer comes from this phone', () => {
    const r = routeTalk([...plain, ...readOut], [me, pc]);
    expect(r.device).toBe('me');
    expect(r.where).toBe('phone');
    expect(r.past).toHaveLength(4);
  });
  it('with no device on this phone, the read-outs are left out of the prompt', () => {
    const r = routeTalk([...plain, ...readOut], [pc]);
    expect(r.device).toBeNull();
    expect(r.where).toBe('devices');
    expect(r.past.some((t) => t.private)).toBe(false);
    expect(JSON.stringify(buildMessages(r.past, 'and now?', 'en', new Date(), { where: r.where }))).not.toContain('482193');
  });
  it('without read-outs any device may answer, and the model is told where it runs', () => {
    const r = routeTalk(plain, [me, pc]);
    expect(r.device).toBeNull();
    expect(r.where).toBe('devices');
    const sys = buildMessages(r.past, 'hi', 'en', new Date(), { where: r.where })[0].content as string;
    expect(sys).toContain('paired devices');
    expect(sys).not.toMatch(/nothing they say leaves|talk about anything/i);
    expect(routeTalk(plain, [me]).where).toBe('phone');
  });
});
