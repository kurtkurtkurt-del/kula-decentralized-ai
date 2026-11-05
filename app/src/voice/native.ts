import { Platform } from 'react-native';
import { requireOptionalNativeModule, type EventSubscription } from 'expo-modules-core';

// The native module (modules/kula-voice): the headset button, the bluetooth mic route, the
// message notifications and the clock and messaging apps' intents. Android only; absent in
// Expo Go, on iOS and on the web, where talk mode still works with the phone's own mic and
// the tools that need it say they are not here. A thin typed wrapper; no logic.
export type Msg = { key: string; pkg: string; app: string; title: string; text: string; at: number };
export type Route = { connected: boolean; name: string | null; type: 'bluetooth' | 'bluetooth-media' | 'bluetooth-le' | 'wired' | 'usb' | 'other' | null; micRouted: boolean; route: string };
export type Button = { key: 'press' | 'next' | 'previous' | 'stop'; long: boolean; code: number };

export type VoiceNative = {
  startTalk(routeMic: boolean): boolean;
  stopTalk(): void;
  headsetInfo(): Route;
  routeMic(): boolean;
  releaseMic(): void;
  claimButtons(): void;
  notificationAccess(): boolean;
  openNotificationAccess(): boolean;
  openAppSettings(): boolean;
  recentMessages(): Msg[];
  clearMessages(): void;
  setAlarm(hour: number, minute: number, label: string | null): boolean;
  setTimer(seconds: number, label: string | null): boolean;
  draftMessage(text: string, pkg: string | null): boolean;
  addListener(event: 'onButton', fn: (e: Button) => void): EventSubscription;
  addListener(event: 'onRoute', fn: (e: Route) => void): EventSubscription;
  addListener(event: 'onMessage', fn: (e: Msg) => void): EventSubscription;
};

let mod: VoiceNative | null | undefined;
/** The module, or null where it is not built in. */
export function voiceNative(): VoiceNative | null {
  if (mod !== undefined) return mod;
  mod = Platform.OS === 'android' ? requireOptionalNativeModule<VoiceNative>('KulaVoice') : null;
  return mod;
}
/** Tests swap the module. */
export function setVoiceNative(m: VoiceNative | null) {
  mod = m;
}
