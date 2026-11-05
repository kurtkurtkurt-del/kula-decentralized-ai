import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import Devices from '@/components/Devices';
import Icon from '@/components/Icon';
import Tips from '@/components/Tips';
import InfoTip from '@/components/InfoTip';
import PassportCard from '@/components/passport/PassportCard';
import { TAB_BAR_SPACE, useTabBarSpace } from '@/components/TabBar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth } from '@/auth/AuthContext';
import { measure, passportJson, usePassport, type Passport } from '@/data/passport';
import { nativeAvailable } from '@/passport/measure';
import { useProfile } from '@/data/profile';
import { nightRules, nightWindow } from '@/data/settings';
import { endNow, recheck, useNight } from '@/night/useNight';
import { setWantTonight, wantTonight } from '@/night/conditions';
import { useReports } from '@/night/report';
import { bestStreak, monthTotal, useNightSummary } from '@/data/night';
import { useRefreshOnFocus } from '@/hooks/useRefresh';
import { useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';
import { brand } from '@/theme/layout';

// The passport tab (design E, prototypes/passport.html, 20.10.2026; lighter 6.11.2026): the
// device passport as a card (components/passport/PassportCard.tsx: the essentials in front,
// the "i" flips it to the full passport); measure / copy json under the card; your devices
// (components/Devices.tsx: the ones connected by qr and the fleet's total); then tonight:
// the night worker's state and counter. The earned cards left this tab (person pages keep them).
const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
const two = (n: number) => String(n).padStart(2, '0');

export default function PassportScreen() {
  const { session } = useAuth();
  const { t, up } = useLang();
  const insets = useSafeAreaInsets();
  const tabSpace = useTabBarSpace();
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

          {/* the passport card: the essentials in front, the full passport behind the "i" */}
          <View style={styles.gap} />
          <PassportCard passport={passport} title={signedIn ? name : t('passport.notSignedIn')} busy={busy} />
          <View style={styles.actions}>
            <Pressable onPress={run} style={({ pressed }) => [styles.btn, styles.btnRed, pressed && styles.pressed]} accessibilityRole="button">
              <Text style={[styles.btnText, styles.btnTextRed]}>{busy ? t('passport.measuring') : passport ? t('passport.again') : t('passport.measure')}</Text>
            </Pressable>
            <Pressable onPress={() => passport && copy(passport)} disabled={!passport} style={({ pressed }) => [styles.btn, !passport && styles.off, pressed && styles.pressed]} accessibilityRole="button">
              <Text style={styles.btnText}>{copied ? t('passport.copied') : t('passport.copy')}</Text>
            </Pressable>
            <View style={styles.tip}>
              <InfoTip title={t('passportui.json.title')} text={t('passportui.json.text')} size={20} />
            </View>
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

      </ScrollView>
      <Tips page="passport" tip={{ title: 'tips.passport.1.t', body: 'tips.passport.1.b', motion: 'tap' }} bottom={tabSpace + 12} />
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
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  tip: { paddingHorizontal: 4 },
  gap: { height: 22 },
  btn: { flex: 1, height: 40, borderRadius: radius.sm, borderWidth: 1.5, borderColor: colors.paper, alignItems: 'center', justifyContent: 'center' },
  btnRed: { backgroundColor: colors.spot, borderColor: colors.spot },
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
});
