import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Brightness from 'expo-brightness';
import QRCode from 'react-native-qrcode-svg';
import Button from '@/components/Button';
import StaffPage from '@/components/StaffPage';
import { useAppSize } from '@/hooks/useAppSize';
import { useLang } from '@/i18n';
import { hasNative, llama, type WorkerStatus } from '@/llm/native';
import { explain } from '@/llm/errors';
import { myPeerQr } from '@/llm/peers';
import { tapDone, tapSelect } from '@/lib/haptics';
import { saveShare, share, useShare } from '@/llm/store';
import { colors, fonts, radius } from '@/theme/tokens';

// "share this phone": starts the worker (its own process; the gate on the network, ggml's
// rpc server and the api behind it on 127.0.0.1) and shows the code another device scans.
// The screen stays on while sharing: Android gives the worker all cores only then.
export default function ShareScreen() {
  const { t, tx, up } = useLang();
  const { width } = useAppSize();
  const mine = useShare();
  const [qr, setQr] = useState<string | null>(null);
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [wifi, setWifi] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!hasNative()) return;
    let on = true;
    const tick = async () => {
      const s = await llama!.workerStatus().catch(() => null);
      if (!on || !s) return;
      setStatus(s);
      const running = s.state === 'running' || s.state === 'starting';
      llama!.keepScreenOn(running).catch(() => {});
      if (running && share()) myPeerQr().then((r) => on && setQr(r.qr)).catch(() => {});
      else setQr(null);
    };
    tick();
    const id = setInterval(tick, 2000);
    llama!.info().then((i) => on && setWifi(i.wifiIp)).catch(() => {});
    return () => {
      on = false;
      clearInterval(id);
    };
  }, []);

  // the code is easier to scan on a bright screen: full brightness while it shows, the old
  // value back when it goes (or the page closes). never fails the page.
  useEffect(() => {
    if (!qr || Platform.OS === 'web') return;
    let was: number | null = null;
    let on = true;
    Brightness.getBrightnessAsync().then((b) => {
      if (!on) return;
      was = b;
      return Brightness.setBrightnessAsync(1);
    }).catch(() => {});
    return () => {
      on = false;
      if (was != null) Brightness.setBrightnessAsync(was).catch(() => {});
      else Brightness.restoreSystemBrightnessAsync().catch(() => {});
    };
  }, [qr]);

  const start = async () => {
    setErr(null);
    tapSelect();
    try {
      const { qr, share } = await myPeerQr();
      await llama!.startWorker(share.port, share.secret, share.name);
      setQr(qr);
      tapDone();
      llama!.requestBatteryUnrestricted().catch(() => {});
    } catch (e) {
      setErr(explain(e, tx));
    }
  };
  const stop = async () => {
    tapSelect();
    await llama!.stopWorker().catch(() => {});
    saveShare(null); // a new secret next time
    setQr(null);
  };

  const state = status?.state ?? 'stopped';
  const line = state === 'running' && status?.peer ? t('share.state.working', { peer: status.peer }) : state === 'error' ? t('share.state.error', { err: explain(status?.error, tx) }) : t(`share.state.${state === 'starting' ? 'starting' : state === 'running' ? 'running' : 'stopped'}`);

  return (
    <StaffPage title={t('share.title')}>
      <Text style={styles.lede}>{t('share.lede')}</Text>
      {!hasNative() ? <Text style={styles.err}>{t('models.noNative')}</Text> : null}
      {hasNative() && !wifi ? <Text style={styles.err}>{t('share.noWifi')}</Text> : null}
      <View style={styles.card}>
        <Text style={[styles.state, state === 'running' && styles.stateOn]} accessibilityLiveRegion="polite">{line}</Text>
        {status && state === 'running' ? (
          <>
            <Text style={styles.meta}>{t('share.ram', { mb: status.ramMb, bw: status.bandwidth.toFixed(1) })}{status.heldMb > 50 ? ` · ${t('share.holding', { gb: (status.heldMb / 1024).toFixed(1) })}` : ''}</Text>
            <Text style={styles.meta}>{t('share.gate', { ok: status.connects, no: status.rejects })}</Text>
          </>
        ) : null}
        {status?.throttled ? <Text style={styles.warn}>{t('share.throttled')}</Text> : null}
        {status && !status.batteryUnrestricted && state === 'running' ? (
          <Pressable onPress={() => llama!.requestBatteryUnrestricted()} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('share.battery')} style={styles.linkHit}><Text style={styles.link}>{t('share.battery')} ›</Text></Pressable>
        ) : null}
      </View>
      {qr ? (
        <View style={styles.qrWrap}>
          <View style={styles.qrPaper} accessible accessibilityRole="image" accessibilityLabel={`${t('share.title')} · ${mine?.name ?? ''}`}>
            <QRCode value={qr} size={Math.min(width - 96, 280)} color={colors.paper} backgroundColor={colors.ink} ecl="L" />
          </View>
          <Text style={styles.mono}>{up(`${mine?.name ?? ''} · ${wifi ?? ''}:${mine?.port ?? ''}`)}</Text>
          <Text style={styles.hint}>{t('share.screen')}{Platform.OS === 'web' ? '' : ` ${t('share.bright')}.`}</Text>
        </View>
      ) : null}
      {err ? <Text style={styles.err} accessibilityRole="alert">{err}</Text> : null}
      <View style={styles.actions}>
        {state === 'running' || state === 'starting' ? <Button label={t('share.stop')} onPress={stop} kind="line" /> : <Button label={t('share.start')} onPress={start} kind="red" />}
      </View>
    </StaffPage>
  );
}

const styles = StyleSheet.create({
  lede: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.mute },
  card: { marginTop: 16, padding: 14, borderRadius: radius.md, backgroundColor: colors.ink2, gap: 6 },
  state: { fontFamily: fonts.semibold, fontSize: 16, color: colors.paper },
  stateOn: { color: colors.spotText },
  meta: { fontFamily: fonts.regular, fontSize: 12, color: colors.mute },
  warn: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.violet, marginTop: 4 },
  link: { fontFamily: fonts.medium, fontSize: 13, color: colors.spotText },
  linkHit: { minHeight: 44, justifyContent: 'center' },
  qrWrap: { alignItems: 'center', marginTop: 20, gap: 10 },
  qrPaper: { padding: 16, borderRadius: radius.md, borderWidth: 1, borderColor: colors.ink3, backgroundColor: colors.ink },
  mono: { fontFamily: fonts.jet, fontSize: 11, letterSpacing: 1, color: colors.mute },
  hint: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: colors.mute, textAlign: 'center' },
  err: { fontFamily: fonts.medium, fontSize: 13, color: colors.violet, marginTop: 12 },
  actions: { marginTop: 24, gap: 10 },
});
