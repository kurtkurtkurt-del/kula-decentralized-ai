import { useEffect, useState, useSyncExternalStore } from 'react';
import { useLang } from '@/i18n';
import { translator, type Lang } from '@/i18n/core';
import { chat, engine, type Reply } from '@/llm/engine';
import { note } from '@/llm/brainlog';
import { phoneCalendar } from '@/voice/calendar';
import { abortListening, downloadModel, onHeard, ready, startListening } from '@/voice/listen';
import { initial, step, type Effect, type LoopEvent, type LoopState } from '@/voice/loop';
import { voiceNative, type Route } from '@/voice/native';
import { notesStore } from '@/voice/notes';
import { buildMessages, type Turn } from '@/voice/prompt';
import { LOCALES, saveVoiceSettings, useVoiceSettings, voiceLang } from '@/voice/settings';
import { sayOnce, Speaker } from '@/voice/speak';
import { Chunker, sentences } from '@/voice/text';
import { Secretary } from '@/voice/tools';

// Talk mode, wired: the loop (voice/loop.ts) decides, the controller does. It listens with
// expo-speech-recognition, lets the secretary (voice/tools.ts) or the model answer, speaks
// sentence by sentence with expo-speech, and takes the headset button (modules/kula-voice)
// as a press. The conversation (the last MEMORY_TURNS) lives as long as the screen.
// The controller is a plain object; the screen reads its view with useSyncExternalStore.

export type Banner = 'permission' | 'blocked' | 'unavailable' | 'noOnDevice' | 'noModel' | 'notificationAccess' | 'calendarPermission' | 'noEngine';
export type TalkView = { loop: LoopState; reply: string; question: string | null; banner: Banner | null; route: Route | null };
type Config = { lang: Lang; onDeviceOnly: boolean; rate: number; continuous: boolean; headsetMic: boolean };

const SILENCE_MS = 12000; // nothing heard for this long: listening ends
const MAX_TOKENS = 220;

