import { Platform } from 'react-native';
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition';

// Speech in: expo-speech-recognition around Android's SpeechRecognizer. On-device first: the
// recognizer is asked for on-device recognition (Android 12+) and to prefer offline in any
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
  const device = Platform.OS === 'web' ? false : R.supportsOnDeviceRecognition();
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

/**
 * The recognizer's events as the loop wants them: partial words, one final text, or silence
 * (nomatch, or an end with nothing final). Returns the unsubscribe.
 */
export function onHeard(h: Heard): () => void {
  let finished = false;
  const subs = [
    R.addListener('start', () => {
      finished = false;
      h.start();
    }),
    R.addListener('result', (e) => {
      const text = e.results[0]?.transcript ?? '';
      if (e.isFinal) {
        finished = true;
        h.final(text);
      } else h.partial(text);
    }),
    R.addListener('nomatch', () => {
      if (finished) return;
      finished = true;
      h.silence();
    }),
    R.addListener('error', (e) => {
      finished = true;
      h.error(e.error, e.message);
    }),
    R.addListener('end', () => {
      if (finished) return;
      finished = true;
      h.silence();
    }),
  ];
  return () => subs.forEach((s) => s.remove());
}
