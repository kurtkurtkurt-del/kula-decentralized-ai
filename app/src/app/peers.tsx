import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Clipboard from 'expo-clipboard';
import StaffPage from '@/components/StaffPage';
import { linkPassport } from '@/data/passport';
import { useLang } from '@/i18n';
import { probeAll } from '@/llm/cluster';
import { hasNative, llama, type PeerFound } from '@/llm/native';
import { isPeerQr, isRelayCode, isRemote, parseRelayCode, takePeerQr } from '@/llm/peers';
import { forgetPeer, rememberPeer, usePeers, type Peer } from '@/llm/store';
import { colors, fonts, radius } from '@/theme/tokens';

// "connected devices": the peers this phone may use (paired by scanning the code the other
// device shows in "share this phone" or kula-node), a reachability check per peer, and
// "find nearby" (NSD), which lists shared devices on this wi-fi that still need their code
// scanned (the code carries the secret; the network never does). "add by code" (5.11.2026):
// a relay code read out over the phone, six digits and the pairing code, for a device far
// away; it is reached through the relay from the settings and takes part in apart mode only.
export default function PeersScreen() {
  const { t, tx, up } = useLang();
  const peers = usePeers();
  const [scan, setScan] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<Record<string, boolean | null>>({});
  const [nearby, setNearby] = useState<PeerFound[]>([]);
  const [looking, setLooking] = useState(false);
  const [typed, setTyped] = useState('');
  const [perm, ask] = useCameraPermissions();
  const locked = useRef(false);

  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 3000);
    return () => clearTimeout(id);
  }, [note]);

  const take = (text: string) => {
    try {
      if (isRelayCode(text)) {
        const p = parseRelayCode(text);
        rememberPeer(p);
        setErr(null);
        setNote(t('peers.added', { name: p.name }));
        setScan(false);
        return true;
      }
      if (!isPeerQr(text)) {
        // an old passport-only code: still link the passport, say what it is
        linkPassport(text);
        setNote(t('devices.connected', { d: '' }));
        setScan(false);
        return true;
      }
      const p = takePeerQr(text);
      setErr(null);
      setNote(t('peers.added', { name: p.name.toLowerCase() }));
      setScan(false);
      return true;
    } catch (e) {
      setErr(tx(`peers.err.${(e as Error).message}`, tx(`devices.err.${(e as Error).message}`, t('peers.err.notPeer'))));
      return false;
    }
  };
  const openScan = () => {
    setErr(null);
    locked.current = false;
    setScan(true);
    if (!perm?.granted && perm?.canAskAgain !== false) ask().catch(() => {});
  };
  const onScan = ({ data }: { data: string }) => {
    if (locked.current) return;
    locked.current = true;
    if (!take(data)) setTimeout(() => (locked.current = false), 1200);
  };
  const paste = async () => take((await Clipboard.getStringAsync().catch(() => '')) ?? '');
  const check = useCallback(async () => {
    setOk(Object.fromEntries(peers.map((p) => [p.id, null])));
    // a peer far away has only the api channel (through the relay); the lan ones are asked on rpc
    const [near, far] = await Promise.all([probeAll(peers.filter((p) => !isRemote(p)), 'rpc'), probeAll(peers.filter(isRemote), 'api')]);
    const r = { ok: [...near.ok, ...far.ok], bad: [...near.bad, ...far.bad] };
    setOk({ ...Object.fromEntries(r.ok.map((p) => [p.id, true])), ...Object.fromEntries(r.bad.map((b) => [b.peer.id, false])) });
  }, [peers]);
  useEffect(() => {
    if (!peers.length) return;
    const id = setTimeout(check, 0); // after the render, not inside it
    return () => clearTimeout(id);
  }, [peers.length, check]);
  const findNearby = async () => {
    if (!hasNative()) return;
    setNearby([]);
    setLooking(true);
    const sub = llama!.addListener('onPeerFound', (f) => setNearby((xs) => (xs.some((x) => x.id === f.id) ? xs : [...xs, f])));
    await llama!.discover(true).catch(() => {});
    setTimeout(async () => {
      sub.remove();
      await llama!.discover(false).catch(() => {});
      setLooking(false);
    }, 5000);
  };
  const camera = Platform.OS !== 'web';
  const known = new Set(peers.map((p) => p.id));

  return (
    <StaffPage title={t('peers.title')}>
      <Text style={styles.lede}>{t('peers.lede')}</Text>
      {peers.length === 0 ? <Text style={styles.note}>{t('peers.none')}</Text> : null}
      {peers.map((p: Peer) => (
        <View key={p.id} style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.name} numberOfLines={1}>{p.name.toLowerCase()}<Text style={styles.kind}>  · {t(`peers.kind.${p.kind}`)}</Text></Text>
            <Text style={styles.meta}>{[isRemote(p) ? `${t('peers.far')} ${p.relay!.code}` : `${p.host}:${p.port}`, p.ram ? `${Math.round(p.ram / 1024 * 10) / 10} gb` : '', p.bw ? `${p.bw} gb/s` : ''].filter(Boolean).join(' · ')}</Text>
            <Text style={[styles.meta, ok[p.id] === true && styles.okText, ok[p.id] === false && styles.offText]}>{ok[p.id] === null ? '…' : ok[p.id] ? t('peers.ok') : ok[p.id] === false ? t('peers.off') : ''}</Text>
          </View>
          <Pressable onPress={() => forgetPeer(p.id)} hitSlop={10} accessibilityLabel={t('peers.remove')}><Text style={styles.x}>×</Text></Pressable>
        </View>
      ))}
      <View style={styles.actions}>
        <Pressable onPress={openScan} style={({ pressed }) => [styles.btn, pressed && styles.pressed]}><Text style={styles.btnText}>{t('peers.scan')}</Text></Pressable>
        <Pressable onPress={paste} style={({ pressed }) => [styles.btn, pressed && styles.pressed]}><Text style={styles.btnText}>{t('peers.paste')}</Text></Pressable>
        {peers.length ? <Pressable onPress={check} style={({ pressed }) => [styles.btn, pressed && styles.pressed]}><Text style={styles.btnText}>{t('peers.check')}</Text></Pressable> : null}
        {hasNative() ? <Pressable onPress={findNearby} style={({ pressed }) => [styles.btn, pressed && styles.pressed]}><Text style={styles.btnText}>{looking ? t('peers.searching') : t('peers.nearby')}</Text></Pressable> : null}
      </View>
      {/* the code as text: a computer's terminal prints it, some emulators have no camera, and a
          relay code ("123456 0123…") is read out over the phone */}
      <Text style={styles.section}>{up(t('peers.byCode'))}</Text>
      <View style={styles.typeRow}>
        <TextInput value={typed} onChangeText={setTyped} placeholder={t('peers.codeHint')} placeholderTextColor={colors.meta} autoCapitalize="none" autoCorrect={false} style={styles.input} testID="peer-code" />
        <Pressable onPress={() => { if (take(typed)) setTyped(''); }} style={({ pressed }) => [styles.btn, pressed && styles.pressed]}><Text style={styles.btnText}>{t('peers.add')}</Text></Pressable>
      </View>
      <Text style={styles.hint}>{t('peers.typeHint')}</Text>
      {note ? <Text style={styles.okText}>{note}</Text> : null}
      {err && !scan ? <Text style={styles.offText}>{err}</Text> : null}
      {nearby.filter((f) => !known.has(f.id ?? '')).length ? (
        <>
          <Text style={styles.section}>{up(t('peers.found'))}</Text>
          {nearby.filter((f) => !known.has(f.id ?? '')).map((f) => (
            <View key={f.serviceName} style={styles.row}>
              <View style={styles.rowText}>
                <Text style={styles.name}>{f.name.toLowerCase()}<Text style={styles.kind}>  · {tx(`peers.kind.${f.kind}`, f.kind)}</Text></Text>
                <Text style={styles.meta}>{[`${f.host}:${f.port}`, f.ram ? `${Math.round(f.ram / 1024 * 10) / 10} gb` : '', f.bw ? `${f.bw} gb/s` : ''].filter(Boolean).join(' · ')}</Text>
              </View>
            </View>
          ))}
        </>
      ) : null}
      <Pressable onPress={() => router.push('/share')} style={({ pressed }) => [styles.shareLink, pressed && styles.pressed]}><Text style={styles.shareText}>{t('peers.share')} ›</Text></Pressable>

      <Modal visible={scan} animationType="slide" onRequestClose={() => setScan(false)}>
        <View style={styles.scanRoot}>
          {camera && perm?.granted ? (
            <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={onScan} />
          ) : (
            <View style={styles.center}>
              {camera && perm?.canAskAgain !== false ? (
                <Pressable onPress={() => ask().catch(() => {})} style={({ pressed }) => [styles.btn, styles.btnLight, pressed && styles.pressed]}><Text style={[styles.btnText, styles.btnTextLight]}>{t('devices.camera')}</Text></Pressable>
              ) : (
                <Text style={styles.hintLight}>{t('devices.cameraOff')}</Text>
              )}
            </View>
          )}
          <View style={styles.frame} pointerEvents="none" />
          <View style={styles.scanBottom}>
            <Text style={styles.hintLight}>{err ?? t('devices.scanHint')}</Text>
            <View style={styles.actions}>
              <Pressable onPress={paste} style={({ pressed }) => [styles.btn, styles.btnLight, pressed && styles.pressed]}><Text style={[styles.btnText, styles.btnTextLight]}>{t('peers.paste')}</Text></Pressable>
              <Pressable onPress={() => setScan(false)} style={({ pressed }) => [styles.btn, styles.btnLight, pressed && styles.pressed]}><Text style={[styles.btnText, styles.btnTextLight]}>{t('word.close')}</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </StaffPage>
  );
}

