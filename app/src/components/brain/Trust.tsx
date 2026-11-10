import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLang } from '@/i18n';
import { sayCheck, sayHeadline, type ClusterReport, type Verdict } from '@/llm/trust';
import { colors, fonts, radius } from '@/theme/tokens';
import { Lock } from './Ledger';

// Trust and verification on the brain tab (10.11.2026, src/llm/trust.ts): one verdict on top,
// green all clear, terracotta look at this, grey not checked yet, the headline under it, and a
// line per device. The checks themselves are on the trust screen behind it.

export const TRUST_COLOR: Record<Verdict, string> = { ok: colors.green, bad: colors.violet, unknown: colors.meta };

export default function Trust({ report, self, onPress }: { report: ClusterReport; self: string; onPress?: () => void }) {
  const { t, tx } = useLang();
  const color = TRUST_COLOR[report.verdict];
  const verdict = t(`trust.verdict.${report.verdict}`);
  const headline = sayHeadline(report.headline, tx, self);
  const lines = report.devices.map((d) => {
    const bad = d.checks.find((c) => c.ok === false);
    return { id: d.id, name: d.name, color: TRUST_COLOR[d.verdict], text: bad ? sayCheck(bad, tx) : t(`trust.verdict.${d.verdict}`) };
  });
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel={[verdict, headline, ...lines.map((l) => `${l.name}: ${l.text}`)].join('. ')}
      style={({ pressed }) => [styles.card, report.verdict === 'bad' && styles.cardBad, pressed && styles.pressed]}
    >
      <View style={styles.top}>
        {report.verdict === 'unknown' ? <View style={[styles.ring, { borderColor: color }]} /> : <Lock ok={report.verdict === 'ok'} size={22} />}
        <Text style={[styles.verdict, { color: report.verdict === 'unknown' ? colors.paper2 : color }]}>{verdict}</Text>
      </View>
      <Text style={styles.headline}>{headline}</Text>
      {lines.length > 1 || report.verdict !== 'ok' ? (
        <View style={styles.rows}>
          {lines.map((l) => (
            <View key={l.id} style={styles.row}>
              <View style={[styles.dot, { backgroundColor: l.color }]} />
              <Text style={styles.name} numberOfLines={1}>{l.name}</Text>
              <Text style={styles.text} numberOfLines={1}>{l.text}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, borderRadius: radius.md, backgroundColor: colors.ink2, marginTop: 4, gap: 6, borderWidth: 1, borderColor: 'transparent' },
  cardBad: { borderColor: colors.violet },
  top: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ring: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, marginHorizontal: 3 },
  verdict: { fontFamily: fonts.semibold, fontSize: 20, letterSpacing: -0.4 },
  headline: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, color: colors.paper2 },
  rows: { marginTop: 4, gap: 5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  name: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.paper, maxWidth: 110 },
  text: { flex: 1, fontFamily: fonts.regular, fontSize: 12, color: colors.mute },
  pressed: { opacity: 0.75 },
});
