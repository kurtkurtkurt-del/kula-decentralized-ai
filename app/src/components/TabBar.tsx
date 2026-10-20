import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, View, type PressableProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Icon, { type IconName } from '@/components/Icon';
import { useLang } from '@/i18n';
import { tabPressedAgain } from '@/hooks/useTabReset';
import { colors } from '@/theme/tokens';

// Instagram-style: a full-width bar on the bottom edge, ink with a hairline on top,
// five icons with no labels. The open tab's icon is solid, the others outlined; the
// account tab is your photo, ringed when open. The triggers stay in (tabs)/_layout.tsx,
// so a new design only touches this file.

const BAR = 52;
// Android: the system navigation bar is hidden (root _layout), so the inset is 0 and the
// icons sat in the strip where a swipe brings the system bar back. The bar keeps that
// strip as empty ink and puts its icons above it.
const LIFT = Platform.OS === 'android' ? 22 : 0;
export const TAB_BAR_SPACE = BAR + 8 + LIFT; // space pages leave at the bottom (excluding the inset)
// Including the inset: the bar grows by the home indicator's height.
export function useTabBarSpace() {
  const insets = useSafeAreaInsets();
  return TAB_BAR_SPACE + insets.bottom;
}

type ItemProps = PressableProps & { icon: IconName; isFocused?: boolean };

export function TabItem({ icon, isFocused, onPress, ...props }: ItemProps) {
  const { tx } = useLang();
  return (
    <Pressable
      {...props}
      // Pressing the open tab again resets it to its start.
      onPress={(e) => {
        if (isFocused) tabPressedAgain(icon);
        onPress?.(e);
      }}
      accessibilityRole="tab"
      accessibilityLabel={tx('tab.' + icon, icon)}
      accessibilityState={{ selected: !!isFocused }}
      style={({ pressed }) => [styles.item, pressed && styles.pressed]}
    >
      <Icon name={icon} size={26} color={colors.paper} filled={!!isFocused} strokeWidth={1.7} />
    </Pressable>
  );
}

export function TabBarFrame({ children }: { children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { paddingBottom: insets.bottom + LIFT }]}>
      <View style={styles.row}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0, backgroundColor: colors.ink, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.ink3 },
  row: { height: BAR, flexDirection: 'row', alignItems: 'center' },
  item: { flex: 1, height: BAR, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
});
