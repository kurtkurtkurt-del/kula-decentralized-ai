// Talk mode's loop (voice/loop.ts): idle → listening → thinking → speaking → listening…,
// barge-in, silence, errors, and what each step asks the screen to do.
import { describe, expect, it } from '@jest/globals';
import { initial, MAX_MISSES, run, step, type LoopEvent } from '@/voice/loop';

const types = (effects: { type: string }[]) => effects.map((e) => e.type);

describe('voice loop', () => {
  it('a full hands-free turn returns to listening', () => {
    const s0 = initial(true);
    let r = step(s0, { type: 'press' });
    expect(r.state.phase).toBe('listening');
    expect(types(r.effects)).toEqual(['listen']);
    r = step(r.state, { type: 'partial', text: 'add gym' });
    expect(r.state.partial).toBe('add gym');
    r = step(r.state, { type: 'final', text: ' add gym tomorrow at 6 pm ' });
    expect(r.state.phase).toBe('thinking');
    expect(r.state.heard).toBe('add gym tomorrow at 6 pm');
    expect(r.effects).toEqual([{ type: 'handle', text: 'add gym tomorrow at 6 pm' }]);
    r = step(r.state, { type: 'sound' });
    expect(r.state.phase).toBe('speaking');
    r = step(r.state, { type: 'done' });
    expect(r.state.phase).toBe('listening');
    expect(types(r.effects)).toEqual(['listen']);
  });

  it('without continuous mode a reply ends in idle', () => {
    const r = run(initial(false), [{ type: 'press' }, { type: 'final', text: 'hi' }, { type: 'sound' }, { type: 'done' }]);
    expect(r.state.phase).toBe('idle');
    expect(types(r.effects)).toEqual(['listen', 'handle']);
  });

  it('a reply with nothing to speak still finishes (done straight from thinking)', () => {
    const r = run(initial(true), [{ type: 'press' }, { type: 'final', text: 'hi' }, { type: 'done' }]);
    expect(r.state.phase).toBe('listening');
  });

  it('barge-in: a press while thinking or speaking stops both and listens', () => {
    const speaking = run(initial(true), [{ type: 'press' }, { type: 'final', text: 'tell me a story' }, { type: 'sound' }]).state;
    const r = step(speaking, { type: 'press' });
    expect(r.state.phase).toBe('listening');
    expect(types(r.effects)).toEqual(['cancelReply', 'stopSpeaking', 'listen']);
    const thinking = run(initial(false), [{ type: 'press' }, { type: 'final', text: 'x' }]).state;
    expect(types(step(thinking, { type: 'press' }).effects)).toEqual(['cancelReply', 'stopSpeaking', 'listen']);
  });

  it('a late result or late sound after a barge-in is ignored', () => {
    const s = run(initial(true), [{ type: 'press' }, { type: 'final', text: 'one' }, { type: 'press' }]).state;
    expect(s.phase).toBe('listening');
    expect(step(s, { type: 'sound' }).state.phase).toBe('listening');
    expect(step(s, { type: 'done' }).state).toEqual(s);
    const idle = initial(true);
    expect(step(idle, { type: 'final', text: 'stale' })).toEqual({ state: idle, effects: [] });
  });

  it('a press while listening stops listening', () => {
    const r = run(initial(true), [{ type: 'press' }, { type: 'press' }]);
    expect(r.state.phase).toBe('idle');
    expect(types(r.effects)).toEqual(['listen', 'abortListen']);
  });

  it('silence: one more listen in continuous mode, then idle', () => {
    const listening = step(initial(true), { type: 'press' }).state;
    let r = step(listening, { type: 'silence' });
    expect(r.state.phase).toBe('listening');
    expect(r.state.misses).toBe(1);
    expect(types(r.effects)).toEqual(['listen']);
    for (let i = 1; i < MAX_MISSES; i++) r = step(r.state, { type: 'silence' });
    r = step(r.state, { type: 'silence' });
    expect(r.state.phase).toBe('idle');
    expect(r.effects).toEqual([]);
    // a quiet error or an empty final counts as silence too
    expect(step(listening, { type: 'error', code: 'no-speech' }).state.misses).toBe(1);
    expect(step(listening, { type: 'final', text: '   ' }).state.misses).toBe(1);
    // without continuous mode the first silence ends it
    expect(step(step(initial(false), { type: 'press' }).state, { type: 'silence' }).state.phase).toBe('idle');
  });

  it('something heard resets the silent count', () => {
    const r = run(initial(true), [{ type: 'press' }, { type: 'silence' }, { type: 'final', text: 'hello' }]);
    expect(r.state.misses).toBe(0);
    expect(r.state.phase).toBe('thinking');
  });

  it('errors are said once and the loop rests', () => {
    const listening = step(initial(true), { type: 'press' }).state;
    let r = step(listening, { type: 'error', code: 'network' });
    expect(r.state.phase).toBe('idle');
    expect(r.state.error).toBe('network');
    expect(r.effects).toEqual([{ type: 'abortListen' }, { type: 'sayError', code: 'network' }]);
    const thinking = run(initial(true), [{ type: 'press' }, { type: 'final', text: 'x' }]).state;
    r = step(thinking, { type: 'error', code: 'model' });
    expect(r.effects).toEqual([{ type: 'cancelReply' }, { type: 'stopSpeaking' }, { type: 'sayError', code: 'model' }]);
    // our own abort is not an error; the next press clears the last one
    expect(step(listening, { type: 'error', code: 'aborted' }).state).toEqual(listening);
    expect(step(r.state, { type: 'press' }).state.error).toBeNull();
  });

  it('close stops everything from any phase', () => {
    const phases: LoopEvent[][] = [[{ type: 'press' }], [{ type: 'press' }, { type: 'final', text: 'x' }], [{ type: 'press' }, { type: 'final', text: 'x' }, { type: 'sound' }]];
    for (const evs of phases) {
      const r = step(run(initial(true), evs).state, { type: 'close' });
      expect(r.state.phase).toBe('idle');
      expect(types(r.effects)).toEqual(['abortListen', 'cancelReply', 'stopSpeaking']);
    }
    expect(step(initial(true), { type: 'close' }).effects).toEqual([]);
  });

  it('continuous mode can be switched while running', () => {
    const s = step(initial(true), { type: 'continuous', on: false }).state;
    expect(s.continuous).toBe(false);
    expect(run(s, [{ type: 'press' }, { type: 'final', text: 'x' }, { type: 'done' }]).state.phase).toBe('idle');
  });
});
