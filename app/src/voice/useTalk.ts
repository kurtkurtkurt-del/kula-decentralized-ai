import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useLang } from '@/i18n';
import { translator, type Lang } from '@/i18n/core';
import { chat, engine, type Reply } from '@/llm/engine';
import { note } from '@/llm/brainlog';
import { phoneCalendar } from '@/voice/calendar';
import { abortListening, downloadModel, micPermission, onHeard, ready, startListening } from '@/voice/listen';
import { initial, step, type Effect, type LoopEvent, type LoopState } from '@/voice/loop';
import { voiceNative, type Route } from '@/voice/native';
import { notesStore } from '@/voice/notes';
import { buildMessages, type Turn, routeTalk } from '@/voice/prompt';
import { LOCALES, saveVoiceSettings, useVoiceSettings, voiceLang } from '@/voice/settings';
import { sayOnce, Speaker } from '@/voice/speak';
import { Chunker, sentences } from '@/voice/text';
import { Secretary } from '@/voice/tools';

// Talk mode, wired: the loop (voice/loop.ts) decides, the controller does. It listens with
// expo-speech-recognition, lets the secretary (voice/tools.ts) or the model answer, speaks
// sentence by sentence with expo-speech, and takes the headset button (modules/kula-voice)
// as a press. The conversation (the last MEMORY_TURNS) lives as long as the screen.
// The controller is a plain object; the screen reads its view with useSyncExternalStore.

export type Banner = 'permission' | 'blocked' | 'unavailable' | 'noOnDevice' | 'noModel' | 'downloading' | 'downloadFailed' | 'notificationAccess' | 'calendarPermission';
/** One line of this conversation on the screen (not the model's memory: that is `history`). */
export type Shown = { id: number; who: 'you' | 'kula'; text: string; error?: boolean };
export type TalkView = { loop: LoopState; turns: Shown[]; question: string | null; banner: Banner | null; route: Route | null };
export type Config = { lang: Lang; onDeviceOnly: boolean; rate: number; continuous: boolean; headsetMic: boolean };

const SILENCE_MS = 12000; // nothing heard for this long: listening ends
const MAX_TOKENS = 220;
const SHOWN_MAX = 40; // lines kept on the screen

// banners about listening itself: a listen that starts clears them
const LISTEN_BANNERS: Banner[] = ['permission', 'blocked', 'noModel', 'noOnDevice', 'downloading', 'downloadFailed'];

