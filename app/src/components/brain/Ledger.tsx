import { StyleSheet, Text, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';
import { sparkPath } from './geometry';

// The ledger at a glance (5.11.2026): three tiles (refused, warnings, signed lines) with a
// count and the last 24 hours as a sparkline, and a lock for the chain: closed sage when every
// line carries the hash of the one before, open terracotta when it does not. The lines
// themselves are behind "the full ledger".

export type Tile = { n: number; label: string; color: string; spark: number[] };

const SW = 100;
const SH = 24;

function Spark({ values, color }: { values: number[]; color: string }) {
  const line = sparkPath(values, SW, SH);
  if (!line) return null;
  return (
    <Svg width="100%" height={SH} viewBox={`0 0 ${SW} ${SH}`} preserveAspectRatio="none">
      <Path d={`${line} L${SW} ${SH} L0 ${SH} Z`} fill={color} opacity={0.12} />
      <Path d={line} stroke={color} strokeWidth={1.5} fill="none" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </Svg>
  );
}

export function Lock({ ok, size = 18 }: { ok: boolean; size?: number }) {
  const color = ok ? colors.green : colors.violet;
  const p = { stroke: color, strokeWidth: 1.7, fill: 'none', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Rect x={5} y={10.5} width={14} height={10} rx={2.2} {...p} fill={color} fillOpacity={0.14} />
      <Path d={ok ? 'M8 10.5V8a4 4 0 0 1 8 0v2.5' : 'M8 10.5V8a4 4 0 0 1 7.6-1.7'} {...p} />
      <Path d="M12 14.5v2.4" {...p} />
    </Svg>
  );
}

export default function Ledger({ tiles, chain }: { tiles: Tile[]; chain: { ok: boolean; text: string; a11y: string } | null }) {
  const { t } = useLang();
  return (
    <View style={styles.wrap}>
      <View style={styles.tiles}>
        {tiles.map((x) => {
          const day = x.spark.reduce((a, v) => a + v, 0);
          return (
            <View key={x.label} style={styles.tile} accessible accessibilityLabel={t('brain.a11y.tile', { n: x.n, what: x.label, day })}>
              <Text style={[styles.n, { color: x.color }]}>{x.n}</Text>
              <Text style={styles.label} numberOfLines={1}>{x.label}</Text>
              <View style={styles.spark}>
                <Spark values={x.spark} color={x.color} />
              </View>
            </View>
          );
        })}
      </View>
      {chain ? (
        <View style={[styles.chain, !chain.ok && styles.chainBad]} accessible accessibilityLabel={chain.a11y}>
          <Lock ok={chain.ok} />
          <Text style={[styles.chainText, !chain.ok && styles.chainBadText]}>{chain.text}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 4, gap: 10 },
  tiles: { flexDirection: 'row', gap: 8 },
  tile: { flex: 1, backgroundColor: colors.ink2, borderRadius: radius.md, paddingTop: 12, paddingHorizontal: 12, paddingBottom: 8, overflow: 'hidden' },
  n: { fontFamily: fonts.semibold, fontSize: 26, letterSpacing: -0.8, lineHeight: 30 },
  label: { fontFamily: fonts.regular, fontSize: 12, color: colors.mute },
  spark: { marginTop: 8, marginHorizontal: -2 },
  chain: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', paddingVertical: 6, paddingLeft: 8, paddingRight: 12, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.ink3 },
  chainBad: { borderColor: colors.violet, backgroundColor: 'rgba(200,106,81,0.08)' },
  chainText: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.paper2 },
  chainBadText: { color: colors.violet },
});
