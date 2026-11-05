// Talk mode's loop as a pure state machine (no timers, no React Native): an event and the
// state in, the next state and what to do out. The screen (app/talk.tsx through
// voice/session.ts) runs the effects and feeds back what happened.
//
//   idle ──press──▶ listening ──heard──▶ thinking ──first sound──▶ speaking ──done──▶ listening …
//     ▲                 │ silence / error            │ press (barge-in)        │ press (barge-in)
//     └─────────────────┘                            └──────▶ listening ◀──────┘
//
// - hands-free: after the first press, every finished reply goes straight back to listening
//   (continuous); with continuous off it goes back to idle.
// - barge-in: a press (screen tap or the headset button) while thinking or speaking stops
//   the reply and the voice and listens at once.
// - silence: the recognizer heard nothing. In continuous mode it listens once more (the
//   user may have paused), then the loop rests in idle.
// - errors: said briefly, then idle; never retried on their own (no loop of errors).

export type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

export type LoopState = {
  phase: Phase;
  continuous: boolean;
  partial: string; // what the recognizer has so far
  heard: string; // the last finished utterance
  misses: number; // silent listens in a row
  error: string | null; // the last error's code, until the next press
};

export type LoopEvent =
  | { type: 'press' } // the big circle or the headset button
  | { type: 'partial'; text: string }
  | { type: 'final'; text: string }
  | { type: 'silence' } // listening ended with nothing heard (no-speech, nomatch, our timer)
  | { type: 'error'; code: string } // the recognizer or the model failed
  | { type: 'sound' } // the first sentence of the reply started playing
  | { type: 'done' } // the reply is finished: generated and all of it spoken
  | { type: 'close' } // stop button, screen closed, "bye"
  | { type: 'continuous'; on: boolean };

export type Effect =
  | { type: 'listen' }
  | { type: 'abortListen' }
  | { type: 'handle'; text: string } // think about what was heard (tools or the model)
  | { type: 'cancelReply' } // stop the model
  | { type: 'stopSpeaking' }
  | { type: 'sayError'; code: string };

export const MAX_MISSES = 1; // silent listens retried in continuous mode

export const initial = (continuous = true): LoopState => ({ phase: 'idle', continuous, partial: '', heard: '', misses: 0, error: null });

// recognizer codes that mean "nothing was said" rather than "something broke"
const QUIET = new Set(['no-speech', 'speech-timeout', 'nomatch']);

export function step(s: LoopState, e: LoopEvent): { state: LoopState; effects: Effect[] } {
  const to = (patch: Partial<LoopState>, effects: Effect[] = []) => ({ state: { ...s, ...patch }, effects });
  const listen = (misses = 0): { state: LoopState; effects: Effect[] } => to({ phase: 'listening', partial: '', misses, error: null }, [{ type: 'listen' }]);

  switch (e.type) {
    case 'continuous':
      return to({ continuous: e.on });

    case 'close':
      if (s.phase === 'idle') return to({ partial: '' });
      return to({ phase: 'idle', partial: '', misses: 0 }, [{ type: 'abortListen' }, { type: 'cancelReply' }, { type: 'stopSpeaking' }]);

    case 'press':
      switch (s.phase) {
        case 'idle':
          return listen();
        case 'listening': // a second press while listening: stop listening
          return to({ phase: 'idle', partial: '', misses: 0 }, [{ type: 'abortListen' }]);
        case 'thinking':
        case 'speaking': {
          // barge-in: the reply and the voice stop, the user speaks
          const next = listen();
          return { state: next.state, effects: [{ type: 'cancelReply' }, { type: 'stopSpeaking' }, ...next.effects] };
        }
      }
      return to({});

    case 'partial':
      return s.phase === 'listening' ? to({ partial: e.text }) : to({});

    case 'final': {
      if (s.phase !== 'listening') return to({}); // a late result after a barge-in or close
      const text = e.text.trim();
      if (!text) return step(s, { type: 'silence' });
      return to({ phase: 'thinking', heard: text, partial: '', misses: 0 }, [{ type: 'handle', text }]);
    }

    case 'silence':
      if (s.phase !== 'listening') return to({});
      if (s.continuous && s.misses < MAX_MISSES) return listen(s.misses + 1);
      return to({ phase: 'idle', partial: '', misses: 0 });

    case 'error':
      if (e.code === 'aborted') return to({}); // our own abort
      if (QUIET.has(e.code)) return step(s, { type: 'silence' });
      if (s.phase === 'idle') return to({ error: e.code });
      return to({ phase: 'idle', partial: '', misses: 0, error: e.code }, [
        ...(s.phase === 'listening' ? [{ type: 'abortListen' } as Effect] : [{ type: 'cancelReply' } as Effect, { type: 'stopSpeaking' } as Effect]),
        { type: 'sayError', code: e.code },
      ]);

    case 'sound':
      return s.phase === 'thinking' ? to({ phase: 'speaking' }) : to({});

    case 'done':
      if (s.phase !== 'thinking' && s.phase !== 'speaking') return to({});
      return s.continuous ? listen() : to({ phase: 'idle' });
  }
}

/** Runs a list of events from a state (tests, replays). */
export function run(s: LoopState, events: LoopEvent[]): { state: LoopState; effects: Effect[] } {
  let state = s;
  const effects: Effect[] = [];
  for (const e of events) {
    const r = step(state, e);
    state = r.state;
    effects.push(...r.effects);
  }
  return { state, effects };
}