const styles = StyleSheet.create({
  lede: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.mute },
  note: { fontFamily: fonts.regular, fontSize: 14, color: colors.mute, marginTop: 16 },
  section: { fontFamily: fonts.regular, fontSize: 10, letterSpacing: 1.6, color: colors.spotText, marginTop: 24 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.ink3 },
  rowText: { flex: 1, gap: 2 },
  name: { fontFamily: fonts.semibold, fontSize: 16, color: colors.paper },
  kind: { fontFamily: fonts.regular, fontSize: 12, color: colors.meta },
  meta: { fontFamily: fonts.regular, fontSize: 12, color: colors.mute },
  okText: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.spotText, marginTop: 8 },
  offText: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.violet, marginTop: 8 },
  x: { fontFamily: fonts.regular, fontSize: 22, color: colors.meta, paddingHorizontal: 6 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 16 },
  btn: { paddingHorizontal: 14, height: 38, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.paper, justifyContent: 'center' },
  btnText: { fontFamily: fonts.medium, fontSize: 13, color: colors.paper },
  btnLight: { borderColor: '#fff' },
  btnTextLight: { color: '#fff' },
  typeRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  hint: { fontFamily: fonts.regular, fontSize: 12, color: colors.mute, marginTop: 6 },
  input: { flex: 1, height: 44, borderBottomWidth: 1, borderBottomColor: colors.ink3, fontFamily: fonts.regular, fontSize: 13, color: colors.paper },
  shareLink: { marginTop: 28 },
  shareText: { fontFamily: fonts.medium, fontSize: 14, color: colors.spotText },
  scanRoot: { flex: 1, backgroundColor: '#000' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  frame: { position: 'absolute', top: '28%', left: '15%', right: '15%', aspectRatio: 1, borderWidth: 2, borderColor: '#fff', borderRadius: radius.md, opacity: 0.8 },
  scanBottom: { position: 'absolute', left: 24, right: 24, bottom: 48, gap: 10 },
  hintLight: { fontFamily: fonts.regular, fontSize: 13, color: '#fff', textAlign: 'center' },
  pressed: { opacity: 0.7 },
});
