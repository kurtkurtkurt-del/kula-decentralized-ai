import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import Button from '@/components/Button';
import StaffPage from '@/components/StaffPage';
import { combine, rangeOf, rangeText, type Passport } from '@/passport/contract';
import { usePassport, useLinked } from '@/data/passport';
import { useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';

// What if they join? (22.10.2026) Every connected device with all it measured, then two
// ways of working together, estimated by passport/contract.ts combine(): apart (each its
// own model, the speeds add up) and split (one model across the devices: more memory, a
// bigger model, but every token crosses the network). The factors are not calibrated.
type Tab = 'apart' | 'split';
const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

export default function TogetherScreen() {
  const { t, up } = useLang();
  const own = usePassport();
  const linked = useLinked();
  const [tab, setTab] = useState<Tab>('apart');
  const all: { id: string; mine: boolean; p: Passport }[] = [...(own ? [{ id: 'me', mine: true, p: own }] : []), ...linked.map((l) => ({ id: l.id, mine: false, p: l.data }))];
  const c = combine(all.map((a) => a.p));

  return (
    <StaffPage title={t('combine.title')}>
      <Text style={styles.lede}>{t('combine.lede')}</Text>

      {all.map(({ id, mine, p }) => {
        const r = rangeOf(p);
        const rows: [string, string][] = [
          [t('combine.f.chip'), p.soc || '—'],
          [t('combine.f.os'), p.os || p.android || '—'],
          [t('passport.ram'), `${p.ram_total_gb} · ${p.ram_free_gb} ${t('passport.free')}`],
          [t('passport.bw'), p.mem_bw_read_gbs ? `${p.mem_bw_read_gbs} gb/s · ${p.best_threads ?? '?'} ${t('passport.threads')}` : `${p.mem_bw_gbs} gb/s`],
          [t('passport.compute'), p.gflops ? `${p.gflops} gflops` : '—'],
          [t('passport.budget'), p.budget ? `${p.budget.ram_gb} gb · ~${p.budget.q4_k_m_b}B q4` : '—'],
          [t('passport.gpu'), p.gpu ? [p.gpu.model, p.gpu.opencl ? 'opencl' : '', p.gpu.vulkan ? `vulkan ${p.gpu.vulkan}` : ''].filter(Boolean).join(' · ').toLowerCase() || '—' : '—'],
          [t('combine.f.alone'), `${p.estimate?.fit_b ? `~${p.estimate.fit_b}B` : p.largest_model_q4} · ${rangeText(r.low, r.high)} tok/s`],
        ];
        return (
          <View key={id} style={[styles.card, mine && styles.cardMine]}>
            <View style={styles.cardHead}>
              <Text style={styles.cardName} numberOfLines={1}>{p.device.toLowerCase()}</Text>
              <Text style={styles.tag}>{up(mine ? t('devices.this') : t(`combine.kind.${p.kind ?? 'phone'}`))}</Text>
            </View>
            {rows.map(([k, v]) => (
              <View key={k} style={styles.row}>
                <Text style={styles.k}>{k}</Text>
                <Text style={styles.v} numberOfLines={2}>{v}</Text>
              </View>
            ))}
            {p.approx ? <Text style={styles.note}>{t('passport.approx')}</Text> : null}
          </View>
        );
      })}

      {all.length < 2 ? (
        <Text style={styles.empty}>{t('combine.one')}</Text>
      ) : (
        <>
          <View style={styles.tabs} accessibilityRole="tablist">
            {(['apart', 'split'] as const).map((k) => (
              <Pressable key={k} onPress={() => setTab(k)} accessibilityRole="tab" accessibilityState={{ selected: tab === k }} style={[styles.tab, tab === k && styles.tabOn]}>
                <Text style={[styles.tabText, tab === k && styles.tabTextOn]}>{t(`combine.tab.${k}`)}</Text>
              </Pressable>
            ))}
          </View>

          {tab === 'apart' ? (
            <View style={styles.panel}>
              <Text style={styles.big}>{rangeText(c.apart.low, c.apart.high)}</Text>
              <Text style={styles.unit}>tok/s · {t('passport.range')}</Text>
              {c.devices.map((d) => (
                <Text key={d.name} style={styles.line}>{`${d.name.toLowerCase()} · ${rangeText(d.low, d.high)} tok/s · ~${d.fitB || '<1'}B`}</Text>
              ))}
              <Text style={styles.line}>{t('combine.apart.night', { low: fmt(c.apart.tokensLow), high: fmt(c.apart.tokensHigh) })}</Text>
              <Text style={styles.line}>{t('combine.apart.model', { b: c.apart.fitB || '<1' })}</Text>
              <Text style={styles.why}>{t('combine.apart.why')}</Text>
            </View>
          ) : c.split ? (
            <View style={styles.panel}>
              <Text style={styles.big}>~{c.split.fitB}B</Text>
              <Text style={styles.unit}>{t('combine.split.fits', { gb: c.split.budgetGb, alone: c.apart.fitB || '<1' })}</Text>
              {c.split.shares.map((s, i) => (
                <Text key={s.name} style={styles.line}>{`${i + 1}. ${s.name.toLowerCase()} · ${s.gb} gb · ${s.msCool} ms / token`}</Text>
              ))}
              <Text style={styles.line}>{t('combine.split.hops', { n: c.split.hops })}</Text>
              <Text style={[styles.big, styles.bigSmall]}>{rangeText(c.split.low, c.split.high)} tok/s</Text>
              <Text style={styles.line}>{t('combine.split.lean', { tps: c.split.leanHigh })}</Text>
              <Text style={styles.why}>{t(c.split.fitB > c.apart.fitB ? 'combine.split.worth' : 'combine.split.notworth')}</Text>
            </View>
          ) : (
            <Text style={styles.empty}>{t('combine.split.none')}</Text>
          )}
          <Text style={styles.foot}>{up(t('combine.foot'))}</Text>
          {/* 4.11.2026: the estimate above can be tried for real: a model, then the mode question */}
          <View style={{ marginTop: 20 }}>
            <Button label={t('combine.try')} onPress={() => router.push('/models')} kind="line" />
          </View>
        </>
      )}
    </StaffPage>
  );
}

const styles = StyleSheet.create({
  lede: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.mute, marginBottom: 16 },
  card: { borderWidth: 1, borderColor: colors.ink3, borderRadius: radius.md, padding: 14, marginBottom: 12, gap: 6 },
  cardMine: { backgroundColor: colors.ink2, borderColor: colors.ink2 },
  cardHead: { flexDirection: 'row', alignItems: 'baseline', gap: 10, marginBottom: 4 },
  cardName: { flex: 1, fontFamily: fonts.semibold, fontSize: 17, letterSpacing: -0.3, color: colors.paper },
  tag: { fontFamily: fonts.jet, fontSize: 10, letterSpacing: 1, color: colors.spotText },
  row: { flexDirection: 'row', gap: 12 },
  k: { width: 108, fontFamily: fonts.regular, fontSize: 13, color: colors.mute },
  v: { flex: 1, fontFamily: fonts.jet, fontSize: 12, color: colors.paper, textAlign: 'right' },
  note: { fontFamily: fonts.regular, fontSize: 12, color: colors.meta },
  empty: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.mute, marginTop: 10 },
  tabs: { flexDirection: 'row', alignSelf: 'flex-start', padding: 3, borderRadius: radius.pill, backgroundColor: colors.ink2, marginTop: 14 },
  tab: { paddingHorizontal: 14, height: 34, borderRadius: radius.pill, justifyContent: 'center', minHeight: 44 },
  tabOn: { backgroundColor: colors.paper },
  tabText: { fontFamily: fonts.medium, fontSize: 13, color: colors.paper },
  tabTextOn: { color: colors.ink },
  panel: { marginTop: 14, gap: 6 },
  big: { fontFamily: fonts.logo, fontSize: 44, lineHeight: 48, color: colors.paper },
  bigSmall: { fontSize: 30, lineHeight: 34, marginTop: 10 },
  unit: { fontFamily: fonts.regular, fontSize: 13, color: colors.mute, marginBottom: 6 },
  line: { fontFamily: fonts.jet, fontSize: 12, lineHeight: 18, color: colors.paper },
  why: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.paper, marginTop: 10 },
  foot: { fontFamily: fonts.regular, fontSize: 10, letterSpacing: 1.2, color: colors.meta, marginTop: 22 },
});
