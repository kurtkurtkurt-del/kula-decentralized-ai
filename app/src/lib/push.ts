import { useEffect } from 'react';
import { Platform } from 'react-native';
import { router, type Href } from 'expo-router';
import * as Device from 'expo-device';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import Storage from 'expo-sqlite/kv-store';
import { supabase } from '@/lib/supabase';
import { getLang } from '@/i18n/core';
import { colors } from '@/theme/tokens';

// Push notifications (13_push.sql). The phone registers its Expo push token with
// the account, plus the app language and the phone's time zone (for quiet hours);
// the database decides what to send and when.
//
// Remote push is unavailable in Expo Go on Android and on simulators; there even
// importing expo-notifications throws, so the module is loaded lazily and only
// where it works.

type NotificationsModule = typeof import('expo-notifications');

const TOKEN = 'push.token';
const ASKED = 'push.asked';

export const pushSupported = Device.isDevice && !(Platform.OS === 'android' && Constants.executionEnvironment === ExecutionEnvironment.StoreClient);

let loaded: NotificationsModule | null = null;
export function notifications(): NotificationsModule | null {
  if (!pushSupported) return null;
  if (!loaded) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- must not load in Expo Go on Android
    loaded = require('expo-notifications') as NotificationsModule;
    loaded.setNotificationHandler({
      handleNotification: async () => ({ shouldPlaySound: true, shouldSetBadge: false, shouldShowBanner: true, shouldShowList: true }),
    });
  }
  return loaded;
}

export type PushStatus = 'granted' | 'denied' | 'undetermined' | 'unsupported';

export async function pushStatus(): Promise<PushStatus> {
  const N = notifications();
  if (!N) return 'unsupported';
  const { status } = await N.getPermissionsAsync();
  return status === 'granted' ? 'granted' : status === 'denied' ? 'denied' : 'undetermined';
}

// Registers this phone for the signed-in account. ask: show the system prompt if needed.
export async function registerPush(ask: boolean): Promise<PushStatus> {
  const N = notifications();
  if (!N) return 'unsupported';
  if (Platform.OS === 'android') {
    await N.setNotificationChannelAsync('default', {
      name: "kula decentralized ai",
      importance: N.AndroidImportance.HIGH,
      lightColor: colors.spot,
    });
  }
  let status = await pushStatus();
  if (status !== 'granted' && ask) {
    Storage.setItemSync(ASKED, '1');
    status = (await N.requestPermissionsAsync()).status === 'granted' ? 'granted' : 'denied';
  }
  if (status !== 'granted') return status;

  const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
  const { data: token } = await N.getExpoPushTokenAsync({ projectId });
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { error } = await supabase.rpc('push_register', { p_token: token, p_platform: Platform.OS, p_lang: getLang(), p_tz: tz });
  if (error) throw error;
  Storage.setItemSync(TOKEN, token);
  return 'granted';
}

// Before signing out, while the session can still make the call.
export async function unregisterPush() {
  const token = Storage.getItemSync(TOKEN);
  if (!token) return;
  await supabase.rpc('push_unregister', { p_token: token }).then(
    () => {},
    () => {},
  );
  Storage.removeItemSync(TOKEN);
}

// Signed in with an account: register quietly, and ask once per install.
export function usePushRegistration(member: boolean, lang: string) {
  useEffect(() => {
    if (!member || !pushSupported) return;
    registerPush(!Storage.getItemSync(ASKED)).catch(() => {});
  }, [member, lang]);
}

// Tapping a notification opens the screen it names, also from a cold start.
export function usePushRouting() {
  useEffect(() => {
    const N = notifications();
    if (!N) return;
    const open = (response: { notification: { request: { content: { data?: Record<string, unknown> } } } } | null) => {
      const url = response?.notification.request.content.data?.url;
      if (typeof url === 'string' && url.startsWith('/')) router.push(url as Href);
    };
    N.getLastNotificationResponseAsync().then(open, () => {});
    const sub = N.addNotificationResponseReceivedListener(open);
    return () => sub.remove();
  }, []);
}
