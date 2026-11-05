import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle, Text as SvgText } from 'react-native-svg';
import PullDownScroll from '@/components/PullDownScroll';
import { useTabBarSpace } from '@/components/TabBar';
import { deviceCatalog, networkEstimate, networkNodes, type DeviceModel, type NetworkEstimate, type NetworkNode } from '@/data/network';
import { useRefreshOnFocus } from '@/hooks/useRefresh';
import { upperData, useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';
import { brand } from '@/theme/layout';

// The network: every city where phones measured, as circles sized by phones (a map
// without a map: longitude left to right, latitude bottom to top), and the same cities
// as a list with their numbers and projects.
export default function NetworkScreen() {
  const insets = useSafeAreaInsets();
  const tabSpace = useTabBarSpace();
  const { t, tn, up } = useLang();
  const tick = useRefreshOnFocus('network');
  const [nodes, setNodes] = useState<NetworkNode[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [night, setNight] = useState<NetworkEstimate | null>(null);
  const [models, setModels] = useState<DeviceModel[]>([]);
  useEffect(() => {
    networkNodes().then(setNodes, () => setNodes([]));
    networkEstimate().then(setNight, () => setNight(null));
    deviceCatalog().then(setModels, () => setModels([]));
  }, [tick]);
  const millions = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));
  const list = (nodes ?? []).slice().sort((a, b) => b.phones - a.phones);
  const total = list.reduce((s, n) => ({ phones: s.phones + n.phones, tps: s.tps + Number(n.tps), nights: s.nights + n.nights }), { phones: 0, tps: 0, nights: 0 });
  const W = 340, H = 220;
  const lats = list.map((n) => n.lat), lngs = list.map((n) => n.lng);
  const span = (v: number[]) => [Math.min(...v) - 1, Math.max(...v) + 1];
  const [lat0, lat1] = span(lats.length ? lats : [48]), [lng0, lng1] = span(lngs.length ? lngs : [11]);
  const x = (lng: number) => 24 + ((lng - lng0) / (lng1 - lng0)) * (W - 48);
  const y = (lat: number) => H - 24 - ((lat - lat0) / (lat1 - lat0)) * (H - 48);
  const maxPhones = Math.max(1, ...list.map((n) => n.phones));
  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <PullDownScroll
        closable={false}
        header={<View style={styles.band}><Text style={styles.title}>{t('network.title')}</Text></View>}
        contentContainerStyle={[styles.body, { paddingBottom: tabSpace + insets.bottom + 28 }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.total}>{up(t('network.total', { phones: total.phones, tps: Math.round(total.tps), nights: total.nights }))}</Text>
        {night && night.phones ? (
          <View style={styles.night}>
            <Text style={styles.nightBig}>{millions(night.tokens_night_low)}–{millions(night.tokens_night_high)}</Text>
            <Text style={styles.nightLine}>{t('network.tonight', { hours: night.hours })}</Text>
            <Text style={styles.nightMeta}>{t('network.basis', { phones: night.phones, observed: night.observed })}</Text>
          </View>
        ) : null}
        <View style={styles.map}>
          <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`}>
            {list.map((n) => {
              const r = 8 + 22 * Math.sqrt(n.phones / maxPhones);
              const on = open === n.city_slug;
              return (
                <Circle key={n.city_slug} cx={x(n.lng)} cy={y(n.lat)} r={r} fill={on ? colors.spot : colors.paper} opacity={on ? 1 : 0.85} />
              );
            })}
            {list.map((n) => (
              <SvgText key={`${n.city_slug}-l`} x={x(n.lng)} y={y(n.lat) + 8 + 22 * Math.sqrt(n.phones / maxPhones) + 12} fontSize={9} fill={colors.mute} textAnchor="middle" fontFamily={fonts.regular}>{n.city_name.toLowerCase()}</SvgText>
            ))}
          </Svg>
        </View>
        {nodes && !nodes.length ? <Text style={styles.note}>{t('network.none')}</Text> : null}
        {list.map((n) => {
          const on = open === n.city_slug;
          return (
            <Pressable key={n.city_slug} onPress={() => setOpen(on ? null : n.city_slug)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
              <View style={styles.rowTop}>
                <Text style={styles.city}>{n.city_name.toLowerCase()}</Text>
                <Text style={styles.country}>{n.country.toUpperCase()}</Text>
              </View>
              <Text style={styles.meta}>{tn('network.phones', n.phones)} · {t('network.tps', { n: Math.round(Number(n.tps)) })} · {tn('network.nights', n.nights)}</Text>
              {on ? (
                <View style={styles.projects}>
                  <Text style={styles.small}>{up(t('network.projects'))}</Text>
                  {n.projects.map((p) => (
                    <Pressable key={p} onPress={() => router.push(`/project/${p}`)} style={styles.chip}><Text style={styles.chipText}>{upperData(p.replace(/-/g, ' '))} · {t('network.go')}</Text></Pressable>
                  ))}
                  {!n.projects.length ? <Text style={styles.small}>{t('word.none')}</Text> : null}
                </View>
              ) : null}
            </Pressable>
          );
        })}
        {models.length ? (
          <View style={styles.models}>
            <Text style={styles.small}>{up(t('network.devices'))}</Text>
            {models.map((d) => (
              <View key={`${d.device}|${d.soc}`} style={styles.modelRow}>
                <View style={styles.modelText}>
                  <Text style={styles.modelName} numberOfLines={1}>{d.device.toLowerCase()}</Text>
                  <Text style={styles.meta}>{[upperData(d.soc), tn('network.phones', d.phones), d.ram_free_gb !== null ? `${d.ram_free_gb} gb ${t('passport.free')}` : '', d.best_threads ? `${d.best_threads} ${t('passport.threads')}` : ''].filter(Boolean).join(' · ')}</Text>
                </View>
                <Text style={styles.modelTps}>{d.tps_low !== null ? `${d.tps_low}–${d.tps_high}` : '—'}</Text>
              </View>
            ))}
          </View>
        ) : null}
      </PullDownScroll>
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  band: { position: 'absolute', top: 0, left: 0, right: 0, height: brand.top + 44, backgroundColor: colors.ink, zIndex: 2 },
  title: { position: 'absolute', top: brand.top - 8, left: brand.left, fontFamily: fonts.semibold, fontSize: 30, lineHeight: 32, letterSpacing: -0.9, color: colors.paper },
  body: { paddingTop: brand.top + 48, paddingHorizontal: brand.left },
  total: { fontFamily: fonts.regular, fontSize: 10, letterSpacing: 1.6, color: colors.spotText, marginTop: 10 },
  night: { marginTop: 16, padding: 14, borderRadius: radius.md, backgroundColor: colors.ink2, gap: 4 },
  nightBig: { fontFamily: fonts.semibold, fontSize: 30, letterSpacing: -0.8, color: colors.paper },
  nightLine: { fontFamily: fonts.medium, fontSize: 13, color: colors.paper },
  nightMeta: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.meta },
  models: { marginTop: 28, gap: 2 },
  modelRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.ink3 },
  modelText: { flex: 1, gap: 3 },
  modelName: { fontFamily: fonts.semibold, fontSize: 16, color: colors.paper },
  modelTps: { fontFamily: fonts.jet, fontSize: 12, color: colors.spotText },
  map: { marginTop: 14, borderWidth: 1, borderColor: colors.ink3, borderRadius: radius.md, backgroundColor: colors.ink2, overflow: 'hidden' },
  note: { fontFamily: fonts.regular, fontSize: 14, color: colors.mute, marginTop: 16 },
  row: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.ink3, gap: 4 },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  city: { fontFamily: fonts.semibold, fontSize: 18, letterSpacing: -0.4, color: colors.paper },
  country: { fontFamily: fonts.jet, fontSize: 10, letterSpacing: 1, color: colors.meta },
  meta: { fontFamily: fonts.regular, fontSize: 12, color: colors.mute },
  projects: { marginTop: 10, gap: 6 },
  small: { fontFamily: fonts.regular, fontSize: 10, letterSpacing: 1.4, color: colors.meta },
  chip: { alignSelf: 'flex-start', paddingHorizontal: 12, height: 32, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.ink3, justifyContent: 'center' },
  chipText: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.paper },
  pressed: { opacity: 0.6 },
});
