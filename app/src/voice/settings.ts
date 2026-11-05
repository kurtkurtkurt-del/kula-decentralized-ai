import { useEffect, useState } from 'react';
import Storage from 'expo-sqlite/kv-store';
import type { Lang } from '@/i18n/core';

// Talk mode's settings, kept on this phone (kv 'voice.settings').
// - onDeviceOnly: speech is recognised on the phone or not at all (default). Off lets the
//   phone's own recognizer (Google's, on most phones) use its servers: the one exception to
//   "nothing leaves the phone", said where the switch is.
// - lang: the voice's language; 'app' follows the app's language.
// - rate: how fast the replies are spoken (1 = normal).
// - continuous: after a reply, listen again without a press (hands-free).
// - headsetMic: a connected bluetooth headset gets the microphone while talk mode is open.
export type VoiceSettings = { onDeviceOnly: boolean; lang: 'app' | Lang; rate: number; continuous: boolean; headsetMic: boolean };

export const VOICE_DEFAULTS: VoiceSettings = { onDeviceOnly: true, lang: 'app', rate: 1, continuous: true, headsetMic: true };
export const RATES = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
const KEY = 'voice.settings';

let cached: VoiceSettings | null = null;
const listeners = new Set<() => void>();

export function voiceSettings(): VoiceSettings {
  if (cached) return cached;
  try {
    const raw = Storage.getItemSync(KEY);
    cached = { ...VOICE_DEFAULTS, ...(raw ? (JSON.parse(raw) as Partial<VoiceSettings>) : {}) };
  } catch {
    cached = { ...VOICE_DEFAULTS };
  }
  return cached;
}

export function saveVoiceSettings(patch: Partial<VoiceSettings>) {
  cached = { ...voiceSettings(), ...patch };
  try {
    Storage.setItemSync(KEY, JSON.stringify(cached));
  } catch {}
  listeners.forEach((fn) => fn());
}

export function useVoiceSettings(): VoiceSettings {
  const [s, setS] = useState(voiceSettings);
  useEffect(() => {
    const fn = () => setS(voiceSettings());
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return s;
}

/** The recognizer's and the voice's locale for a language. */
export const LOCALES: Record<Lang, string> = { en: 'en-US', de: 'de-DE', tr: 'tr-TR' };
export const voiceLang = (s: VoiceSettings, appLang: Lang): Lang => (s.lang === 'app' ? appLang : s.lang);
