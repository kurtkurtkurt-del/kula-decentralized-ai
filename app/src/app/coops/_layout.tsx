import { View } from 'react-native';
import { Slot } from 'expo-router';
import NotPublished from '@/components/NotPublished';

// 8.11.2026: the coops (who you work nights with) are not published yet. Every coop screen
// shows dimmed under a "not published yet" note, whichever way it was reached.
export default function CoopsLayout() {
  return (
    <View style={{ flex: 1 }}>
      <Slot />
      <NotPublished />
    </View>
  );
}
