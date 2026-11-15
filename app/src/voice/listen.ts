import { Platform } from 'react-native';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';

// Speech in: expo-speech-recognition around Android's SpeechRecognizer. On-device first: the
// recognizer is asked for on-device recognition (enforced from Android 13) and to prefer offline in any
// case; only when the user allowed "the phone's online recognizer" may it fall back to
// the recognizer service's servers. One utterance per start (continuous: false): it ends by
// itself after a pause, which is what the loop wants.

export type Ready =
  | { ok: true; onDevice: boolean }
  | { ok: false; why: 'permission' | 'blocked' | 'unavailable' | 'noOnDevice' | 'noModel' };

const R = ExpoSpeechRecognitionModule;

export async function micPermission(ask: boolean): Promise<'granted' | 'ask' | 'blocked'> {
  const now = await R.getPermissionsAsync();
  if (now.granted) return 'granted';
  if (!ask) return now.canAskAgain ? 'ask' : 'blocked';
  const r = await R.requestPermissionsAsync();
  return r.granted ? 'granted' : r.canAskAgain ? 'ask' : 'blocked';
}

/** Whether this phone has the language's on-device model (Android 13+ tells; older: unknown → true). */
async function hasModel(locale: string): Promise<boolean> {
  try {
    const { installedLocales, locales } = await R.getSupportedLocales({});
    if (!installedLocales.length && !locales.length) return true; // the phone does not say
    const want = locale.toLowerCase();
    return installedLocales.some((l) => l.toLowerCase().replace('_', '-') === want || l.toLowerCase().slice(0, 2) === want.slice(0, 2));
  } catch {
    return true;
  }
}

/** Can we listen now, and how? Asks for the microphone when ask is true. */
export async function ready(locale: string, onDeviceOnly: boolean, ask: boolean): Promise<Ready> {
  const mic = await micPermission(ask);
  if (mic !== 'granted') return { ok: false, why: mic === 'blocked' ? 'blocked' : 'permission' };
  if (!R.isRecognitionAvailable()) return { ok: false, why: 'unavailable' };
  // the library makes a true on-device recognizer only from Android 13 (API 33); below that it says
  // "supported" but falls back to the default recognizer with only a preference for offline, which
  // may send speech away (security review 8B.4): on-device only is not promised there
  const android13 = Platform.OS !== 'android' || Number(Platform.Version) >= 33;
  const device = Platform.OS === 'web' ? false : android13 && R.supportsOnDeviceRecognition();
  if (onDeviceOnly) {
    if (!device) return { ok: false, why: 'noOnDevice' };
    if (!(await hasModel(locale))) return { ok: false, why: 'noModel' };
    return { ok: true, onDevice: true };
  }
  return { ok: true, onDevice: device && (await hasModel(locale)) };
}

/** Starts the phone downloading the language's on-device model (Android 13+). */
export async function downloadModel(locale: string): Promise<'done' | 'started' | 'failed'> {
  try {
    const r = await R.androidTriggerOfflineModelDownload({ locale });
    return r.status === 'download_success' ? 'done' : 'started';
  } catch {
    return 'failed';
  }
}

export function startListening(locale: string, onDevice: boolean) {
  R.start({
    lang: locale,
    interimResults: true,
    continuous: false,
    maxAlternatives: 1,
    requiresOnDeviceRecognition: onDevice,
    addsPunctuation: false,
    // no silence-length extra: Google's on-device recognizer (Soda) applied a 1.4 s "complete
    // silence" to the wait before the first word too and closed the mic before anyone spoke
    // (5.11.2026, Galaxy S25+). Its own default waits for speech and finds the end itself.
    androidIntentOptions: { EXTRA_PREFER_OFFLINE: true },
  });
}
export const stopListening = () => R.stop();
export const abortListening = () => {
  try {
    R.abort();
  } catch {}
};

export type Heard = {
  partial: (text: string) => void;
  final: (text: string) => void;
  silence: () => void;
  error: (code: string, message: string) => void;
  start: () => void;
};

// codes that only close a listen already reported: Android says "no match" twice (a nomatch
// event, then the error no-speech), and abort() sends "aborted" before its end
const AFTERMATH = new Set(['no-speech', 'nomatch', 'speech-timeout', 'aborted']);

/**
 * One listen's outcome, once (pure: the recognizer's events in, the loop's out). A listen ends
 * in one final text, one silence or one error; whatever the recognizer sends after that for
 * the same listen is dropped until the next start. Before 15.11.2026 a silent listen was
 * reported twice (nomatch, then no-speech): the first listened again, the second put the loop
 * to rest while the new listen kept the microphone open behind an idle screen.
 */
export function heardEvents(h: Heard) {
  let finished = false;
  return {
    start: () => {
      finished = false;
      h.start();
    },
    result: (text: string, isFinal: boolean) => {
      if (finished) return;
      if (isFinal) {
        finished = true;
        h.final(text);
      } else h.partial(text);
    },
    nomatch: () => {
      if (finished) return;
      finished = true;
      h.silence();
    },
    error: (code: string, message: string) => {
      // an error that is not the aftermath of a finished listen is a new listen failing before
      // its start event (no microphone, busy): it must reach the loop
      if (finished && AFTERMATH.has(code)) return;
      finished = true;
      h.error(code, message);
    },
    end: () => {
      if (finished) return;
      finished = true;
      h.silence();
    },
  };
}

/** The recognizer's events as the loop wants them (heardEvents). Returns the unsubscribe. */
export function onHeard(h: Heard): () => void {
  const on = heardEvents(h);
  const subs = [
    R.addListener('start', on.start),
    R.addListener('result', (e) => on.result(e.results[0]?.transcript ?? '', e.isFinal)),
    R.addListener('nomatch', on.nomatch),
    R.addListener('error', (e) => on.error(e.error, e.message)),
    R.addListener('end', on.end),
  ];
  return () => subs.forEach((s) => s.remove());
}
