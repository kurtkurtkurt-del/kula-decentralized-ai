import { Platform } from 'react-native';
import { notifications } from '@/lib/push';

// A local notification when a project's answer is ready (trigger: now, nothing leaves the
// phone). Tapping it opens the project (lib/push.ts usePushRouting reads data.url). Fails
// soft, like the night's own notification (night/notify.ts).
const CHANNEL = 'projects';

export async function notifyTaskDone(id: string, title: string, body: string) {
  const N = notifications();
  if (!N || Platform.OS === 'web') return;
  try {
    if (Platform.OS === 'android') await N.setNotificationChannelAsync(CHANNEL, { name: 'projects', importance: N.AndroidImportance.DEFAULT });
    if ((await N.getPermissionsAsync()).status !== 'granted') return;
    await N.scheduleNotificationAsync({ identifier: `task-${id}`, content: { title, body, data: { url: `/task/${id}` } }, trigger: Platform.OS === 'android' ? { channelId: CHANNEL } : null });
  } catch {}
}
