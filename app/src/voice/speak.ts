import * as Speech from 'expo-speech';

// Speech out: expo-speech (Android's TextToSpeech, on the phone) in the voice's language.
// Sentences are queued as the model finishes them; the speaker says when the first one
// starts (the loop goes from thinking to speaking) and when the queue is empty after the
// reply was closed (the loop listens again).

export type SpeakerEvents = { sound: () => void; drained: () => void };

// The phone's default voice can be a network one (Google TTS named "en-us-x-iog-server" on
// the S25+, 5.11.2026): it needs the internet and sends the text out. Pick a voice of the
// language that is installed on the phone; none found → the engine's default for the language.
const NETWORKY = /network|server|cloud/i;
const voices = new Map<string, string | null>();

/** Of the voices the phone lists, one installed locally for the language (best quality first). */
export function localVoice(list: Pick<Speech.Voice, 'identifier' | 'language' | 'quality'>[], language: string): string | null {
  const want = language.toLowerCase().replace('_', '-');
  const base = want.slice(0, 2);
  const norm = (l: string) => l.toLowerCase().replace('_', '-');
  const local = list.filter((v) => !NETWORKY.test(v.identifier));
  const rank = (v: (typeof list)[number]) => (norm(v.language) === want ? 0 : 1) * 10 + (v.quality === Speech.VoiceQuality.Enhanced ? 0 : 1);
  const match = local.filter((v) => norm(v.language) === want || norm(v.language).slice(0, 2) === base).sort((a, b) => rank(a) - rank(b));
  return match[0]?.identifier ?? null;
}

async function voiceFor(language: string): Promise<string | null> {
  if (voices.has(language)) return voices.get(language) ?? null;
  try {
    const id = localVoice(await Speech.getAvailableVoicesAsync(), language);
    voices.set(language, id);
    return id;
  } catch {
    return null;
  }
}

export class Speaker {
  private queued = 0;
  private closed = false;
  private started = false;
  private gen = 0; // stop() moves on; callbacks of an older generation are ignored

  private voice: string | null = null;

  constructor(private opts: { language: string; rate: number }, private on: SpeakerEvents) {
    this.pick();
  }

  setVoice(language: string, rate: number) {
    const changed = language !== this.opts.language;
    this.opts = { language, rate };
    if (changed) this.pick();
  }

  private pick() {
    const lang = this.opts.language;
    this.voice = null;
    voiceFor(lang).then((id) => {
      if (this.opts.language === lang) this.voice = id;
    });
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
      ...(this.voice ? { voice: this.voice } : {}),
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
  voiceFor(language).then((voice) => Speech.speak(text, { language, rate, ...(voice ? { voice } : {}) }));
}
