import { Pressable, StyleSheet, Text } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors, fonts, radius } from '@/theme/tokens';

// A filter pill (the flow and the map): ink glass by default, paper when a filter is set.
export default function Pill({ label, active, onPress, a11y, chevron = true }: { label: string; active: boolean; onPress: () => void; a11y: string; chevron?: boolean }) {
  return (
    <Pressable onPress={onPress} hitSlop={6} accessibilityRole="button" accessibilityLabel={a11y} style={({ pressed }) => [styles.pill, active && styles.pillOn, pressed && styles.pressed]}>
      <Text style={[styles.pillText, active && styles.pillTextOn]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{label}</Text>
      {chevron ? <Chevron color={active ? colors.ink : colors.mute} /> : null}
    </Pressable>
  );
}

export function Chevron({ color }: { color: string }) {
  return (
    <Svg width={10} height={6} viewBox="0 0 10 6">
      <Path d="M1 1l4 4 4-4" stroke={color} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  pill: { flexShrink: 1, flexDirection: 'row', alignItems: 'center', gap: 7, height: 32, paddingHorizontal: 13, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.82)', borderWidth: 1, borderColor: colors.ink3 },
  pillOn: { backgroundColor: colors.paper, borderColor: colors.paper },
  pillText: { flexShrink: 1, fontFamily: fonts.medium, fontSize: 13, letterSpacing: -0.1, color: colors.paper },
  pillTextOn: { color: colors.ink },
  pressed: { opacity: 0.6 },
});
