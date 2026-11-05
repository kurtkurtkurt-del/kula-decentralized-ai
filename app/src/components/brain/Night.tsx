import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { colors, fonts, radius } from '@/theme/tokens';
import { ringDash } from './geometry';

// The night at a glance (5.11.2026): a ring for tonight's window, filled as far as the night
// has gone, coloured by what the worker does; in its middle the units done (or the tokens,
// when it only simulates); beside it one status line, the window's hours and the last
// morning report's numbers as chips. All of it said in one sentence for a screen reader.

const S = 92;
const R = 38;
const STROKE = 7;

export type NightProps = {
  frac: number;
  color: string;
  center: string | null; // the big number in the ring, or null for the moon
  centerLabel: string;
  status: string;
  window: string;
  chips: string[];
  noReport: string | null;
  a11y: string;
};

export default function Night({ frac, color, center, centerLabel, status, window, chips, noReport, a11y }: NightProps) {
  const ring = ringDash(frac, R);
  const c = S / 2;
  return (
    <View style={styles.card} accessible accessibilityLabel={a11y}>
      <View style={styles.ring}>
        <Svg width={S} height={S} viewBox={`0 0 ${S} ${S}`}>
          <Circle cx={c} cy={c} r={R} stroke={colors.ink3} strokeWidth={STROKE} fill="none" />
          {ring.length > 0 ? (
            <Circle cx={c} cy={c} r={R} stroke={color} strokeWidth={STROKE} fill="none" strokeDasharray={ring.dash} strokeLinecap="round" transform={`rotate(-90 ${c} ${c})`} />
          ) : null}
          {center == null ? (
            <Path
              transform={`translate(${c - 16.8} ${c - 16.8}) scale(1.4)`}
              d="M15.5 15.8A5.5 5.5 0 0 1 10 6.2a5.6 5.6 0 1 0 5.5 9.6z"
              stroke={colors.meta}
              strokeWidth={1.6}
              fill="none"
              strokeLinejoin="round"
            />
          ) : null}
        </Svg>
        {center != null ? (
          <View style={styles.middle} pointerEvents="none">
            <Text style={styles.big} numberOfLines={1} adjustsFontSizeToFit>{center}</Text>
            <Text style={styles.small} numberOfLines={1}>{centerLabel}</Text>
          </View>
        ) : null}
      </View>
      <View style={styles.side}>
        <View style={styles.statusRow}>
          <View style={[styles.dot, { backgroundColor: color }]} />
          <Text style={styles.status} numberOfLines={2}>{status}</Text>
        </View>
        <Text style={styles.window}>{window}</Text>
        {chips.length ? (
          <View style={styles.chips}>
            {chips.map((x) => (
              <View key={x} style={styles.chip}><Text style={styles.chipText}>{x}</Text></View>
            ))}
          </View>
        ) : noReport ? (
          <Text style={styles.none}>{noReport}</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: radius.md, backgroundColor: colors.ink2, marginTop: 4 },
  ring: { width: S, height: S },
  middle: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  big: { fontFamily: fonts.semibold, fontSize: 22, letterSpacing: -0.6, color: colors.paper },
  small: { fontFamily: fonts.regular, fontSize: 10, color: colors.mute, marginTop: -2 },
  side: { flex: 1, gap: 6 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  status: { flex: 1, fontFamily: fonts.medium, fontSize: 14, color: colors.paper },
  window: { fontFamily: fonts.jet, fontSize: 11, color: colors.mute },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  chip: { paddingHorizontal: 8, height: 22, borderRadius: radius.pill, backgroundColor: colors.ink, justifyContent: 'center' },
  chipText: { fontFamily: fonts.medium, fontSize: 11.5, color: colors.paper2 },
  none: { fontFamily: fonts.regular, fontSize: 12, color: colors.meta },
});
