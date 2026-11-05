import { Platform } from 'react-native';
import { notifications } from '@/lib/push';

// The night's notification (night-2): one sticky line while the worker runs, so the
// person who picks the phone up at three sees what it is doing; gone when it stops. Local
// only (trigger null = now); on Android it needs its own channel and, from 13 on, the
// permission the push setup already asks for. Every call fails soft: a night without
// a notification is still a night.
const ID = 'night-running';
const CHANNEL = 'night';
let shown = false;

export async function showNightNotification(title: string, body: string) {
  const N = notifications();
  if (!N || Platform.OS === 'web') return;
  try {
    if (Platform.OS === 'android') await N.setNotificationChannelAsync(CHANNEL, { name: 'night', importance: N.AndroidImportance.LOW, sound: null, vibrationPattern: [0] });
    if ((await N.getPermissionsAsync()).status !== 'granted') return;
    await N.scheduleNotificationAsync({ identifier: ID, content: { title, body, sticky: true, autoDismiss: false, sound: false }, trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null });
    shown = true;
  } catch {}
}
export async function hideNightNotification() {
  const N = notifications();
  if (!N || !shown) return;
  shown = false;
  try {
    await N.dismissNotificationAsync(ID);
  } catch {}
}
