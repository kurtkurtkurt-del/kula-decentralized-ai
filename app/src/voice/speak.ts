import * as Speech from 'expo-speech';

// Speech out: expo-speech (Android's TextToSpeech, on the phone) in the voice's language.
// Sentences are queued as the model finishes them; the speaker says when the first one
// starts (the loop goes from thinking to speaking) and when the queue is empty after the
// reply was closed (the loop listens again).

export type SpeakerEvents = { sound: () => void; drained: () => void };

export class Speaker {
  private queued = 0;
  private closed = false;
  private started = false;
  private gen = 0; // stop() moves on; callbacks of an older generation are ignored

  constructor(private opts: { language: string; rate: number }, private on: SpeakerEvents) {}

  setVoice(language: string, rate: number) {
    this.opts = { language, rate };
  }

  /** A new reply: nothing queued, not closed. */
  begin() {
    this.gen++;
    this.queued = 0;
    this.closed = false;
    this.started = false;
  }

  say(text: string) {
    const t = text.trim();
    if (!t) return;
    const g = this.gen;
    this.queued++;
    const settle = () => {
      if (g !== this.gen) return;
      this.queued = Math.max(0, this.queued - 1);
      this.check();
    };
    Speech.speak(t.slice(0, Math.max(100, Speech.maxSpeechInputLength || 4000)), {
      language: this.opts.language,
      rate: this.opts.rate,
      onStart: () => {
        if (g !== this.gen || this.started) return;
        this.started = true;
        this.on.sound();
      },
      onDone: settle,
      onStopped: settle,
      onError: settle,
    });
  }

  /** No more sentences for this reply: drained fires once the queue is spoken. */
  close() {
    this.closed = true;
    this.check();
  }

  stop() {
    this.gen++;
    this.queued = 0;
    this.closed = false;
    Speech.stop().catch(() => {});
  }

  private check() {
    if (this.closed && this.queued === 0) {
      this.closed = false;
      this.on.drained();
    }
  }
}

/** One short line, outside any reply (an error said in idle). */
export function sayOnce(text: string, language: string, rate: number) {
  Speech.speak(text, { language, rate });
}
