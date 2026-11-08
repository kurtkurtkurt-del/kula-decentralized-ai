import { useCallback, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import EmptyState from '@/components/EmptyState';
import StaffPage from '@/components/StaffPage';
import { useLang } from '@/i18n';
import { parseLedger, peerBadge, type AuditEntry } from '@/llm/audit';
import { probeAll } from '@/llm/cluster';
import { tapSelect } from '@/lib/haptics';
import { hasNative, llama, type PeerFound } from '@/llm/native';
import { isRemote } from '@/llm/peers';
import { forgetPeer, usePeers, type Peer } from '@/llm/store';
import { ScanModal, usePeerAdd } from '@/components/models/PeerScan';
import { VERDICT_COLOR } from '@/theme/audit';
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
  const [ok, setOk] = useState<Record<string, boolean | null>>({});
  const [nearby, setNearby] = useState<PeerFound[]>([]);
  const [looking, setLooking] = useState(false);
  const [typed, setTyped] = useState('');
  const [ledger, setLedger] = useState<string[]>([]);
  // beyin's badge per peer: the newest ledger line about that address (settings → beyin audit)
  const audit: AuditEntry[] = useMemo(() => parseLedger(ledger), [ledger]);
  useEffect(() => {
    if (!hasNative()) return;
    llama!.auditLedger(500).then(setLedger, () => {});
  }, [peers.length]);

  const { take, paste, err, setErr, note } = usePeerAdd(() => setScan(false));
  const openScan = () => {
    setErr(null);
    setScan(true);
  };
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
      {peers.length === 0 ? <EmptyState text={t('empty.peers')} action={camera ? t('empty.peers.go') : undefined} onAction={openScan} testID="empty-peers" /> : null}
      {peers.map((p: Peer) => (
        <View key={p.id} style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.name} numberOfLines={1}>{p.name.toLowerCase()}<Text style={styles.kind}>  · {t(`peers.kind.${p.kind}`)}</Text></Text>
            <Text style={styles.meta}>{[isRemote(p) ? `${t('peers.far')} ${p.relay!.code}` : `${p.host}:${p.port}`, p.ram ? `${Math.round(p.ram / 1024 * 10) / 10} gb` : '', p.bw ? `${p.bw} gb/s` : ''].filter(Boolean).join(' · ')}</Text>
            <Text style={[styles.meta, ok[p.id] === true && styles.okText, ok[p.id] === false && styles.offText]}>{ok[p.id] === null ? '…' : ok[p.id] ? t('peers.ok') : ok[p.id] === false ? t('peers.off') : ''}</Text>
          </View>
          <Badge verdict={peerBadge(audit, p.host)} label={t(`audit.verdict.${peerBadge(audit, p.host)}`)} />
          <Pressable onPress={() => { tapSelect(); forgetPeer(p.id); }} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('a11y.remove', { name: p.name })} style={styles.xHit}><Text style={styles.x}>×</Text></Pressable>
        </View>
      ))}
      <View style={styles.actions}>
        <Pressable onPress={openScan} accessibilityRole="button" accessibilityLabel={t('peers.scan')} style={({ pressed }) => [styles.btn, pressed && styles.pressed]}><Text style={styles.btnText}>{t('peers.scan')}</Text></Pressable>
        <Pressable onPress={paste} accessibilityRole="button" accessibilityLabel={t('peers.paste')} style={({ pressed }) => [styles.btn, pressed && styles.pressed]}><Text style={styles.btnText}>{t('peers.paste')}</Text></Pressable>
        {peers.length ? <Pressable onPress={check} accessibilityRole="button" accessibilityLabel={t('peers.check')} style={({ pressed }) => [styles.btn, pressed && styles.pressed]}><Text style={styles.btnText}>{t('peers.check')}</Text></Pressable> : null}
        {hasNative() ? <Pressable onPress={findNearby} accessibilityRole="button" accessibilityLabel={looking ? t('peers.searching') : t('peers.nearby')} style={({ pressed }) => [styles.btn, pressed && styles.pressed]}><Text style={styles.btnText}>{looking ? t('peers.searching') : t('peers.nearby')}</Text></Pressable> : null}
      </View>
      {/* the code as text: a computer's terminal prints it, some emulators have no camera, and a
          relay code ("123456 0123…") is read out over the phone */}
      <Text style={styles.section}>{up(t('peers.byCode'))}</Text>
      <View style={styles.typeRow}>
        <TextInput value={typed} onChangeText={setTyped} placeholder={t('peers.codeHint')} placeholderTextColor={colors.meta} autoCapitalize="none" autoCorrect={false} accessibilityLabel={t('peers.codeHint')} style={styles.input} testID="peer-code" />
        <Pressable onPress={() => { if (take(typed)) setTyped(''); }} accessibilityRole="button" accessibilityLabel={t('peers.add')} style={({ pressed }) => [styles.btn, pressed && styles.pressed]}><Text style={styles.btnText}>{t('peers.add')}</Text></Pressable>
      </View>
      <Text style={styles.hint}>{t('peers.typeHint')}</Text>
      {/* the other way round: a computer that should use this phone (it scans the computer's code) */}
      {hasNative() ? (
        <Pressable onPress={() => router.push('/computers')} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('comp.title')} style={styles.compHit}>
          <Text style={styles.compLink}>{t('comp.title')} ›</Text>
        </Pressable>
      ) : null}
      {note ? <Text style={styles.okText} accessibilityLiveRegion="polite">{note}</Text> : null}
      {err && !scan ? <Text style={styles.offText} accessibilityRole="alert">{err}</Text> : null}
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
      <Pressable onPress={() => router.push('/share')} accessibilityRole="button" accessibilityLabel={t('peers.share')} style={({ pressed }) => [styles.shareLink, pressed && styles.pressed]}><Text style={styles.shareText}>{t('peers.share')} ›</Text></Pressable>

      <ScanModal open={scan} err={err} onClose={() => setScan(false)} onData={take} onPaste={paste} />
    </StaffPage>
  );
}

