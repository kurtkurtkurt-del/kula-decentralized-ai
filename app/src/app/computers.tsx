import { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import Button from '@/components/Button';
import { Panel, Row, Section, Switch, Value } from '@/components/Row';
import StaffPage from '@/components/StaffPage';
import { ScanModal } from '@/components/models/PeerScan';
import { lastPassport } from '@/data/passport';
import { useLang } from '@/i18n';
import { tapDone, tapSelect } from '@/lib/haptics';
import { notifications } from '@/lib/push';
import { autoLine, hostErr, isHostQr, netLabel, parseHostQr } from '@/llm/hosts';
import { hasNative, llama, type AutoStatus, type WorkerStatus } from '@/llm/native';
import { colors, fonts, radius } from '@/theme/tokens';

// "let my computers use this phone" (8.11.2026): the one-time setup, then the phone is
// hands-off. The switch remembers the home wi-fi; Keeper.kt (native, so it works with the app
// closed) starts the worker after a restart, on joining that wi-fi and on the plug, and the
// worker stops itself when the phone leaves (or is unplugged, "only while charging"). The gate
// then lets in only computers it already paired with (docs/GATE.md "only known computers").
// A computer is added by scanning the QR its chat page shows: its code opens on this phone's
// gate for that computer only, the computer finds the phone over mDNS and pairs; nobody types.
// The setup asks for what Android needs for all that: unrestricted battery (a background start
// on Android 12+), notifications (13+), and on Samsung a pointer to its own sleeping-apps list.
// only the local permission: the account's push registration (lib/push) is not this screen's business
const askNotifications = async () => {
  const N = notifications();
  if (N) await N.requestPermissionsAsync().catch(() => null);
};

export default function ComputersScreen() {
  const { t, up } = useLang();
  const [a, setA] = useState<AutoStatus | null>(null);
  const [w, setW] = useState<WorkerStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [scan, setScan] = useState(false);
  const [busy, setBusy] = useState(false);

  const say = useCallback((e: unknown) => {
    const k = hostErr(e);
    setErr(k ? t(`comp.err.${k}` as never) : String((e as Error)?.message ?? e));
  }, [t]);

  const refresh = useCallback(async () => {
    if (!hasNative()) return;
    const [s, ws] = await Promise.all([llama!.autoStatus().catch(() => null), llama!.workerStatus().catch(() => null)]);
    if (s) setA(s);
    setW(ws);
  }, []);

  useEffect(() => {
    const first = setTimeout(refresh, 0); // after the render, not inside it
    const id = setInterval(refresh, 2000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [refresh]);

  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 5000);
    return () => clearTimeout(id);
  }, [note]);

  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      await refresh();
    } catch (e) {
      say(e);
    } finally {
      setBusy(false);
    }
  };

  const flip = () => run(async () => {
    tapSelect();
    const on = !a?.on;
    const s = await llama!.setAuto(on, a?.onlyCharging ?? false, lastPassport()?.device ?? null);
    setA(s);
    // the first time on: what android needs for a start without a tap, asked right away
    if (on && !s.batteryUnrestricted) await llama!.requestBatteryUnrestricted().catch(() => {});
    if (on && !s.notifications) await askNotifications();
    tapDone();
  });
  const flipCharging = () => run(async () => {
    tapSelect();
    if (!a) return;
    setA(await llama!.setAuto(a.on, !a.onlyCharging, null));
  });
  const takeHere = () => run(async () => { tapSelect(); setA(await llama!.rememberHome()); tapDone(); });
  const startNow = () => run(async () => { tapSelect(); setA(await llama!.startAuto()); });
  const pause = () => run(async () => { tapSelect(); await llama!.stopWorker(); });
  // the name of the wi-fi needs the location permission; asked only on this tap, then the home is read again
  const showName = () => run(async () => {
    const p = await Location.requestForegroundPermissionsAsync();
    if (p.granted && a?.atHome) setA(await llama!.rememberHome());
  });
  const newDevice = () => run(async () => {
    tapSelect();
    await llama!.openPairing();
    router.push('/share');
  });

  const onScan = (text: string): boolean => {
    if (!isHostQr(text)) {
      setErr(t('comp.err.notHost'));
      return false;
    }
    try {
      parseHostQr(text);
    } catch (e) {
      say(e);
      return false;
    }
    setScan(false);
    run(async () => {
      const name = await llama!.addHost(text);
      tapDone();
      setNote(t('comp.added', { name: name.toLowerCase() }));
    });
    return true;
  };

  if (!hasNative()) {
    return (
      <StaffPage title={t('comp.title')}>
        <Text style={styles.lede}>{t('comp.lede')}</Text>
        <Text style={styles.err}>{t('models.noNative')}</Text>
      </StaffPage>
    );
  }

  const line = a ? autoLine(a, w) : null;
  const ready = !!a?.running && a.mode === 'auto';
  const samsung = a?.maker === 'samsung';

  return (
    <StaffPage title={t('comp.title')}>
      <Text style={styles.lede}>{t('comp.lede')}</Text>

      <View style={styles.card}>
        <Text style={[styles.state, ready && styles.stateOn]} accessibilityLiveRegion="polite" testID="comp-state">
          {line ? t(line.key as never, line.vars) : '…'}
        </Text>
        {a?.on && a.home ? <Text style={styles.meta}>{`${t('comp.home')}: ${netLabel(a.home)}${a.atHome ? ` · ${t('comp.home.here')}` : ''}`}</Text> : null}
        {a?.on ? (
          <View style={styles.rowBtns}>
            {ready ? <Button label={t('comp.pause')} kind="line" onPress={pause} disabled={busy} /> : a.decision !== 'away' && a.decision !== 'nohome' ? <Button label={t('comp.start')} kind="red" onPress={startNow} disabled={busy} /> : null}
          </View>
        ) : null}
      </View>

      <Panel>
        <Row label={t('comp.switch')} hint={t('comp.switch.hint')} onPress={busy ? undefined : flip} right={<Switch on={!!a?.on} />} />
        <Row label={t('comp.charging')} hint={t('comp.charging.hint')} onPress={busy ? undefined : flipCharging} right={<Switch on={!!a?.onlyCharging} />} />
      </Panel>

      <Section title={t('comp.setup')} />
      <Panel>
        <Row label={t('comp.battery')} hint={t('comp.battery.hint')} onPress={a?.batteryUnrestricted ? undefined : () => run(() => llama!.requestBatteryUnrestricted())} right={<Value text={a?.batteryUnrestricted ? t('comp.ok') : t('comp.allow')} more={!a?.batteryUnrestricted} />} />
        {a && a.sdk >= 33 ? (
          <Row label={t('comp.notif')} hint={t('comp.notif.hint')} onPress={a.notifications ? undefined : () => run(askNotifications)} right={<Value text={a.notifications ? t('comp.ok') : t('comp.allow')} more={!a.notifications} />} />
        ) : null}
        {samsung ? <Row label={t('comp.samsung')} hint={t('comp.samsung.hint')} onPress={() => run(() => llama!.openAppSettings())} right={<Value text={t('comp.samsung.open')} more />} /> : null}
        <Row
          label={t('comp.home')}
          hint={a?.home ? `${netLabel(a.home)}${a.home.gateway ? ` · ${a.home.gateway}` : ''}` : t('comp.home.none')}
          onPress={a?.now && !a.atHome ? takeHere : undefined}
          right={a?.now && !a.atHome ? <Value text={t('comp.home.use')} more /> : <Value text={a?.home ? t('comp.ok') : ''} />}
        />
      </Panel>
      <Text style={styles.hint}>{t('comp.home.hint')}</Text>
      {a?.home && !a.home.ssid && a.atHome && Platform.OS === 'android' ? (
        <Pressable onPress={showName} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('comp.home.name')} style={styles.linkHit}>
          <Text style={styles.link}>{t('comp.home.name')} ›</Text>
          <Text style={styles.hintLeft}>{t('comp.home.name.hint')}</Text>
        </Pressable>
      ) : null}

      <Section title={t('comp.computers')} />
      {a && a.hosts.length === 0 ? <Text style={styles.hintLeft}>{t('comp.computers.none')}</Text> : null}
      {a?.hosts.map((h) => (
        <View key={h.fp} style={styles.host}>
          <View style={styles.hostText}>
            <Text style={styles.name} numberOfLines={1}>{h.name.toLowerCase()}</Text>
            <Text style={[styles.meta, h.paired ? styles.okText : null]}>{h.paired ? t('comp.paired') : h.waiting ? t('comp.waiting') : t('comp.notyet')}</Text>
            <Text style={styles.mono}>{up(`${h.fp.slice(0, 8)} ${h.fp.slice(8, 16)}`)}</Text>
          </View>
          <Pressable onPress={() => run(async () => { tapSelect(); setA(await llama!.forgetHost(h.fp)); })} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('comp.forget', { name: h.name })} style={styles.xHit}>
            <Text style={styles.x}>×</Text>
          </Pressable>
        </View>
      ))}
      <View style={styles.actions}>
        <Button label={t('comp.add')} kind={a?.hosts.length ? 'line' : 'red'} onPress={() => { setErr(null); setScan(true); }} disabled={busy} />
      </View>
      <Text style={styles.hintLeft}>{t('comp.add.hint')}</Text>
      {note ? <Text style={styles.okText} accessibilityLiveRegion="polite">{note}</Text> : null}
      {err ? <Text style={styles.err} accessibilityRole="alert">{err}</Text> : null}

      {ready ? (
        <>
          <Pressable onPress={newDevice} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('comp.newDevice')} style={styles.linkHit}>
            <Text style={styles.link}>{t('comp.newDevice')} ›</Text>
          </Pressable>
          <Text style={styles.hintLeft}>{t('comp.newDevice.hint')}</Text>
        </>
      ) : null}

      <ScanModal open={scan} err={err ?? t('comp.scan.hint')} onClose={() => setScan(false)} onData={onScan} onPaste={async () => { onScan((await Clipboard.getStringAsync().catch(() => '')) ?? ''); }} />
    </StaffPage>
  );
}

