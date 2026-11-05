import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import StaffPage from '@/components/StaffPage';
import Button from '@/components/Button';
import PickerSheet from '@/components/PickerSheet';
import { Panel, Row, Section, Value } from '@/components/Row';
import { useLang } from '@/i18n';
import { hasNative, llama } from '@/llm/native';
import { useLocalModels, usePeers, useSettings } from '@/llm/store';
import { runPhoneBench, type Step } from '@/bench/run';
import { clearBench, saveBench, useBenchHistory } from '@/bench/store';
import type { BenchRecord, Series } from '@/bench/core';
import { colors, fonts, radius } from '@/theme/tokens';

// The bench (docs/BENCH.md): what this phone really does on a model, and the gate and the
// tunnel to every paired device. Kept here (kv-store) for the planner; shared as json for a
// computer or for us. The same record kula-node bench writes on a computer.
export default function BenchScreen() {
  const { t } = useLang();
  const models = useLocalModels().filter((m) => !!m.path);
  const peers = usePeers();
  const settings = useSettings();
  const history = useBenchHistory();
  const [modelId, setModelId] = useState<string | null>(settings.modelId);
  const [picking, setPicking] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [shown, setShown] = useState<BenchRecord | null>(null);
  const model = models.find((m) => m.id === modelId) ?? models[0] ?? null;
  const result = shown ?? history[0] ?? null;

  const run = async () => {
    setErr(null);
    setShown(null);
    llama?.keepScreenOn(true).catch(() => {});
    try {
      const r = await runPhoneBench(model, peers, { onStep: (s: Step, what?: string) => setStep(t(`bench.step.${s}`, { what: what ?? '' })) });
      saveBench(r);
      setShown(r);
    } catch (e) {
      setErr(t('bench.failed', { err: (e as Error).message }));
    } finally {
      setStep(null);
      llama?.keepScreenOn(false).catch(() => {});
    }
  };

  const shareJson = async (r: BenchRecord) => {
    const name = `kula-bench-${r.at.slice(0, 19).replace(/:/g, '-')}.json`;
    const file = new File(Paths.cache, name);
    file.write(JSON.stringify(r, null, 2));
    await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: name, UTI: 'public.json' }).catch(() => {});
  };

  const busy = step !== null;
  return (
    <StaffPage title={t('bench.title')}>
      <Text style={styles.lede}>{t('bench.lede')}</Text>
      {!hasNative() ? <Text style={styles.err}>{t('models.noNative')}</Text> : null}

      <Panel>
        <Row label={t('bench.model')} onPress={models.length > 1 ? () => setPicking(true) : undefined} right={<Value text={model ? model.name.toLowerCase() : '—'} more={models.length > 1} />} />
        <Row label={t('bench.peers')} hint={peers.length ? undefined : t('bench.peers.none')} right={<Value text={peers.length ? peers.map((p) => p.name).join(', ').toLowerCase() : ''} />} />
      </Panel>
      {!model ? <Text style={styles.hint}>{t('bench.noModel')}</Text> : null}

      <View style={styles.actions}>
        {busy ? (
          <View style={styles.card}>
            <Text style={styles.state}>{step}</Text>
            <Text style={styles.meta}>{t('bench.wait')}</Text>
          </View>
        ) : (
          <Button label={t('bench.run')} onPress={run} kind="red" />
        )}
      </View>
      {err ? <Text style={styles.err}>{err}</Text> : null}

      {result && !busy ? <ResultCard r={result} onShare={() => shareJson(result)} /> : null}

      <Section title={t('bench.history')} />
      {history.length ? (
        <Panel>
          {history.map((r) => (
            <Row key={r.at} label={`${r.at.slice(0, 16).replace('T', ' ')} · ${r.model?.id ?? '—'}`} onPress={() => setShown(r)}
              right={<Value text={r.local.gen ? `${r.local.gen.median} tok/s` : r.local.mem_bw_gbs ? `${r.local.mem_bw_gbs} gb/s` : '—'} more />} />
          ))}
          <Row label={t('bench.clear')} onPress={() => { clearBench(); setShown(null); }} danger />
        </Panel>
      ) : (
        <Text style={styles.hint}>{t('bench.empty')}</Text>
      )}

      <PickerSheet open={picking} title={t('bench.model')} options={models.map((m) => ({ id: m.id, label: m.name.toLowerCase(), extra: m.quant }))} selected={model?.id ?? null}
        onSelect={(id) => { setModelId(id); setPicking(false); }} onClose={() => setPicking(false)} />
    </StaffPage>
  );
}

