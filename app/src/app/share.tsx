import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import * as Brightness from 'expo-brightness';
import { useLocalSearchParams } from 'expo-router';
import QRCode from 'react-native-qrcode-svg';
import * as Clipboard from 'expo-clipboard';
import Button from '@/components/Button';
import StaffPage from '@/components/StaffPage';
import { useAppSize } from '@/hooks/useAppSize';
import { useLang } from '@/i18n';
import { hasNative, llama, type WorkerStatus } from '@/llm/native';
import { explain } from '@/llm/errors';
import { myPeerQr, relayUrlOf } from '@/llm/peers';
import { tapDone, tapSelect } from '@/lib/haptics';
import { saveSettings, saveShare, settings, share, useShare } from '@/llm/store';
import { colors, fonts, radius } from '@/theme/tokens';

// "share this phone": starts the worker (its own process; the gate on the network, ggml's
// rpc server and the api behind it on 127.0.0.1) and shows the code another device scans.
// The code is v3 once the worker reports its certificate (tls, a one-time pairing code that
// changes after each pairing; the poll below picks the new one up), v2 with the secret before.
// The screen stays on while sharing: Android gives the worker all cores only then.
// "share far away" (5.11.2026): the worker also connects out to a relay and the code carries
// the relay's address and a six digit code, so a device behind another nat can come in; the
// relay only pipes encrypted bytes (docs/RELAY.md). The relay address is remembered in the
// llm settings and is the default for "add by code" on the peers page.
// pasaport://share?start=1 (5.11.2026): a computer with the phone on a usb cable opens this
// screen over adb when it finds nobody sharing (kula-node ui, "on a cable"); start=1 presses
// start once, as a person would (a permission prompt it needs still shows). Already sharing:
// nothing changes.
export default function ShareScreen() {
  const params = useLocalSearchParams<{ start?: string }>();
  const autoStart = useRef(params.start === '1');
  const startRef = useRef<() => Promise<void>>(async () => {});
  const { t, tx, up } = useLang();
  const { width } = useAppSize();
  const mine = useShare();
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [status, setStatus] = useState<WorkerStatus | null>(null);
  const [wifi, setWifi] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [far, setFar] = useState<boolean>(() => !!share()?.relay);
  const [relayUrl, setRelayUrl] = useState<string>(() => settings().relayUrl);

  useEffect(() => {
    if (!hasNative()) return;
    let on = true;
    const tick = async () => {
      const s = await llama!.workerStatus().catch(() => null);
      if (!on || !s) return;
      setStatus(s);
      const running = s.state === 'running' || s.state === 'starting';
      if (autoStart.current) {
        autoStart.current = false;
        if (!running) startRef.current().catch(() => {});
      }
      llama!.keepScreenOn(running).catch(() => {});
      if (running && share()) myPeerQr().then((r) => on && setQr(r.qr)).catch(() => {});
      else setQr(null);
    };
    tick();
    const id = setInterval(tick, 2000);
    llama!.info().then((i) => on && setWifi(i.wifiIp)).catch(() => {});
    // the qr carries the secret (v2) or the pairing code (v3): no screenshots of this screen
    llama!.secureScreen?.(true).catch(() => {});
    return () => {
      on = false;
      clearInterval(id);
      llama!.secureScreen?.(false).catch(() => {});
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
      const relay = far && relayUrl.trim() ? relayUrlOf(relayUrl) : null;
      if (relay) saveSettings({ relayUrl: relay });
      const { qr, share } = await myPeerQr({ relay });
      await llama!.startWorker(share.port, share.secret, share.name, relay);
      setQr(qr);
      tapDone();
      llama!.requestBatteryUnrestricted().catch(() => {});
    } catch (e) {
      setErr(explain(e, tx));
    }
  };
  // the poll above presses start through this (it was set up before start existed)
  useEffect(() => { startRef.current = start; });
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
            <Text style={styles.meta}>{t('share.gate', { ok: status.connects, no: status.rejects })}{status.fp ? ` · ${t('share.tls', { n: status.paired ?? 0 })}` : ''}</Text>
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
          {status?.fp ? <Text style={styles.mono} selectable>{up(`${t('share.fp')} ${status.fp.slice(0, 8)} ${status.fp.slice(8, 16)}${status.pin ? ` · ${t('share.pin')} ${status.pin}` : ''}`)}</Text> : null}
          {/* the qr's text, for a device that cannot scan (a computer's chat page: "paste a code").
              it carries the pairing code (or the v2 secret): copied only on a press, said so */}
          <Pressable onPress={() => { Clipboard.setStringAsync(qr).then(() => { tapDone(); setCopied(true); setTimeout(() => setCopied(false), 2500); }).catch(() => {}); }} accessibilityRole="button" accessibilityLabel={t('share.copy')} hitSlop={8} style={styles.linkHit}>
            <Text style={styles.link}>{copied ? t('share.copied') : t('share.copy')} ›</Text>
          </Pressable>
          <Text style={styles.hint}>{t('share.copy.hint')}</Text>
          {mine?.relay ? (
            status?.relay ? (
              <>
                <Text style={styles.code}>{status.relay.code.slice(0, 3)} {status.relay.code.slice(3)}</Text>
                <Text style={styles.mono}>{up(`${t('share.relayCode')} · ${status.relay.url.replace(/^wss?:\/\//, '')}`)}</Text>
                <Text style={styles.hint}>{t('share.relaySay')}</Text>
              </>
            ) : (
              <Text style={styles.hint}>{status?.relayError ? t('share.relayError', { err: status.relayError }) : t('share.relayWaiting')}</Text>
            )
          ) : null}
          <Text style={styles.hint}>{t('share.screen')}{Platform.OS === 'web' ? '' : ` ${t('share.bright')}.`}</Text>
        </View>
      ) : null}
      {err ? <Text style={styles.err} accessibilityRole="alert">{err}</Text> : null}
      {state !== 'running' && state !== 'starting' ? (
        <View style={styles.farBox}>
          <Pressable onPress={() => setFar((v) => !v)} hitSlop={8} style={styles.farRow} accessibilityRole="switch" accessibilityState={{ checked: far }} testID="share-far">
            <View style={[styles.box, far && styles.boxOn]} />
            <Text style={styles.farLabel}>{t('share.far')}</Text>
          </Pressable>
          <Text style={styles.hint}>{t('share.far.hint')}</Text>
          {far ? (
            <TextInput value={relayUrl} onChangeText={setRelayUrl} placeholder={t('share.relayUrl')} placeholderTextColor={colors.meta} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={styles.input} testID="share-relay-url" />
          ) : null}
        </View>
      ) : null}
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
  code: { fontFamily: fonts.jet, fontSize: 30, letterSpacing: 4, color: colors.paper, marginTop: 8 },
  farBox: { marginTop: 20, gap: 8 },
  farRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  box: { width: 18, height: 18, borderRadius: 4, borderWidth: 1.5, borderColor: colors.paper },
  boxOn: { backgroundColor: colors.spotText, borderColor: colors.spotText },
  farLabel: { fontFamily: fonts.medium, fontSize: 14, color: colors.paper },
  input: { height: 44, borderBottomWidth: 1, borderBottomColor: colors.ink3, fontFamily: fonts.regular, fontSize: 13, color: colors.paper },
  actions: { marginTop: 24, gap: 10 },
});
