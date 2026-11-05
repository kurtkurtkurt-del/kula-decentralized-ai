import { useCallback, useEffect, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import StaffPage, { Said } from '@/components/StaffPage';
import { Panel, Row, Value } from '@/components/Row';
import { useLang } from '@/i18n';
import { AUDIT_KINDS, detailOf, filterKind, parseLedger, summarize, verdictOf, verifyChain, type AuditEntry } from '@/llm/audit';
import { hasNative, llama } from '@/llm/native';
import { VERDICT_COLOR } from '@/theme/audit';
import { colors, fonts, radius } from '@/theme/tokens';

const WINDOW = 200;      // what the page shows
const EXPORT_MAX = 50_000; // what "export" asks the native side for: the whole current file in practice

// settings → beyin audit: the last lines of the checker's ledger, a filter by kind, refusals
// and warnings counted at the top, the chain checked line by line, export as jsonl and a
// confirmed clear. Reads only; the worker process writes.
export default function AuditScreen() {
  const { t, tx } = useLang();
  const [raw, setRaw] = useState<string[] | null>(null);
  const [kind, setKind] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!hasNative()) { setRaw([]); return; }
    const lines = await llama!.auditLedger(WINDOW).catch(() => llama!.gateLedger(WINDOW)).catch(() => [] as string[]);
    setRaw(lines);
  }, []);
  useEffect(() => {
    const id = setTimeout(load, 0); // after the render, not inside it
    return () => clearTimeout(id);
  }, [load]);

  const entries: AuditEntry[] = parseLedger(raw ?? []);
  const chain = verifyChain(raw ?? []);
  const sum = summarize(entries);
  const shown = filterKind(entries, kind).slice().reverse(); // newest first on the page

  const exportLedger = async () => {
    try {
      const lines = hasNative() ? await llama!.auditLedger(EXPORT_MAX) : [];
      const text = lines.join('\n') + (lines.length ? '\n' : '');
      const name = `beyin-${new Date().toISOString().slice(0, 10)}.jsonl`;
      if (Platform.OS === 'web') {
        const url = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        return;
      }
      const file = new File(Paths.cache, name);
      file.write(text);
      await Sharing.shareAsync(file.uri, { mimeType: 'application/x-ndjson', dialogTitle: name });
    } catch {
      setSaid(t('audit.export.failed'));
    }
  };
  const clear = () =>
    Alert.alert(t('audit.clear'), t('audit.clear.body'), [
      { text: t('word.cancel'), style: 'cancel' },
      { text: t('audit.clear.go'), style: 'destructive', onPress: () => llama?.clearAuditLedger().then((ok) => { if (!ok) setSaid(t('audit.clear.failed')); return load(); }, () => setSaid(t('audit.clear.failed'))) },
    ]);

  return (
    <StaffPage title={t('audit.title')}>
      <Text style={styles.lede}>{t('audit.lede', { n: WINDOW })}</Text>
      {!hasNative() ? <Text style={styles.note}>{t('audit.noNative')}</Text> : null}

      <View style={styles.counts}>
        <Count n={sum.rejects} label={t('audit.rejects')} color={VERDICT_COLOR.rejected} />
        <Count n={sum.warns} label={t('audit.warns')} color={VERDICT_COLOR.warn} />
        <Count n={sum.total} label={t('audit.lines')} color={colors.paper} />
      </View>

      {raw && raw.length ? (
        <View style={[styles.chain, !chain.ok && styles.chainBad]}>
          <View style={[styles.dot, { backgroundColor: chain.ok ? VERDICT_COLOR.verified : VERDICT_COLOR.rejected }]} />
          <Text style={[styles.chainText, !chain.ok && styles.chainBadText]}>
            {chain.ok ? (chain.fromGenesis ? t('audit.chain.ok') : t('audit.chain.partial')) : t('audit.chain.broken', { n: (chain.broken ?? 0) + 1 })}
            {sum.malformed ? ` · ${t('audit.malformed', { n: sum.malformed })}` : ''}
          </Text>
        </View>
      ) : null}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} style={styles.chipsWrap}>
        <Chip label={t('audit.all')} on={kind === null} onPress={() => setKind(null)} />
        {AUDIT_KINDS.map((k) => <Chip key={k} label={`${t(`audit.kind.${k}`)}${sum.byKind[k] ? ` ${sum.byKind[k]}` : ''}`} on={kind === k} onPress={() => setKind(kind === k ? null : k)} />)}
      </ScrollView>

      {raw && !raw.length && hasNative() ? <Text style={styles.note}>{t('audit.empty')}</Text> : null}
      {shown.map((e, i) => {
        if (!e.line) return <Text key={`m${i}`} style={styles.rawLine} numberOfLines={2}>{e.raw}</Text>;
        const v = verdictOf(e.line);
        return (
          <View key={`${e.line.t}-${i}`} style={styles.row}>
            <View style={[styles.dot, { backgroundColor: VERDICT_COLOR[v] }]} />
            <View style={styles.rowText}>
              <Text style={styles.name}>
                {tx(`audit.kind.${e.line.kind}`, e.line.kind)}
                <Text style={styles.kind}>  · {e.line.peer ?? t('audit.peer.this')}</Text>
              </Text>
              {detailOf(e.line) ? <Text style={styles.meta}>{detailOf(e.line)}</Text> : null}
              <Text style={styles.time}>{when(e.line.t)} · <Text style={{ color: VERDICT_COLOR[v] }}>{t(`audit.verdict.${v}`)}</Text></Text>
            </View>
          </View>
        );
      })}

      <View style={styles.space} />
      <Panel>
        <Row label={t('audit.refresh')} onPress={load} right={<Value text="" more />} />
        <Row label={t('audit.export')} hint={t('audit.export.hint')} onPress={exportLedger} right={<Value text="" more />} />
        {hasNative() ? <Row label={t('audit.clear')} onPress={clear} danger /> : null}
      </Panel>
      <Said text={said} bad />
    </StaffPage>
  );
}

