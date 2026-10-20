import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { colors, fonts, radius, tint } from '@/theme/tokens';

// The small actions around a person or a thing — remove, block, report, close, sign
// out — as pills with a glyph instead of underlined words. quiet for the everyday
// ones, danger (red) for what cannot be taken back lightly. surface says what they
// sit on: the dark pages (ink) or the light cards (paper).
export type PillIcon = 'block' | 'flag' | 'minus' | 'close' | 'out' | 'retry' | 'trash' | 'link';
type Props = {
  label: string;
  onPress?: () => void;
  icon?: PillIcon;
  tone?: 'quiet' | 'danger';
  surface?: 'ink' | 'paper';
  small?: boolean;
  wide?: boolean;
  disabled?: boolean;
};

export default function PillAction({ label, onPress, icon, tone = 'quiet', surface = 'ink', small, wide, disabled }: Props) {
  const look = LOOK[surface][tone];
  const size = small ? 13 : 15;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.base,
        small ? styles.small : styles.normal,
        wide && styles.wide,
        { borderColor: look.border, backgroundColor: look.fill },
        pressed && styles.pressed,
        disabled && styles.off,
      ]}
    >
      {icon ? <Glyph name={icon} size={size} color={look.text} /> : null}
      <Text style={[styles.label, small && styles.labelSmall, { color: look.text }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
        {label}
      </Text>
    </Pressable>
  );
}

// A row of them, wrapping on narrow phones.
export function PillRow({ children, center }: { children: ReactNode; center?: boolean }) {
  return <View style={[styles.row, center && styles.center]}>{children}</View>;
}

const LOOK = {
  ink: {
    quiet: { border: colors.ink3, fill: 'rgba(17,17,17,0.05)', text: colors.paper },
    danger: { border: tint(0.55), fill: tint(0.12), text: colors.spotText },
  },
  paper: {
    quiet: { border: colors.rule, fill: 'rgba(255,255,255,0.03)', text: colors.ink },
    danger: { border: tint(0.45), fill: tint(0.07), text: colors.spot },
  },
} as const;

function Glyph({ name, size, color }: { name: PillIcon; size: number; color: string }) {
  const p = { stroke: color, strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16">
      {name === 'block' && (
        <>
          <Circle cx={8} cy={8} r={6.2} {...p} />
          <Line x1={3.7} y1={12.3} x2={12.3} y2={3.7} {...p} />
        </>
      )}
      {name === 'flag' && (
        <>
          <Line x1={3.5} y1={14.5} x2={3.5} y2={2} {...p} />
          <Path d="M3.5 2.5h8.5l-2 3.25 2 3.25H3.5" {...p} />
        </>
      )}
      {name === 'minus' && (
        <>
          <Circle cx={6.5} cy={5} r={2.6} {...p} />
          <Path d="M1.8 13.5c.6-2.6 2.4-4 4.7-4s4.1 1.4 4.7 4" {...p} />
          <Line x1={11} y1={7} x2={15} y2={7} {...p} />
        </>
      )}
      {name === 'close' && (
        <>
          <Line x1={3.5} y1={3.5} x2={12.5} y2={12.5} {...p} />
          <Line x1={12.5} y1={3.5} x2={3.5} y2={12.5} {...p} />
        </>
      )}
      {name === 'out' && (
        <>
          <Path d="M9.5 2.5h-6v11h6" {...p} />
          <Line x1={7} y1={8} x2={14.5} y2={8} {...p} />
          <Path d="M11.8 5.3 14.5 8l-2.7 2.7" {...p} />
        </>
      )}
      {name === 'retry' && (
        <>
          <Path d="M13 8a5 5 0 1 1-1.5-3.6" {...p} />
          <Path d="M11.8 1.8v2.9H8.9" {...p} />
        </>
      )}
      {name === 'trash' && (
        <>
          <Line x1={2.5} y1={4} x2={13.5} y2={4} {...p} />
          <Path d="M6 4V2.5h4V4M4 4l.8 9.5h6.4L12 4" {...p} />
        </>
      )}
      {name === 'link' && (
        <>
          <Path d="M9.5 2.5h4v4" {...p} />
          <Line x1={13.5} y1={2.5} x2={7.5} y2={8.5} {...p} />
          <Path d="M12 9.5v4h-9.5V4h4" {...p} />
        </>
      )}
    </Svg>
  );
}

const styles = StyleSheet.create({
  base: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1, borderRadius: radius.pill, alignSelf: 'flex-start' },
  normal: { height: 40, paddingHorizontal: 16 },
  small: { height: 30, paddingHorizontal: 12, gap: 6 },
  wide: { alignSelf: 'stretch' },
  label: { fontFamily: fonts.medium, fontSize: 14, letterSpacing: -0.1 },
  labelSmall: { fontSize: 12.5 },
  pressed: { opacity: 0.7, transform: [{ scale: 0.97 }] },
  off: { opacity: 0.4 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  center: { justifyContent: 'center' },
});