export class TalkController {
  private view: TalkView;
  private subs = new Set<() => void>();
  private cfg: Config;
  private secretary: Secretary;
  private speaker: Speaker;
  private history: Turn[] = [];
  private turn = 0;
  private running: (Promise<Reply> & { stop: () => void }) | null = null;
  private silence: ReturnType<typeof setTimeout> | null = null;
  private endAfter = false;
  private onDevice: boolean | null = null; // known once the first listen was allowed
  private askMic = false; // the system's question comes after our one-line why

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.view = { loop: initial(cfg.continuous), reply: '', question: null, banner: null, route: null };
    this.secretary = new Secretary({ lang: cfg.lang, now: () => new Date(), tx: this.tx(), calendar: phoneCalendar, native: voiceNative(), notes: notesStore, log: note });
    this.speaker = new Speaker({ language: this.locale(), rate: cfg.rate }, {
      sound: () => this.dispatch({ type: 'sound' }),
      drained: () => {
        this.dispatch({ type: 'done' });
        if (this.endAfter) {
          this.endAfter = false;
          this.dispatch({ type: 'close' });
        }
      },
    });
  }

  private tx = () => translator(this.cfg.lang).tx;
  private locale = () => LOCALES[this.cfg.lang];

  // ---- the view ------------------------------------------------------------------------
  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  };
  snapshot = () => this.view;
  private set(patch: Partial<TalkView>) {
    this.view = { ...this.view, ...patch };
    this.subs.forEach((fn) => fn());
  }

  /** New settings or language: the voice, the secretary, the recognizer's mode, the loop. */
  configure(cfg: Config) {
    const was = this.cfg;
    this.cfg = cfg;
    this.secretary.setLang(cfg.lang, this.tx());
    this.speaker.setVoice(this.locale(), cfg.rate);
    if (was.onDeviceOnly !== cfg.onDeviceOnly || was.lang !== cfg.lang) this.onDevice = null;
    if (was.continuous !== cfg.continuous) this.dispatch({ type: 'continuous', on: cfg.continuous });
  }

  /** The screen is open: the recognizer's events, the headset. Returns the teardown. */
  mount(): () => void {
    const off = onHeard({
      start: () => {},
      partial: (text) => {
        this.armSilence();
        this.dispatch({ type: 'partial', text });
      },
      final: (text) => this.dispatch({ type: 'final', text }),
      silence: () => this.dispatch({ type: 'silence' }),
      error: (code) => {
        if ((code === 'language-not-supported' || code === 'service-not-allowed') && this.cfg.onDeviceOnly) {
          this.onDevice = null;
          this.set({ banner: 'noModel' });
          this.dispatch({ type: 'close' });
          return;
        }
        if (code === 'not-allowed') {
          this.onDevice = null;
          this.set({ banner: 'permission' });
        }
        this.dispatch({ type: 'error', code });
      },
    });
    const n = voiceNative();
    const subs = n
      ? [
        n.addListener('onButton', (b) => this.dispatch(b.long || b.key === 'stop' ? { type: 'close' } : { type: 'press' })),
        n.addListener('onRoute', (route) => this.set({ route })),
      ]
      : [];
    if (n) {
      n.startTalk(this.cfg.headsetMic);
      this.set({ route: n.headsetInfo() });
    }
    return () => {
      off();
      subs.forEach((s) => s.remove());
      this.clearSilence();
      this.dispatch({ type: 'close' });
      this.speaker.stop();
      abortListening();
      n?.stopTalk();
    };
  }

  // ---- the loop ------------------------------------------------------------------------
  private dispatch(e: LoopEvent) {
    const r = step(this.view.loop, e);
    if (r.state.phase !== 'listening') this.clearSilence();
    this.set({ loop: r.state });
    r.effects.forEach((f) => this.effect(f));
  }

  private effect(f: Effect) {
    switch (f.type) {
      case 'listen':
        void this.listen();
        return;
      case 'abortListen':
        this.clearSilence();
        abortListening();
        return;
      case 'handle':
        this.clearSilence();
        void this.handle(f.text);
        return;
      case 'cancelReply':
        this.turn++;
        this.running?.stop();
        this.running = null;
        return;
      case 'stopSpeaking':
        this.speaker.stop();
        return;
      case 'sayError': {
        const t = this.tx();
        const text = t(`voice.err.${f.code}`, t('voice.err.other'));
        this.set({ reply: text });
        sayOnce(text, this.locale(), this.cfg.rate);
        return;
      }
    }
  }

  private clearSilence() {
    if (this.silence) clearTimeout(this.silence);
    this.silence = null;
  }
  private armSilence() {
    this.clearSilence();
    this.silence = setTimeout(() => {
      if (this.view.loop.phase !== 'listening') return;
      abortListening();
      this.dispatch({ type: 'silence' });
    }, SILENCE_MS);
  }

  private async listen() {
    if (this.onDevice === null) {
      const r = await ready(this.locale(), this.cfg.onDeviceOnly, this.askMic);
      if (!r.ok) {
        this.set({ banner: r.why });
        this.dispatch({ type: 'close' });
        return;
      }
      this.onDevice = r.onDevice;
    }
    if (this.view.loop.phase !== 'listening') return;
    if (this.view.banner === 'permission' || this.view.banner === 'noModel' || this.view.banner === 'noOnDevice') this.set({ banner: null });
    try {
      startListening(this.locale(), this.onDevice);
      this.armSilence();
    } catch {
      this.dispatch({ type: 'error', code: 'client' });
    }
  }

  private speakAll(text: string) {
    for (const s of sentences(text)) this.speaker.say(s);
    this.speaker.close();
  }

  private async handle(heard: string) {
    const my = ++this.turn;
    this.set({ reply: '' });
    this.speaker.begin();
    const out = await this.secretary.handle(heard);
    if (my !== this.turn) return;
    this.set({ question: this.secretary.waiting() });
    if (out.kind === 'say') {
      this.history.push({ role: 'user', text: heard }, { role: 'assistant', text: out.text });
      this.set({ reply: out.text, ...(out.open ? { banner: out.open } : {}) });
      if (out.end) this.endAfter = true;
      this.speakAll(out.text);
      return;
    }
    const e = engine();
    if (!e.load || !e.devices.length) {
      const text = this.tx()('voice.say.noEngine');
      this.set({ banner: 'noEngine', reply: text });
      this.speakAll(text);
      return;
    }
    const chunker = new Chunker();
    try {
      const msgs = buildMessages(this.history, heard, this.cfg.lang, new Date(), { noThink: !!e.model?.id.startsWith('qwen3') });
      const run = chat(msgs, (piece) => {
        if (my !== this.turn) return;
        for (const s of chunker.push(piece)) this.speaker.say(s);
        this.set({ reply: chunker.text() });
      }, { maxTokens: MAX_TOKENS, temperature: 0.6 });
      this.running = run;
      await run;
      if (my !== this.turn) return;
      for (const s of chunker.end()) this.speaker.say(s);
      const said = chunker.text();
      this.history.push({ role: 'user', text: heard }, { role: 'assistant', text: said });
      this.set({ reply: said });
      this.speaker.close();
    } catch {
      if (my === this.turn) this.dispatch({ type: 'error', code: 'model' });
    } finally {
      if (my === this.turn) this.running = null;
    }
  }

  // ---- what the screen can do ----------------------------------------------------------
  press = () => this.dispatch({ type: 'press' });
  close = () => {
    this.secretary.forget();
    this.set({ question: null });
    this.dispatch({ type: 'close' });
  };
  dismiss = () => this.set({ banner: null });
  /** After the why: now the system asks for the microphone. */
  allowMic = () => {
    this.askMic = true;
    this.set({ banner: null });
    this.dispatch({ type: 'press' });
  };
  /** "use the phone's online recognizer": the user's choice, then listen. */
  allowOnline = () => {
    saveVoiceSettings({ onDeviceOnly: false });
    this.cfg = { ...this.cfg, onDeviceOnly: false };
    this.onDevice = null;
    this.set({ banner: null });
    this.dispatch({ type: 'press' });
  };
  downloadModel = async () => {
    const r = await downloadModel(this.locale());
    this.onDevice = null;
    return r;
  };
  forget = () => {
    this.history = [];
    this.secretary.forget();
    this.set({ question: null, reply: '' });
  };
}

export function useTalk() {
  const { lang: appLang } = useLang();
  const settings = useVoiceSettings();
  const lang = voiceLang(settings, appLang);
  const [c] = useState(() => new TalkController({ lang, onDeviceOnly: settings.onDeviceOnly, rate: settings.rate, continuous: settings.continuous, headsetMic: settings.headsetMic }));
  useEffect(() => c.configure({ lang, onDeviceOnly: settings.onDeviceOnly, rate: settings.rate, continuous: settings.continuous, headsetMic: settings.headsetMic }), [c, lang, settings.onDeviceOnly, settings.rate, settings.continuous, settings.headsetMic]);
  useEffect(() => c.mount(), [c]);
  const view = useSyncExternalStore(c.subscribe, c.snapshot);
  return { ...view, lang, settings, press: c.press, close: c.close, dismiss: c.dismiss, allowMic: c.allowMic, allowOnline: c.allowOnline, downloadModel: c.downloadModel, forget: c.forget };
}
