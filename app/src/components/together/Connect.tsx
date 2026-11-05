import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { useLang } from '@/i18n';
import { classify, explain } from '@/llm/errors';
import { isRemote } from '@/llm/peers';
import { type Peer } from '@/llm/store';
import { tapDone } from '@/lib/haptics';
import ScanSheet from '@/components/together/ScanSheet';
import { takeCode, type Ping } from '@/components/together/tests';
import { colors, fonts, radius } from '@/theme/tokens';

// Part 2, connect for real: the phones paired with this one (the same peer book as the
// peers page), a scan of another phone's share code, paste, and the way to this phone's
// own code. A ping result from part 3 shows beside each phone.
export default function Connect({ peers, pings }: { peers: Peer[]; pings: Record<string, Ping | 'busy'> }) {
  const { t, tx } = useLang();
  const [scan, setScan] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 3500);
    return () => clearTimeout(id);
  }, [note]);

  const take = (text: string) => {
    try {
      const r = takeCode(text);
      setErr(null);
      tapDone();
      setNote(r.kind === 'passport' ? t('power.linked') : t('peers.added', { name: r.name }));
      setScan(false);
      return true;
    } catch (e) {
      // the code's own words first (notPeer · self · old · noRelay), the dictionary for the rest
      const code = (e as Error).message;
      const own = tx(`peers.err.${code}`, tx(`devices.err.${code}`, ''));
      setErr(own || (classify(e).kind === 'unknown' ? t('peers.err.notPeer') : explain(e, tx)));
      return false;
    }
  };
  const open = () => {
    setErr(null);
    setScan(true);
  };
  const paste = async () => take((await Clipboard.getStringAsync().catch(() => '')) ?? '');

  return (
    <View>
      {peers.length === 0 ? <Text style={s.empty}>{t('power.none')}</Text> : null}
      {peers.map((p) => {
        const ping = pings[p.id];
        return (
          <View key={p.id} style={s.row}>
            <View style={[s.dot, ping && ping !== 'busy' && (ping.ok ? s.dotOk : s.dotOff)]} />
            <View style={s.rowText}>
              <Text style={s.name} numberOfLines={1}>{p.name.toLowerCase()}<Text style={s.kind}>  · {t(`peers.kind.${p.kind}`)}</Text></Text>
              <Text style={s.meta} numberOfLines={1}>{[isRemote(p) ? `${t('peers.far')} ${p.relay!.code}` : `${p.host}:${p.port}`, p.ram ? `${Math.round((p.ram / 1024) * 10) / 10} gb` : '', p.bw ? `${p.bw} gb/s` : ''].filter(Boolean).join(' · ')}</Text>
            </View>
            <Text style={[s.ping, ping && ping !== 'busy' && !ping.ok && s.pingOff]} numberOfLines={1}>
              {ping === 'busy' ? '…' : ping ? (ping.ok ? `${ping.ms} ms` : t('peers.off')) : ''}
            </Text>
          </View>
        );
      })}
      <View style={s.actions}>
        <Pressable onPress={open} accessibilityRole="button" accessibilityLabel={t('power.scan')} style={({ pressed }) => [s.btn, s.btnMain, pressed && s.pressed]} testID="power-scan">
          <Text style={[s.btnText, s.btnTextMain]}>{t('power.scan')}</Text>
        </Pressable>
        <Pressable onPress={paste} accessibilityRole="button" accessibilityLabel={t('peers.paste')} style={({ pressed }) => [s.btn, pressed && s.pressed]}>
          <Text style={s.btnText}>{t('peers.paste')}</Text>
        </Pressable>
      </View>
      {note ? <Text style={s.ok} accessibilityLiveRegion="polite">{note}</Text> : null}
      {err && !scan ? <Text style={s.off} accessibilityRole="alert">{err}</Text> : null}
      <View style={s.links}>
        <Pressable onPress={() => router.push('/share')} accessibilityRole="button" style={({ pressed }) => [s.link, pressed && s.pressed]}><Text style={s.linkText}>{t('power.showMine')} ›</Text></Pressable>
        <Pressable onPress={() => router.push('/peers')} accessibilityRole="button" style={({ pressed }) => [s.link, pressed && s.pressed]}><Text style={s.linkText}>{t('power.manage')} ›</Text></Pressable>
      </View>
      <ScanSheet open={scan} onClose={() => setScan(false)} onCode={take} err={err} />
    </View>
  );
}

const s = StyleSheet.create({
  empty: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.mute, marginTop: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.ink3 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.ink3 },
  dotOk: { backgroundColor: colors.spot },
  dotOff: { backgroundColor: colors.violet },
  rowText: { flex: 1, gap: 2 },
  name: { fontFamily: fonts.semibold, fontSize: 16, color: colors.paper },
  kind: { fontFamily: fonts.regular, fontSize: 12, color: colors.mute },
  meta: { fontFamily: fonts.regular, fontSize: 12, color: colors.mute },
  ping: { fontFamily: fonts.jet, fontSize: 12, color: colors.spotText, maxWidth: 110 },
  pingOff: { color: colors.violet },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 14 },
  btn: { paddingHorizontal: 16, minHeight: 44, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.paper, justifyContent: 'center' },
  btnMain: { backgroundColor: colors.paper },
  btnText: { fontFamily: fonts.medium, fontSize: 13, color: colors.paper },
  btnTextMain: { color: colors.ink },
  ok: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.spotText, marginTop: 10 },
  off: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.violet, marginTop: 10 },
  links: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 20, marginTop: 8 },
  link: { minHeight: 44, justifyContent: 'center' },
  linkText: { fontFamily: fonts.medium, fontSize: 13.5, color: colors.spotText },
  pressed: { opacity: 0.7 },
});