// The audit badge beside a peer: a dot in the verdict's colour and the word, from the ledger.
function Badge({ verdict, label }: { verdict: keyof typeof VERDICT_COLOR; label: string }) {
  return (
    <View style={styles.badge} accessibilityLabel={label}>
      <View style={[styles.badgeDot, { backgroundColor: VERDICT_COLOR[verdict] }]} />
      <Text style={[styles.badgeText, { color: VERDICT_COLOR[verdict] }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  compHit: { minHeight: 44, justifyContent: 'center', marginTop: 12 },
  compLink: { fontFamily: fonts.medium, fontSize: 13, color: colors.spotText },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: 92 },
  badgeDot: { width: 7, height: 7, borderRadius: 4 },
  badgeText: { fontFamily: fonts.medium, fontSize: 11, flexShrink: 1 },
  lede: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.mute },
  note: { fontFamily: fonts.regular, fontSize: 14, color: colors.mute, marginTop: 16 },
  section: { fontFamily: fonts.regular, fontSize: 10, letterSpacing: 1.6, color: colors.spotText, marginTop: 24 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.ink3 },
  rowText: { flex: 1, gap: 2 },
  name: { fontFamily: fonts.semibold, fontSize: 16, color: colors.paper },
  kind: { fontFamily: fonts.regular, fontSize: 12, color: colors.mute },
  meta: { fontFamily: fonts.regular, fontSize: 12, color: colors.mute },
  okText: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.spotText, marginTop: 8 },
  offText: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.violet, marginTop: 8 },
  x: { fontFamily: fonts.regular, fontSize: 22, color: colors.mute },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 16 },
  btn: { paddingHorizontal: 14, minHeight: 44, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.paper, justifyContent: 'center' },
  xHit: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontFamily: fonts.medium, fontSize: 13, color: colors.paper },
  typeRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  hint: { fontFamily: fonts.regular, fontSize: 12, color: colors.mute, marginTop: 6 },
  input: { flex: 1, height: 44, borderBottomWidth: 1, borderBottomColor: colors.ink3, fontFamily: fonts.regular, fontSize: 13, color: colors.paper },
  shareLink: { marginTop: 28, minHeight: 44, justifyContent: 'center' },
  shareText: { fontFamily: fonts.medium, fontSize: 14, color: colors.spotText },
  pressed: { opacity: 0.7 },
});
