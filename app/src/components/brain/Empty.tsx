import { Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';
import { colors, fonts, radius } from '@/theme/tokens';

// An empty place on the brain tab (5.11.2026): a small drawing and one line. The full
// sentence of what to do is the accessibility label, for the ones who listen.
export type EmptyKind = 'model' | 'decisions' | 'ledger' | 'error';

function Drawing({ kind }: { kind: EmptyKind }) {
  const p = { stroke: kind === 'error' ? colors.violet : colors.meta, strokeWidth: 1.5, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (kind) {
    case 'model': // a node with nothing in its ring
      return (
        <>
          <Circle cx={22} cy={22} r={13} {...p} strokeDasharray="3 4" />
          <Rect x={18.5} y={16} width={7} height={12} rx={1.8} {...p} />
        </>
      );
    case 'decisions': // a rail with three quiet stops
      return (
        <>
          <Line x1={14} y1={8} x2={14} y2={36} {...p} stroke={colors.ink3} />
          {[11, 22, 33].map((y) => (
            <Circle key={y} cx={14} cy={y} r={3.2} {...p} fill={colors.ink} />
          ))}
          {[11, 22, 33].map((y, i) => (
            <Line key={`t${y}`} x1={22} y1={y} x2={36 - i * 5} y2={y} {...p} stroke={colors.ink3} />
          ))}
        </>
      );
    case 'ledger': // a page, a lock
      return (
        <>
          <Rect x={9} y={7} width={20} height={27} rx={2.5} {...p} />
          <Path d="M14 15h10M14 20h10M14 25h6" {...p} stroke={colors.ink3} />
          <Rect x={25} y={27} width={11} height={9} rx={2} {...p} fill={colors.ink} />
          <Path d="M27.5 27v-2.2a3 3 0 0 1 6 0V27" {...p} />
        </>
      );
    case 'error': // a node, crossed
      return (
        <>
          <Circle cx={22} cy={22} r={13} {...p} />
          <Path d="M17 17l10 10M27 17l-10 10" {...p} />
        </>
      );
  }
}

export default function Empty({ kind, text, a11y, action, onAction }: { kind: EmptyKind; text: string; a11y?: string; action?: string; onAction?: () => void }) {
  return (
    <View style={styles.box}>
      <View style={styles.main} accessible accessibilityRole="summary" accessibilityLabel={a11y ?? text}>
        <Svg width={44} height={44} viewBox="0 0 44 44">
          <Drawing kind={kind} />
        </Svg>
        <Text style={[styles.text, kind === 'error' && styles.bad]} numberOfLines={2}>{text}</Text>
      </View>
      {action && onAction ? (
        <Pressable onPress={onAction} hitSlop={8} accessibilityRole="button" accessibilityLabel={action} style={({ pressed }) => [styles.btn, pressed && styles.pressed]}>
          <Text style={styles.btnText}>{action} ›</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6, paddingVertical: 10, paddingHorizontal: 12, borderRadius: radius.md, backgroundColor: colors.ink2 },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  text: { flex: 1, fontFamily: fonts.regular, fontSize: 14, lineHeight: 19, color: colors.paper2 },
  bad: { color: colors.violet },
  btn: { minHeight: 36, justifyContent: 'center', paddingHorizontal: 12, borderRadius: radius.pill, backgroundColor: colors.paper },
  btnText: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.ink },
  pressed: { opacity: 0.7 },
});