export class TalkController {
  private view: TalkView;
  private subs = new Set<() => void>();
  private cfg: Config;
  private secretary: Secretary;
  private speaker: Speaker;
  private history: Turn[] = [];
  private turn = 0;
  private shownId = 0;
  private replyId: number | null = null; // the kula line the current reply writes into
  private running: (Promise<Reply> & { stop: () => void }) | null = null;
  private silence: ReturnType<typeof setTimeout> | null = null;
  private endAfter = false;
  private onDevice: boolean | null = null; // known once the first listen was allowed
  private askMic = false; // the system's question comes after our one-line why

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.view = { loop: initial(cfg.continuous), turns: [], question: null, banner: null, route: null };
    this.secretary = new Secretary({ lang: cfg.lang, now: () => new Date(), tx: this.tx(), calendar: phoneCalendar, native: voiceNative(), notes: notesStore, log: note });
    this.speaker = new Speaker({ language: this.locale(), rate: cfg.rate }, {
      sound: () => this.dispatch({ type: 'sound' }),
      drained: () => {
        // "bye": the reply was said and talk mode rests, without opening the microphone first
        if (this.endAfter) {
          this.endAfter = false;
          this.dispatch({ type: 'close' });
          return;
        }
        this.dispatch({ type: 'done' });
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
  private show(line: Omit<Shown, 'id'>): number {
    const id = ++this.shownId;
    this.set({ turns: [...this.view.turns, { ...line, id }].slice(-SHOWN_MAX) });
    return id;
  }
  private rewrite(id: number, text: string) {
    this.set({ turns: this.view.turns.map((x) => (x.id === id ? { ...x, text } : x)) });
  }
  /** A reply stopped before its first word: its empty line goes. */
  private dropEmptyReply() {
    const id = this.replyId;
    this.replyId = null;
    if (id !== null && this.view.turns.some((x) => x.id === id && !x.text)) this.set({ turns: this.view.turns.filter((x) => x.id !== id) });
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
      error: (code) => this.heardError(code),
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
    // what was missing gets turned on in the system's screens: back here, its banner goes
    const app = AppState.addEventListener('change', (st) => {
      if (st === 'active') void this.recheck();
    });
    return () => {
      off();
      app.remove();
      subs.forEach((s) => s.remove());
      this.clearSilence();
      this.dispatch({ type: 'close' });
      this.speaker.stop();
      abortListening();
      n?.stopTalk();
    };
  }

  /** The recognizer failed. Only a listen that is on can fail: a late error is no news. */
  heardError(code: string) {
    if (this.view.loop.phase !== 'listening') return;
    // on-device only: a recognizer without the language's offline pack answers "network"
    // (it would need its servers); that is the missing pack, not a broken connection
    if ((code === 'language-not-supported' || code === 'service-not-allowed' || code === 'network') && this.cfg.onDeviceOnly) {
      this.onDevice = null;
      this.set({ banner: 'noModel' });
      this.dispatch({ type: 'close' });
      return;
    }
    if (code === 'not-allowed') {
      this.onDevice = null;
      this.set({ banner: 'permission' });
      this.dispatch({ type: 'close' });
      return;
    }
    this.dispatch({ type: 'error', code });
  }

  /** Back from the system's settings: a banner whose cause is gone goes. */
  async recheck() {
    const b = this.view.banner;
    const n = voiceNative();
    if (b === 'notificationAccess' && n?.notificationAccess()) this.set({ banner: null });
    else if (b === 'calendarPermission' && (await phoneCalendar.permission(false).catch(() => false))) this.set({ banner: null });
    else if ((b === 'blocked' || b === 'permission') && (await micPermission(false).catch(() => 'ask')) === 'granted') this.set({ banner: null });
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
        this.endAfter = false;
        this.dropEmptyReply();
        return;
      case 'stopSpeaking':
        this.speaker.stop();
        return;
      case 'sayError': {
        const t = this.tx();
        const text = t(`voice.err.${f.code}`, t('voice.err.other'));
        this.show({ who: 'kula', text, error: true });
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
      let r: Awaited<ReturnType<typeof ready>>;
      try {
        r = await ready(this.locale(), this.cfg.onDeviceOnly, this.askMic);
      } catch {
        // the recognizer's module failed to answer: said once, never a loop stuck on "listening"
        if (this.view.loop.phase === 'listening') this.dispatch({ type: 'error', code: 'client' });
        return;
      }
      if (!r.ok) {
        this.set({ banner: r.why });
        this.dispatch({ type: 'close' });
        return;
      }
      this.onDevice = r.onDevice;
    }
    if (this.view.loop.phase !== 'listening') return;
    if (this.view.banner && LISTEN_BANNERS.includes(this.view.banner)) this.set({ banner: null });
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
    this.show({ who: 'you', text: heard });
    const id = this.show({ who: 'kula', text: '' });
    this.replyId = id;
    this.speaker.begin();
    const out = await this.secretary.handle(heard);
    if (my !== this.turn) return;
    this.set({ question: this.secretary.waiting() });
    if (out.kind === 'say') {
      this.history.push({ role: 'user', text: heard, private: true }, { role: 'assistant', text: out.text, private: true });
      this.rewrite(id, out.text);
      if (out.open) this.set({ banner: out.open });
      if (out.end) this.endAfter = true;
      this.speakAll(out.text);
      return;
    }
    const e = engine();
    if (!e.load || !e.devices.length) {
      // the screen shows the way to the models already: one notice, not two
      const text = this.tx()('voice.say.noEngine');
      this.rewrite(id, text);
      this.speakAll(text);
      return;
    }
    const chunker = new Chunker();
    try {
      // what the secretary read out (messages, calendar, notes) never leaves the phone (security
      // review 8B.1): with it in the history the answer comes from this phone; with no device here
      // at all it is left out of the prompt
      const route = routeTalk(this.history, e.devices);
      const msgs = buildMessages(route.past, heard, this.cfg.lang, new Date(), { noThink: !!e.model?.id.startsWith('qwen3'), where: route.where });
      const run = chat(msgs, (piece) => {
        if (my !== this.turn) return;
        for (const s of chunker.push(piece)) this.speaker.say(s);
        this.rewrite(id, chunker.text());
      }, { maxTokens: MAX_TOKENS, temperature: 0.6, ...(route.device ? { device: route.device } : {}) });
      this.running = run;
      await run;
      if (my !== this.turn) return;
      for (const s of chunker.end()) this.speaker.say(s);
      const said = chunker.text().trim();
      if (said) {
        this.history.push({ role: 'user', text: heard }, { role: 'assistant', text: said });
        this.rewrite(id, said);
        this.speaker.close();
      } else {
        // a model that spent all its words thinking said nothing: say so, not a silent listen
        const text = this.tx()('voice.say.empty');
        this.rewrite(id, text);
        this.speakAll(text);
      }
    } catch {
      if (my === this.turn) this.dispatch({ type: 'error', code: 'model' });
    } finally {
      if (my === this.turn) {
        this.running = null;
        this.replyId = null;
      }
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
    this.listenNow();
  };
  /** "use the phone's online recognizer": the user's choice, then listen. */
  allowOnline = () => {
    saveVoiceSettings({ onDeviceOnly: false });
    this.cfg = { ...this.cfg, onDeviceOnly: false };
    this.onDevice = null;
    this.set({ banner: null });
    this.listenNow();
  };
  /** The language's on-device model: the phone fetches it; done → listen, else say how it went. */
  downloadModel = async () => {
    this.set({ banner: 'downloading' });
    const r = await downloadModel(this.locale());
    this.onDevice = null;
    if (r === 'failed') this.set({ banner: 'downloadFailed' });
    else if (r === 'done') {
      this.set({ banner: null });
      this.listenNow();
    }
    return r;
  };
  /** Listen again from the start (after a download, a permission turned on elsewhere). */
  retry = () => {
    this.onDevice = null;
    this.set({ banner: null });
    this.listenNow();
  };
  forget = () => {
    this.history = [];
    this.secretary.forget();
    this.set({ question: null, turns: [] });
  };
  private listenNow() {
    if (this.view.loop.phase === 'idle') this.dispatch({ type: 'press' });
  }
}

export function useTalk() {
  const { lang: appLang } = useLang();
  const settings = useVoiceSettings();
  const lang = voiceLang(settings, appLang);
  const [c] = useState(() => new TalkController({ lang, onDeviceOnly: settings.onDeviceOnly, rate: settings.rate, continuous: settings.continuous, headsetMic: settings.headsetMic }));
  useEffect(() => c.configure({ lang, onDeviceOnly: settings.onDeviceOnly, rate: settings.rate, continuous: settings.continuous, headsetMic: settings.headsetMic }), [c, lang, settings.onDeviceOnly, settings.rate, settings.continuous, settings.headsetMic]);
  useEffect(() => c.mount(), [c]);
  const view = useSyncExternalStore(c.subscribe, c.snapshot);
  return { ...view, lang, settings, press: c.press, close: c.close, dismiss: c.dismiss, allowMic: c.allowMic, allowOnline: c.allowOnline, downloadModel: c.downloadModel, retry: c.retry, forget: c.forget };
}
