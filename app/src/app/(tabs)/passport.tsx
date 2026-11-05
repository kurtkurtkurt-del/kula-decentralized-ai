import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAppSize } from '@/hooks/useAppSize';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import NightCard from '@/components/NightCard';
import Devices from '@/components/Devices';
import Icon from '@/components/Icon';
import Tips from '@/components/Tips';
import { TAB_BAR_SPACE, useTabBarSpace } from '@/components/TabBar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/auth/AuthContext';
import { myCards, toCardData, type CardRow } from '@/data/contribution';
import { measure, passportJson, usePassport, type Passport } from '@/data/passport';
import { nativeAvailable } from '@/passport/measure';
import { useProfile } from '@/data/profile';
import { nightRules, nightWindow } from '@/data/settings';
import { endNow, recheck, useNight } from '@/night/useNight';
import { setWantTonight, wantTonight } from '@/night/conditions';
import { useReports } from '@/night/report';
import { bestStreak, monthTotal, useNightSummary } from '@/data/night';
import { useRefreshOnFocus } from '@/hooks/useRefresh';
import { upperData, useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';
import { brand } from '@/theme/layout';

// The passport tab (design E, prototypes/passport.html, 20.10.2026): the device passport
// as a card, a red block on top (the largest model, large) and paper under it with the
// measurements; measure / copy json under the card; your devices (components/Devices.tsx:
// the ones connected by qr and the fleet's total); then tonight: the night worker's
// state and counter; then the cards earned so far, as the collection.
const CARD = 0.39;
const STEP = 0.42;
const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
const two = (n: number) => String(n).padStart(2, '0');
const at = (iso: string) => {
  const d = new Date(iso);
  return `${two(d.getDate())}.${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

export default function PassportScreen() {
  const { session } = useAuth();
  const { t, tn, up } = useLang();
  const insets = useSafeAreaInsets();
  const tabSpace = useTabBarSpace();
  const { width, height } = useAppSize();
  const passport = usePassport();
  const night = useNight();
  const reports = useReports();
  const last = reports.at(-1) ?? null;
  const [want, setWant] = useState(wantTonight);
  const flipWant = () => { setWantTonight(!want); setWant(!want); recheck(); };
  const tick = useRefreshOnFocus('cards', 'profile');
  const profile = useProfile(tick);
  const nightRows = useNightSummary(session?.user.id, tick);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [cards, setCards] = useState<CardRow[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [side, setSide] = useState<'front' | 'back'>('front');
  const uid = session?.user.id;
  useEffect(() => {
    if (!uid) return;
    let live = true;
    myCards().then((c) => live && setCards(c)).catch(() => {});
    return () => {
      live = false;
    };
  }, [uid, tick, night.state]);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      await measure();
    } catch (e) {
      setNote(String((e as Error).message ?? e).toLowerCase());
    }
    setBusy(false);
  };
  const copy = async (p: Passport) => {
    await Clipboard.setStringAsync(passportJson(p));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const w = nightWindow();
  const signedIn = !!session; // a guest counts (5.11.2026)
  const cardW = Math.round(width * CARD);
  const cardH = cardW * 1.5;
  const name = (profile?.display_name ?? profile?.handle ?? t('passport.you')).toLowerCase();
  const waiting = night.state === 'waiting' && night.reason ? t(`night.waiting.${night.reason}`, { n: nightRules().minBattery }) : null;

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: TAB_BAR_SPACE + insets.bottom + 28 }}>
        <View style={styles.top}>
          <Text style={styles.title}>{t('passport.title')}</Text>
          <Pressable onPress={() => router.push('/settings')} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('passport.settings')} style={({ pressed }) => [styles.gear, pressed && styles.pressed]}>
            <Icon name="account" size={20} color={colors.paper} />
          </Pressable>
          <View style={styles.sec}>
            <Text style={styles.mono}>{up(t('passport.kicker'))}</Text>
            <Text style={styles.mono}>{passport ? upperData(passport.device) : signedIn ? upperData(name) : up(t('passport.notSignedIn'))}</Text>
          </View>

          {/* the passport card: red block, paper under it */}
          <View style={styles.card}>
            <View style={styles.red}>
              <Text style={styles.redMono}>{up(t('passport.largest'))}</Text>
              <Text style={styles.big}>{passport ? (passport.estimate ? (passport.estimate.fit_b ? `~${passport.estimate.fit_b}B` : '<1B') : passport.largest_model_q4) : '—'}</Text>
              <Text style={[styles.redMono, styles.clearRing]}>
                {!passport
                  ? up(t('passport.none'))
                  : passport.estimate
                    ? `Q4_K_M · ${passport.estimate.tps_low}–${passport.estimate.tps_high} tok/s · ${t('passport.range')}`
                    : `Q4 · ${t('passport.speed')} ${passport.est_tps} tok/s`}
              </Text>
              {passport ? <Text style={[styles.redMono, styles.cornerTop]}>{upperData(passport.soc)}</Text> : null}
              <View style={styles.ring}>
                <Text style={styles.ringText}>{busy ? '…' : '8 s'}</Text>
              </View>
            </View>
            <View style={styles.paper}>
              {passport ? (
                <>
                  <Row k={t('passport.ram')} v={`${passport.ram_total_gb} · ${passport.ram_free_gb} ${t('passport.free')}`} />
                  <Row k={t('passport.cap')} v={`${passport.app_mem_cap_mb} mb`} />
                  <Row k={t('passport.cpu')} v={passport.cpu_cores ? `${passport.cpu_cores} × ${passport.cpu_max_ghz} ghz` : '—'} />
                  <Row k={t('passport.bw')} v={passport.mem_bw_read_gbs ? `${passport.mem_bw_read_gbs} gb/s · ${passport.best_threads} ${t('passport.threads')}` : `${passport.mem_bw_gbs} gb/s`} />
                  {passport.budget ? <Row k={t('passport.budget')} v={`${passport.budget.ram_gb} gb · ~${passport.budget.q4_k_m_b}B q4 · ~${passport.budget.q3_k_s_b}B q3`} /> : null}
                  {passport.gpu ? <Row k={t('passport.gpu')} v={[passport.gpu.model, passport.gpu.opencl ? 'opencl' : '', passport.gpu.vulkan ? `vulkan ${passport.gpu.vulkan}` : ''].filter(Boolean).join(' · ').toLowerCase() || '—'} /> : null}
                  {passport.thermal ? <Row k={t('passport.heat')} v={`${passport.thermal.status >= 0 ? passport.thermal.status : '—'} · ${passport.thermal.battery_c >= 0 ? `${passport.thermal.battery_c} °c` : '—'}`} /> : null}
                  {passport.wifi ? <Row k={t('passport.wifi')} v={passport.wifi.band ? `${passport.wifi.band} ghz · ${passport.wifi.link_mbps} mbps` : '—'} /> : null}
                  <Row k={t('passport.compute')} v={`${passport.gflops} gflops`} />
                  <Row k={`${t('passport.disk')} · ${t('passport.battery')}`} v={`${passport.storage_free_gb || '—'} gb · ${passport.battery_pct || '—'}%${passport.charging ? ' ⚡' : ''}`} />
                  <View style={styles.rule} />
                  <View style={styles.between}>
                    <Text style={styles.paperMono}>{upperData(passport.android)}{passport.approx ? ` · ${up(t('passport.approx'))}` : ''}</Text>
                    <Text style={styles.paperMono}>{at(passport.measured_at)}</Text>
                  </View>
                </>
              ) : (
                <Text style={styles.paperNote}>{t('passport.measure.hint')}</Text>
              )}
            </View>
          </View>
          <View style={styles.actions}>
            <Pressable onPress={run} style={({ pressed }) => [styles.btn, styles.btnRed, pressed && styles.pressed]} accessibilityRole="button">
              <Text style={[styles.btnText, styles.btnTextRed]}>{busy ? t('passport.measuring') : passport ? t('passport.again') : t('passport.measure')}</Text>
            </Pressable>
            <Pressable onPress={() => passport && copy(passport)} disabled={!passport} style={({ pressed }) => [styles.btn, !passport && styles.off, pressed && styles.pressed]} accessibilityRole="button">
              <Text style={styles.btnText}>{copied ? t('passport.copied') : t('passport.copy')}</Text>
            </Pressable>
          </View>
          {note ? <Text style={styles.note}>{note}</Text> : null}
          {!nativeAvailable() ? <Text style={styles.note}>{t('passport.approx')}</Text> : null}

          {/* together: this phone and the devices connected by qr, one number */}
          <Devices passport={passport} />

          {/* tonight: the worker */}
          <View style={styles.sec}>
            <Text style={styles.mono}>{up(t('night.title'))}</Text>
            <Text style={[styles.mono, styles.redText]}>{up(`${t('night.window', { from: w.from, to: w.to })} · ${t('night.onCharge')}`)}</Text>
          </View>
          <View style={styles.night}>
            <View style={styles.between}>
              <View style={{ flex: 1 }}>
                <Text style={styles.nightTitle} numberOfLines={1}>{(night.slug ?? '').replace(/-/g, ' ') || t('night.waiting.noproject')}</Text>
                <Text style={styles.meta}>{night.state === 'running' ? up(t('night.running')) : night.phase === 'paused' ? `${up(t('night.paused'))}${waiting ? ` · ${waiting}` : ''}` : night.state === 'done' || night.phase === 'done' ? t('night.done') : (waiting ?? '')}</Text>
              </View>
              <Text style={styles.count}>{fmtTokens(night.tokens)}</Text>
            </View>
            <View style={styles.bar}>
              <View style={[styles.barIn, { width: `${Math.min(100, (night.seconds / (8.5 * 3600)) * 100)}%` }]} />
            </View>
            <View style={styles.between}>
              <Text style={styles.meta}>{`${Math.floor(night.seconds / 3600)}h ${two(Math.floor((night.seconds % 3600) / 60))}m · ${night.kwh.toFixed(4)} kwh · ${night.tps} tok/s${night.real ? ` · ${t('night.units', { n: night.units ?? 0 })}` : ''}`}</Text>
              {night.state === 'running' ? (
                <Pressable onPress={() => endNow()} hitSlop={8}>
                  <Text style={[styles.meta, styles.link]}>{t('night.endNow')}</Text>
                </Pressable>
              ) : null}
            </View>
            {/* real (5.11.2026): the model and the devices, the known-answer checks; else the simulation line */}
            <Text style={styles.sim}>
              {night.real
                ? `${t('night.real', { model: night.model ?? '', n: night.devices?.length ?? 1 })}${night.checked ? ` · ${t('night.checked', { ok: (night.checked ?? 0) - (night.wrong ?? 0), n: night.checked })}` : ''}`
                : t('night.sim')}
              {' · '}
              {t('night.foreground')}
            </Text>
            {/* night-2: the switch for tonight, and last night's report in one line */}
            <View style={styles.between}>
              <Pressable onPress={flipWant} hitSlop={8} accessibilityRole="switch" accessibilityState={{ checked: want }}>
                <Text style={[styles.meta, styles.link]}>{`${t('night.tonight.on')}: ${want ? t('word.on') : t('word.off')}`}</Text>
              </Pressable>
              <Pressable onPress={() => router.push('/night/report')} hitSlop={8} accessibilityRole="link">
                <Text style={[styles.meta, styles.link]} numberOfLines={1}>{last ? t('night.report.last', { units: last.units, tps: last.tps, wh: last.wh }) : t('night.report')}</Text>
              </Pressable>
            </View>
            {/* backend-night: what the server has of this account's nights this month */}
            {session ? <Text style={styles.meta} numberOfLines={1}>{monthTotal(nightRows) > 0 ? t('night.month', { n: monthTotal(nightRows), s: bestStreak(nightRows) }) : t('night.month.none')}</Text> : null}
          </View>
        </View>

        {/* the cards */}
        <View style={[styles.row, styles.cardsHead]}>
          <View style={styles.rowLeft}>
            <Text style={styles.cardsTitle}>{t('passport.cards')}</Text>
            <View style={styles.dot} />
          </View>
          <Text style={styles.small} numberOfLines={1}>{up(cards.length ? `${tn('passport.nNights', cards.length)} · ${profile?.credits ?? 0} ${t('passport.credits')}` : t('passport.cards.empty'))}</Text>
        </View>
        {cards.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[styles.cardsScroll, { height: cardH }]} contentContainerStyle={styles.cardsRow}>
            {cards.map((c, i) => (
              <Pressable key={`${c.card_no}-${i}`} onPress={() => { setSide('front'); setOpen(i); }} style={({ pressed }) => [i > 0 && { marginLeft: -Math.round(cardW * (1 - STEP)) }, pressed && styles.pressed]}>
                <NightCard data={toCardData(c)} index={c.card_no || i} width={cardW} />
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
      </ScrollView>

      <Modal visible={open !== null} transparent animationType="fade" onRequestClose={() => setOpen(null)}>
        <Pressable style={styles.dim} onPress={() => setOpen(null)}>
          {open !== null && cards[open] ? (
            <Pressable onPress={() => setSide((s) => (s === 'front' ? 'back' : 'front'))}>
              <NightCard data={toCardData(cards[open])} index={cards[open].card_no || open} side={side} width={Math.min(width - 48, 360, Math.floor((height - 300) / 1.5))} />
            </Pressable>
          ) : null}
          <Text style={styles.small}>{up(t('passport.flip'))}</Text>
        </Pressable>
      </Modal>
      <Tips page="passport" tip={{ title: 'tips.passport.1.t', body: 'tips.passport.1.b', motion: 'tap' }} bottom={tabSpace + 12} />
    </View>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.kv}>
      <Text style={styles.kvK}>{k}</Text>
      <Text style={styles.kvV}>{v}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  top: { paddingTop: brand.top, paddingHorizontal: brand.left },
  title: { fontFamily: fonts.semibold, fontSize: 30, lineHeight: 32, letterSpacing: -0.9, color: colors.paper },
  gear: { position: 'absolute', top: brand.top + 2, right: brand.left },
  sec: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 22, marginBottom: 10 },
  mono: { fontFamily: fonts.jet, fontSize: 10, letterSpacing: 1.4, color: colors.mute },
  redText: { color: colors.spotText },
  card: { borderRadius: radius.md, overflow: 'hidden', borderWidth: 1, borderColor: colors.ink3 },
  red: { backgroundColor: colors.spot, padding: 16, minHeight: 150, justifyContent: 'center' },
  redMono: { fontFamily: fonts.jet, fontSize: 10, letterSpacing: 1.4, color: colors.paper, opacity: 0.85 },
  big: { fontFamily: fonts.logo, fontSize: 48, lineHeight: 50, color: colors.paper, marginVertical: 6 },
  cornerTop: { position: 'absolute', right: 16, top: 16 },
  // the line under the model keeps clear of the ring at the bottom right (46 + a gap); a long
  // range wraps inside the block instead of running under it
  clearRing: { paddingRight: 60 },
  ring: { position: 'absolute', right: 16, bottom: 16, width: 46, height: 46, borderRadius: 23, borderWidth: 2, borderColor: colors.paper, alignItems: 'center', justifyContent: 'center' },
  ringText: { fontFamily: fonts.jet, fontSize: 10, color: colors.paper },
  paper: { backgroundColor: colors.paper, padding: 14 },
  paperNote: { fontFamily: fonts.regular, fontSize: 13, color: colors.ink2 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', gap: 10, paddingVertical: 3 },
  kvK: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.ink2 },
  kvV: { fontFamily: fonts.jet, fontSize: 11, color: colors.ink, textAlign: 'right' },
  rule: { height: 1, backgroundColor: colors.rule, marginVertical: 8 },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  paperMono: { fontFamily: fonts.jet, fontSize: 9, letterSpacing: 1.2, color: colors.ink2 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  btn: { flex: 1, height: 40, borderRadius: radius.sm, borderWidth: 1.5, borderColor: colors.paper, alignItems: 'center', justifyContent: 'center' },
  btnRed: { backgroundColor: colors.spot, borderColor: colors.spot },
  btnWide: { marginHorizontal: brand.left, marginTop: 18 },
  btnText: { fontFamily: fonts.medium, fontSize: 13, color: colors.paper },
  btnTextRed: { color: colors.ink },
  off: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  note: { fontFamily: fonts.regular, fontSize: 11, letterSpacing: 1, color: colors.mute, marginTop: 8 },
  night: { borderWidth: 1, borderColor: colors.ink3, borderRadius: radius.md, padding: 12, gap: 8 },
  nightTitle: { fontFamily: fonts.semibold, fontSize: 14, color: colors.paper },
  meta: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.mute, marginTop: 2 },
  link: { textDecorationLine: 'underline', color: colors.paper },
  count: { fontFamily: fonts.logo, fontSize: 24, color: colors.paper },
  bar: { height: 6, borderRadius: 3, backgroundColor: colors.ink3, overflow: 'hidden' },
  barIn: { height: '100%', backgroundColor: colors.spot },
  sim: { fontFamily: fonts.regular, fontSize: 10.5, color: colors.meta, marginTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingHorizontal: brand.left },
  rowLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardsHead: { paddingTop: 30 },
  cardsTitle: { fontFamily: fonts.medium, fontSize: 15, letterSpacing: -0.2, color: colors.paper },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.spot },
  small: { flexShrink: 1, fontFamily: fonts.regular, fontSize: 11, letterSpacing: 1.4, color: colors.mute },
  cardsScroll: { flexGrow: 0, marginTop: 12 },
  cardsRow: { paddingHorizontal: brand.left },
  dim: { flex: 1, backgroundColor: 'rgba(255,255,255,0.92)', alignItems: 'center', justifyContent: 'center', gap: 18 },
});
