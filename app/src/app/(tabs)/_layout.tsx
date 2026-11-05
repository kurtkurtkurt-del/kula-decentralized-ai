import { useEffect, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import { TabList, TabSlot, TabTrigger, Tabs, type TabsSlotRenderOptions } from 'expo-router/ui';
import { Screen } from 'react-native-screens';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { TabBarFrame, TabItem } from '@/components/TabBar';

// The main app: five tabs in an edge-to-edge bottom bar. models · messages · the brain ·
// connect · passport. The brain (beyin at work on this phone) sits in the middle (5.11.2026).
export default function TabsLayout() {
  return (
    <Tabs>
      <TabSlot renderFn={renderTab} />
      <TabList asChild>
        <TabBarFrame>
          <TabTrigger name="models" href="/models" asChild>
            <TabItem icon="models" />
          </TabTrigger>
          <TabTrigger name="messages" href="/messages" asChild>
            <TabItem icon="chat" />
          </TabTrigger>
          <TabTrigger name="brain" href="/brain" asChild>
            <TabItem icon="brain" />
          </TabTrigger>
          <TabTrigger name="people" href="/people" asChild>
            <TabItem icon="people" />
          </TabTrigger>
          <TabTrigger name="passport" href="/passport" asChild>
            <TabItem icon="passport" />
          </TabTrigger>
        </TabBarFrame>
      </TabList>
    </Tabs>
  );
}

type Descriptor = Parameters<NonNullable<Parameters<typeof TabSlot>[0]['renderFn']>>[0];
function renderTab(descriptor: Descriptor, { isFocused, loaded, detachInactiveScreens }: TabsSlotRenderOptions) {
  if (!loaded && !isFocused) return null;
  return (
    <Screen key={descriptor.route.key} enabled={detachInactiveScreens} activityState={isFocused ? 2 : 0} style={[styles.screen, isFocused ? styles.focused : styles.unfocused]}>
      <TabFade focused={isFocused}>{descriptor.render()}</TabFade>
    </Screen>
  );
}
const IN = { duration: 260, easing: Easing.out(Easing.cubic) };
function TabFade({ focused, children }: { focused: boolean; children: ReactNode }) {
  const shown = useSharedValue(0);
  useEffect(() => {
    if (focused) {
      shown.set(0);
      shown.set(withTiming(1, IN));
    }
  }, [focused, shown]);
  const style = useAnimatedStyle(() => ({ opacity: shown.get(), transform: [{ translateY: (1 - shown.get()) * 8 }] }));
  return <Animated.View style={[styles.fill, style]}>{children}</Animated.View>;
}
const styles = StyleSheet.create({
  fill: { flex: 1 },
  screen: { flex: 1, position: 'relative', height: '100%' },
  focused: { zIndex: 1, display: 'flex', flexShrink: 0, flexGrow: 1 },
  unfocused: { zIndex: -1, display: 'none', flexShrink: 1, flexGrow: 0 },
});
