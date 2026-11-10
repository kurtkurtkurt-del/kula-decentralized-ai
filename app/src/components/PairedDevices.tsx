import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Section } from '@/components/Row';
import { useLang } from '@/i18n';
import { tapDone, tapSelect } from '@/lib/haptics';
import { hasNative, llama, type PairedDevice } from '@/llm/native';
import { agoOf, isConnected, pairedName, shortFp, withoutFps } from '@/llm/paired';
import { colors, fonts } from '@/theme/tokens';

// "devices that can use this phone" (10.11.2026, docs/GATE.md "remove a device's access"):
// every master paired with this phone's gate, with when it paired and was last here, and a
// remove button behind a confirmation. Removing takes effect at once: the gate refuses the
// device's next connection, the worker cuts what it has open, the ledger gets a signed line
// (Unpair.kt). Shown on the share screen and, for the devices not already in its own list,
// on the computers screen (`skip`: those fingerprints).
export default function PairedDevices({ skip = [], peer, others = false }: { skip?: string[]; peer?: string | null; others?: boolean }) {
  const { t, up } = useLang();
  const [all, setAll] = useState<PairedDevice[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const can = hasNative() && typeof llama?.pairedDevices === 'function';

  const refresh = useCallback(async () => {
    if (!can) return;
    const l = await llama!.pairedDevices!().catch(() => null);
    if (l) setAll(l);
  }, [can]);

  useEffect(() => {
    if (!can) return;
    const first = setTimeout(refresh, 0);
    const id = setInterval(refresh, 4000);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [can, refresh]);

  useEffect(() => {
    if (!note) return;
    const id = setTimeout(() => setNote(null), 5000);
    return () => clearTimeout(id);
  }, [note]);

  if (!can || all === null) return null;
  const list = withoutFps(all, skip);
  // the computers screen shows this part only when there is something beyond its own list
  if (others && list.length === 0) return null;

  const remove = (d: PairedDevice) => {
    const name = pairedName(d);
    tapSelect();
    Alert.alert(t('comp.access.confirm.title', { name }), t('comp.access.confirm.body'), [
      { text: t('word.cancel'), style: 'cancel' },
      {
        text: t('comp.access.remove'),
        style: 'destructive',
        onPress: () => {
          setErr(null);
          setBusy(d.fp);
          llama!.removePaired!(d.fp)
            .then((l) => { setAll(l); tapDone(); setNote(t('comp.access.removed', { name })); })
            .catch((e: unknown) => setErr(String((e as Error)?.message ?? e)))
            .finally(() => setBusy(null));
        },
      },
    ]);
  };

  const when = (ms: number) => { const a = agoOf(ms); return t(a.key as never, a.vars); };

  return (
    <View style={styles.wrap} testID="paired-devices">
      <Section title={t(others ? 'comp.access.others' : 'comp.access')} />
      <Text style={styles.hint}>{list.length ? t('comp.access.hint') : t('comp.access.none')}</Text>
      {list.map((d) => {
        const now = isConnected(d, peer);
        const line = now ? t('comp.access.now') : d.lastSeen ? t('comp.access.seen', { when: when(d.lastSeen) }) : d.pairedAt ? `${t('comp.access.never')} · ${t('comp.access.paired', { when: when(d.pairedAt) })}` : t('comp.access.never');
        return (
          <View key={d.fp} style={styles.row}>
            <View style={styles.text}>
              <Text style={styles.name} numberOfLines={1}>{pairedName(d)}</Text>
              <Text style={[styles.meta, now && styles.on]}>{line}{d.address && !now ? ` · ${d.address}` : ''}{d.computer ? ` · ${t('comp.access.computer')}` : ''}</Text>
              {d.name ? <Text style={styles.mono}>{up(shortFp(d.fp))}</Text> : null}
            </View>
            <Pressable onPress={() => remove(d)} disabled={busy !== null} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('comp.access.removeLabel', { name: pairedName(d) })} style={styles.btn} testID={`unpair-${d.fp.slice(0, 8)}`}>
              <Text style={[styles.btnText, busy === d.fp && styles.dim]}>{t('comp.access.remove')}</Text>
            </Pressable>
          </View>
        );
      })}
      {note ? <Text style={styles.ok} accessibilityLiveRegion="polite">{note}</Text> : null}
      {err ? <Text style={styles.err} accessibilityRole="alert">{err}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 12 },
  hint: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: colors.mute, marginTop: 6 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.ink3, gap: 10 },
  text: { flex: 1, gap: 2 },
  name: { fontFamily: fonts.semibold, fontSize: 15, color: colors.paper },
  meta: { fontFamily: fonts.regular, fontSize: 12, color: colors.mute, flexShrink: 1 },
  on: { color: colors.spotText },
  mono: { fontFamily: fonts.jet, fontSize: 10.5, letterSpacing: 1, color: colors.meta },
  btn: { minHeight: 44, minWidth: 64, alignItems: 'flex-end', justifyContent: 'center' },
  btnText: { fontFamily: fonts.medium, fontSize: 13, color: colors.violet },
  dim: { opacity: 0.5 },
  ok: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.spotText, marginTop: 8 },
  err: { fontFamily: fonts.medium, fontSize: 13, color: colors.violet, marginTop: 8 },
});