function ResultCard({ r, onShare }: { r: BenchRecord; onShare: () => void }) {
  const { t } = useLang();
  const s = (x: Series | null) => (x ? `${x.median} ${x.unit}` : '—');
  const line = (label: string, value: string, sub?: string) => (
    <View style={styles.line} key={label}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.right}>
        <Text style={styles.value}>{value}</Text>
        {sub ? <Text style={styles.sub}>{sub}</Text> : null}
      </View>
    </View>
  );
  const runs = (x: Series | null) => (x ? `${t('bench.median', { n: x.runs.length })}: ${x.runs.join(' / ')}` : undefined);
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{t('bench.result')} · {r.at.slice(0, 16).replace('T', ' ')}{r.model ? ` · ${r.model.id}` : ''}</Text>
      {line(t('bench.bw'), r.local.mem_bw_gbs != null ? `${r.local.mem_bw_gbs} gb/s` : '—')}
      {line(t('bench.prompt'), s(r.local.prompt), runs(r.local.prompt))}
      {line(t('bench.gen'), s(r.local.gen), runs(r.local.gen))}
      {line(t('bench.first'), s(r.local.first_token_ms))}
      {r.peers.map((p) => (
        <View key={p.id} style={styles.peer}>
          <Text style={styles.peerName}>{p.loopback ? t('bench.loopback') : p.name.toLowerCase()}</Text>
          {line(t('bench.gate'), s(p.gate_rtt_ms), runs(p.gate_rtt_ms))}
          {line(t('bench.tunnel'), p.tunnel_mb_s != null ? `${p.tunnel_mb_s} mb/s` : '—', `${p.tunnel_mb} mb`)}
          {p.error ? <Text style={styles.warn}>{p.error}</Text> : null}
        </View>
      ))}
      {r.skipped.length ? (
        <View style={styles.peer}>
          <Text style={styles.peerName}>{t('bench.skipped')}</Text>
          {r.skipped.map((x) => <Text key={x.what + x.why} style={styles.sub}>{x.what}: {x.why}</Text>)}
        </View>
      ) : null}
      <Pressable onPress={onShare} hitSlop={8}><Text style={styles.link}>{t('bench.share')} ›</Text></Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  lede: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.mute, marginBottom: 12 },
  hint: { fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18, color: colors.mute, marginTop: 6 },
  actions: { marginTop: 18, gap: 10 },
  card: { marginTop: 16, padding: 14, borderRadius: radius.md, backgroundColor: colors.ink2, gap: 6 },
  cardTitle: { fontFamily: fonts.semibold, fontSize: 14, color: colors.paper, marginBottom: 4 },
  state: { fontFamily: fonts.semibold, fontSize: 16, color: colors.spotText },
  meta: { fontFamily: fonts.regular, fontSize: 12, color: colors.mute },
  line: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 2 },
  label: { fontFamily: fonts.regular, fontSize: 13, color: colors.mute, flexShrink: 1 },
  right: { alignItems: 'flex-end', flexShrink: 1 },
  value: { fontFamily: fonts.jet, fontSize: 13, color: colors.paper },
  sub: { fontFamily: fonts.jet, fontSize: 10.5, color: colors.meta },
  peer: { marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.ink3, gap: 4 },
  peerName: { fontFamily: fonts.medium, fontSize: 13, color: colors.paper },
  warn: { fontFamily: fonts.medium, fontSize: 12, color: colors.violet },
  link: { fontFamily: fonts.medium, fontSize: 13, color: colors.spotText, marginTop: 8 },
  err: { fontFamily: fonts.medium, fontSize: 13, color: colors.violet, marginTop: 12 },
});
