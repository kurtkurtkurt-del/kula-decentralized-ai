import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';

// Small taps (5.11.2026): a tick on a choice, a bump when a download lands. Never throws:
// web has no motor, an emulator may not either.
const safe = (fn: () => Promise<void>) => {
  if (Platform.OS === 'web') return;
  try {
    fn().catch(() => {});
  } catch {}
};
export const tapSelect = () => safe(() => Haptics.selectionAsync());
export const tapLight = () => safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
export const tapDone = () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
export const tapFail = () => safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
