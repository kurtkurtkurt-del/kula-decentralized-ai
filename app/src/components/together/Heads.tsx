import { StyleSheet, Text, View } from 'react-native';
import InfoTip from '@/components/InfoTip';
import { useLang } from '@/i18n';
import { colors, fonts, radius, tint } from '@/theme/tokens';

// The heads of "see the power" (6.11.2026): one at the top that says this page is a trial,
// between two rules; and one per part (1 estimate · 2 connect · 3 try it), a number, a
// title, a line under it, and a rule above that keeps the parts apart.

export function TrialHeader({ kicker, lede, tag }: { kicker: string; lede: string; tag: string }) {
  const { up } = useLang();
  return (
    <View style={s.header}>
      <View style={s.rule} />
      <View style={s.headRow}>
        <Text style={s.kicker}>{up(kicker)}</Text>
        <View style={s.tag} accessibilityLabel={tag}>
          <View style={s.tagDot} />
          <Text style={s.tagText}>{up(tag)}</Text>
        </View>
      </View>
      <Text style={s.lede}>{lede}</Text>
      <View style={s.rule} />
    </View>
  );
}

export function PartHead({ n, title, hint, info, kind }: { n: number; title: string; hint?: string; info?: string; kind?: string }) {
  const { up } = useLang();
  return (
    <View style={s.part} accessibilityRole="header">
      <View style={s.partRow}>
        <View style={s.num}><Text style={s.numText}>{n}</Text></View>
        <Text style={s.partTitle}>{title}</Text>
        {kind ? <Text style={s.kind}>{up(kind)}</Text> : null}
        {info ? <InfoTip text={info} title={title} /> : null}
      </View>
      {hint ? <Text style={s.hint}>{hint}</Text> : null}
    </View>
  );
}

const s = StyleSheet.create({
  header: { gap: 10, marginBottom: 4 },
  rule: { height: 1, backgroundColor: colors.ink3 },
  headRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 4 },
  kicker: { flex: 1, fontFamily: fonts.regular, fontSize: 10.5, letterSpacing: 1.6, color: colors.spotText },
  tag: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, height: 24, borderRadius: radius.pill, backgroundColor: tint(0.14) },
  tagDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.spot },
  tagText: { fontFamily: fonts.jet, fontSize: 10, letterSpacing: 1.2, color: colors.spotText },
  lede: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 21, color: colors.paper, marginBottom: 4 },
  part: { marginTop: 30, paddingTop: 16, borderTopWidth: 1, borderTopColor: colors.rule, gap: 4, marginBottom: 6 },
  partRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  num: { width: 24, height: 24, borderRadius: 12, borderWidth: 1.2, borderColor: colors.paper, alignItems: 'center', justifyContent: 'center' },
  numText: { fontFamily: fonts.jet, fontSize: 12, color: colors.paper },
  partTitle: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 18, letterSpacing: -0.3, color: colors.paper },
  kind: { fontFamily: fonts.jet, fontSize: 9.5, letterSpacing: 1.1, color: colors.meta, marginLeft: 'auto' },
  hint: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: colors.mute, marginLeft: 34 },
});