const styles = StyleSheet.create({
  lede: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.mute },
  card: { marginTop: 16, marginBottom: 16, padding: 14, borderRadius: radius.md, backgroundColor: colors.ink2, gap: 6 },
  state: { fontFamily: fonts.semibold, fontSize: 16, color: colors.paper },
  stateOn: { color: colors.spotText },
  meta: { fontFamily: fonts.regular, fontSize: 12, color: colors.mute, flexShrink: 1 },
  mono: { fontFamily: fonts.jet, fontSize: 10.5, letterSpacing: 1, color: colors.meta },
  rowBtns: { flexDirection: 'row', gap: 10, marginTop: 6 },
  hint: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: colors.mute, marginTop: 8 },
  hintLeft: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: colors.mute, marginTop: 6 },
  link: { fontFamily: fonts.medium, fontSize: 13, color: colors.spotText },
  linkHit: { minHeight: 44, justifyContent: 'center', marginTop: 8 },
  host: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.ink3, gap: 10 },
  hostText: { flex: 1, gap: 2 },
  name: { fontFamily: fonts.semibold, fontSize: 15, color: colors.paper },
  okText: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.spotText, marginTop: 4 },
  xHit: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  x: { fontFamily: fonts.regular, fontSize: 22, color: colors.mute },
  actions: { marginTop: 16, gap: 10 },
  err: { fontFamily: fonts.medium, fontSize: 13, color: colors.violet, marginTop: 12 },
});
