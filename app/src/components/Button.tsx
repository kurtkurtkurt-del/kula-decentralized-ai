import { Pressable, StyleSheet, Text } from 'react-native';
import { colors, fonts, radius } from '@/theme/tokens';

type Props = { label: string; onPress?: () => void; kind?: 'fill' | 'line' | 'red'; disabled?: boolean; accessibilityHint?: string };

// Three button styles on dark backgrounds: filled (paper), outlined (paper border), and
// red for the one action a page leads with (the night page's ticket, 12.10.2026).
export default function Button({ label, onPress, kind = 'fill', disabled, accessibilityHint }: Props) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [styles.base, kind === 'fill' ? styles.fill : kind === 'red' ? styles.red : styles.line, disabled && styles.disabled, pressed && styles.pressed]}
    >
      <Text style={[styles.label, kind === 'fill' ? styles.labelInk : styles.labelPaper]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { minHeight: 52, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: colors.paper, borderRadius: radius.md },
  fill: { backgroundColor: colors.paper },
  line: { backgroundColor: 'transparent' },
  red: { backgroundColor: colors.spot, borderColor: colors.spot },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.45 },
  label: { fontFamily: fonts.medium, fontSize: 16, letterSpacing: -0.2 },
  labelInk: { color: colors.ink },
  labelPaper: { color: colors.paper },
});
