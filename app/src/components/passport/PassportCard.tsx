import { useMemo, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { fitLabelOf, type Passport } from '@/data/passport';
import { upperData, useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';

// The passport card on the passport tab (6.11.2026): the front holds only the essentials
// (the device, the model it can run, three numbers); the "i" at the top right turns the
// card over (a rotateY flip: to 90° edge-on, swap the face, from -90° back to 0°) and the
// back holds the full passport, everything the measurement wrote. The "i" turns it back.
const two = (n: number) => String(n).padStart(2, '0');
const at = (iso: string) => {
  const d = new Date(iso);
  return `${two(d.getDate())}.${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}`;
};
const HALF = 170; // ms per half of the turn

type Props = { passport: Passport | null; title: string; busy: boolean };

export default function PassportCard({ passport, title, busy }: Props) {
  const { t, up } = useLang();
  const [side, setSide] = useState<'front' | 'back'>('front');
  const [turn] = useState(() => new Animated.Value(0)); // -1 … 0 … 1 = -90° … 0° … 90°
  const moving = useRef(false);

  const flip = () => {
    if (moving.current) return;
    moving.current = true;
    Animated.timing(turn, { toValue: 1, duration: HALF, easing: Easing.in(Easing.quad), useNativeDriver: true }).start(() => {
      setSide((s) => (s === 'front' ? 'back' : 'front'));
      turn.setValue(-1);
      Animated.timing(turn, { toValue: 0, duration: HALF, easing: Easing.out(Easing.quad), useNativeDriver: true }).start(() => {
        moving.current = false;
      });
    });
  };
  const rotateY = useMemo(() => turn.interpolate({ inputRange: [-1, 0, 1], outputRange: ['-90deg', '0deg', '90deg'] }), [turn]);
  const scale = useMemo(() => turn.interpolate({ inputRange: [-1, 0, 1], outputRange: [0.96, 1, 0.96] }), [turn]);
  const back = side === 'back' && !!passport;

  const infoButton = passport ? (
    <Pressable
      onPress={flip}
      hitSlop={12}
      accessibilityRole="button"
      accessibilityLabel={back ? t('passportui.close') : t('passportui.open')}
      style={({ pressed }) => [s.info, back && s.infoOn, pressed && s.pressed]}
    >
      <Text style={[s.infoText, back && s.infoTextOn]}>{back ? '×' : 'i'}</Text>
    </Pressable>
  ) : null;

  return (
    <Animated.View style={[s.card, { transform: [{ perspective: 1000 }, { rotateY }, { scale }] }]}>
      {back && passport ? renderBack(passport) : renderFront(passport, title, busy)}
      {infoButton}
    </Animated.View>
  );

  function renderFront(p: Passport | null, name: string, b: boolean) {
    const fit = p ? fitLabelOf(p) : '—';
    const speed = p ? (p.estimate && p.estimate.tps_high > 0 ? `${p.estimate.tps_low}–${p.estimate.tps_high}` : String(p.est_tps)) : '—';
    return (
      <>
        <View style={s.red}>
          <Text style={[s.redMono, s.clearInfo]} numberOfLines={1}>{up(t('passport.kicker'))}{p ? ` · ${upperData(p.soc)}` : ''}</Text>
          <Text style={[s.name, s.clearInfo]} numberOfLines={2}>{p ? p.device.toLowerCase() : name}</Text>
          <Text style={s.redMono}>{up(t('passportui.runs'))}</Text>
          <Text style={s.big}>{b ? '…' : fit}</Text>
        </View>
        <View style={s.paper}>
          {p ? (
            <>
              <View style={s.stats}>
                <Stat v={`${p.ram_total_gb}`} unit="gb" k={t('passportui.ram')} />
                <View style={s.statRule} />
                <Stat v={speed} k={t('passportui.speed')} />
                <View style={s.statRule} />
                <Stat v={`${Math.round(p.gflops)}`} k={t('passportui.compute')} />
              </View>
              <Text style={s.foot}>{up(t('passportui.measured', { at: at(p.measured_at) }))}{p.approx ? ` · ${up(t('passport.approx'))}` : ''}</Text>
            </>
          ) : (
            <>
              <Text style={s.paperNote}>{t('passport.none')}</Text>
              <Text style={[s.paperNote, s.dim]}>{t('passport.measure.hint')}</Text>
            </>
          )}
        </View>
      </>
    );
  }

  function renderBack(p: Passport) {
    return (
      <View style={s.paper}>
        <Text style={[s.backHead, s.clearInfo]}>{up(t('passportui.back'))}</Text>
        <Text style={[s.backName, s.clearInfo]} numberOfLines={2}>{p.device.toLowerCase()} · {p.soc.toLowerCase()}</Text>
        <View style={s.rule} />
        <Row k={t('passport.largest')} v={p.estimate ? `${fitLabelOf(p)} · q4_k_m · ${p.estimate.tps_low}–${p.estimate.tps_high} tok/s` : `${p.largest_model_q4} · q4 · ${p.est_tps} tok/s`} />
        {p.estimate ? <Row k={t('passport.speed')} v={t('passport.range')} /> : null}
        <Row k={t('passport.ram')} v={`${p.ram_total_gb} · ${p.ram_free_gb} ${t('passport.free')}`} />
        <Row k={t('passport.cap')} v={`${p.app_mem_cap_mb} mb`} />
        <Row k={t('passport.cpu')} v={p.cpu_cores ? `${p.cpu_cores} × ${p.cpu_max_ghz} ghz` : '—'} />
        <Row k={t('passport.bw')} v={p.mem_bw_read_gbs ? `${p.mem_bw_read_gbs} gb/s · ${p.best_threads} ${t('passport.threads')}` : `${p.mem_bw_gbs} gb/s`} />
        {p.budget ? <Row k={t('passport.budget')} v={`${p.budget.ram_gb} gb · ~${p.budget.q4_k_m_b}B q4 · ~${p.budget.q3_k_s_b}B q3`} /> : null}
        {p.gpu ? <Row k={t('passport.gpu')} v={[p.gpu.model, p.gpu.opencl ? 'opencl' : '', p.gpu.vulkan ? `vulkan ${p.gpu.vulkan}` : ''].filter(Boolean).join(' · ').toLowerCase() || '—'} /> : null}
        {p.thermal ? <Row k={t('passport.heat')} v={`${p.thermal.status >= 0 ? p.thermal.status : '—'} · ${p.thermal.battery_c >= 0 ? `${p.thermal.battery_c} °c` : '—'}`} /> : null}
        {p.wifi ? <Row k={t('passport.wifi')} v={p.wifi.band ? `${p.wifi.band} ghz · ${p.wifi.link_mbps} mbps` : '—'} /> : null}
        <Row k={t('passport.compute')} v={`${p.gflops} gflops`} />
        <Row k={`${t('passport.disk')} · ${t('passport.battery')}`} v={`${p.storage_free_gb || '—'} gb · ${p.battery_pct || '—'}%${p.charging ? ' ⚡' : ''}`} />
        <View style={s.rule} />
        <View style={s.between}>
          <Text style={s.paperMono}>{upperData(p.android)}{p.approx ? ` · ${up(t('passport.approx'))}` : ''}</Text>
          <Text style={s.paperMono}>{at(p.measured_at)}</Text>
        </View>
      </View>
    );
  }
}

function Stat({ v, unit, k }: { v: string; unit?: string; k: string }) {
  return (
    <View style={s.stat}>
      <Text style={s.statV} numberOfLines={1} adjustsFontSizeToFit>
        {v}
        {unit ? <Text style={s.statUnit}>{` ${unit}`}</Text> : null}
      </Text>
      <Text style={s.statK}>{k}</Text>
    </View>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={s.kv}>
      <Text style={s.kvK}>{k}</Text>
      <Text style={s.kvV}>{v}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  card: { borderRadius: radius.md, overflow: 'hidden', borderWidth: 1, borderColor: colors.ink3, backgroundColor: colors.paper },
  red: { backgroundColor: colors.spot, padding: 16, gap: 2 },
  redMono: { fontFamily: fonts.jet, fontSize: 10, letterSpacing: 1.4, color: colors.paper, opacity: 0.85 },
  name: { fontFamily: fonts.semibold, fontSize: 22, lineHeight: 26, letterSpacing: -0.5, color: colors.paper, marginTop: 6, marginBottom: 14 },
  big: { fontFamily: fonts.logo, fontSize: 52, lineHeight: 56, color: colors.paper },
  clearInfo: { paddingRight: 40 },
  info: { position: 'absolute', top: 12, right: 12, width: 28, height: 28, borderRadius: 14, borderWidth: 1.5, borderColor: colors.paper, alignItems: 'center', justifyContent: 'center' },
  infoOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  infoText: { fontFamily: fonts.semibold, fontSize: 15, lineHeight: 18, color: colors.paper },
  infoTextOn: { fontSize: 18, lineHeight: 20 },
  pressed: { opacity: 0.6 },
  paper: { backgroundColor: colors.paper, padding: 14 },
  paperNote: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, color: colors.ink2 },
  dim: { color: colors.meta, marginTop: 4 },
  stats: { flexDirection: 'row', alignItems: 'stretch', paddingVertical: 4 },
  stat: { flex: 1, alignItems: 'center', gap: 2 },
  statRule: { width: 1, backgroundColor: colors.paper2 },
  statV: { fontFamily: fonts.logo, fontSize: 24, color: colors.ink },
  statUnit: { fontFamily: fonts.jet, fontSize: 11, color: colors.ink2 },
  statK: { fontFamily: fonts.jet, fontSize: 10, letterSpacing: 1.2, color: colors.meta },
  foot: { fontFamily: fonts.jet, fontSize: 9, letterSpacing: 1.2, color: colors.meta, marginTop: 12, textAlign: 'center' },
  backHead: { fontFamily: fonts.jet, fontSize: 10, letterSpacing: 1.4, color: colors.meta, marginTop: 4 },
  backName: { fontFamily: fonts.semibold, fontSize: 16, color: colors.ink, marginTop: 4 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', gap: 10, paddingVertical: 3 },
  kvK: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.ink2 },
  kvV: { flexShrink: 1, fontFamily: fonts.jet, fontSize: 11, color: colors.ink, textAlign: 'right' },
  rule: { height: 1, backgroundColor: colors.paper2, marginVertical: 8 },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  paperMono: { fontFamily: fonts.jet, fontSize: 9, letterSpacing: 1.2, color: colors.ink2 },
});