function Count({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <View style={styles.count}>
      <Text style={[styles.countN, { color }]}>{n}</Text>
      <Text style={styles.countLabel}>{label}</Text>
    </View>
  );
}

function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && styles.pressed]}>
      <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
    </Pressable>
  );
}

const two = (n: number) => String(n).padStart(2, '0');
const when = (ms: number) => {
  const d = new Date(ms);
  return `${two(d.getDate())}.${two(d.getMonth() + 1)} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
};

const styles = StyleSheet.create({
  lede: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.mute },
  note: { fontFamily: fonts.regular, fontSize: 14, color: colors.mute, marginTop: 16 },
  counts: { flexDirection: 'row', gap: 10, marginTop: 18 },
  count: { flex: 1, backgroundColor: colors.ink2, borderRadius: radius.md, paddingVertical: 12, paddingHorizontal: 14 },
  countN: { fontFamily: fonts.semibold, fontSize: 24 },
  countLabel: { fontFamily: fonts.regular, fontSize: 12, color: colors.mute, marginTop: 2 },
  chain: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14, paddingVertical: 10, paddingHorizontal: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.ink3 },
  chainBad: { borderColor: colors.violet, backgroundColor: 'rgba(200,106,81,0.08)' },
  chainText: { flex: 1, fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 17, color: colors.mute },
  chainBadText: { fontFamily: fonts.medium, color: colors.violet },
  chipsWrap: { marginTop: 16, marginHorizontal: -4 },
  chips: { flexDirection: 'row', gap: 8, paddingHorizontal: 4 },
  chip: { paddingHorizontal: 12, height: 32, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.ink3, justifyContent: 'center' },
  chipOn: { borderColor: colors.paper, backgroundColor: colors.paper },
  chipText: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.paper },
  chipTextOn: { color: colors.ink },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.ink3 },
  rowText: { flex: 1, gap: 2 },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  name: { fontFamily: fonts.semibold, fontSize: 14.5, color: colors.paper },
  kind: { fontFamily: fonts.regular, fontSize: 12, color: colors.meta },
  meta: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 16, color: colors.mute },
  time: { fontFamily: fonts.jet, fontSize: 10.5, color: colors.meta, marginTop: 2 },
  rawLine: { fontFamily: fonts.jet, fontSize: 10.5, color: colors.violet, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.ink3 },
  space: { height: 20 },
  pressed: { opacity: 0.7 },
});
