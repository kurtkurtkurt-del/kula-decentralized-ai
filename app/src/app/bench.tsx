import { useEffect, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as Clipboard from 'expo-clipboard';
import StaffPage from '@/components/StaffPage';
import Button from '@/components/Button';
import { useLang } from '@/i18n';
import { benchHistory, benchLines, forgetBench, onBenchChange, type BenchResult } from '@/llm/bench';
import { canBench, runPhoneBench, type Step } from '@/llm/benchrun';
import { useEngine } from '@/llm/engine';
import { usePeers } from '@/llm/store';
import { colors, fonts, radius } from '@/theme/tokens';

// settings → bench: one button, a line per step while it runs, the result as a card with
// "share json", and the earlier runs kept on this phone (kv-store, newest first). The json
// is kula-bench/1, the same file kula-node bench writes (docs/BENCH.md).
export default function BenchScreen() {
  const { t, up } = useLang();
  const engine = useEngine();
  const peers = usePeers();
  const [history, setHistory] = useState<BenchResult[]>(benchHistory);
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<BenchResult | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => onBenchChange(() => setHistory(benchHistory())), []);
  useEffect(() => {
    if (!said) return;
    const id = setTimeout(() => setSaid(null), 3000);
    return () => clearTimeout(id);
  }, [said]);

  const stepText = (step: Step, who?: string) =>
    step === 'local' ? t('bench.step.local', { n: 64 }) : step === 'peers' ? t('bench.step.peers', { name: who ?? '' }) : t(`bench.step.${step}`);
  const run = async () => {
    if (running) return;
    setResult(null);
    setRunning(stepText('memory'));
    try {
      const r = await runPhoneBench({ onStep: (s, who) => setRunning(stepText(s, who)) });
      setResult(r);
    } catch (e) {
      setSaid(t('bench.failed', { why: (e as Error).message }));
    } finally {
      setRunning(null);
    }
  };
  const share = async (r: BenchResult) => {
    const json = JSON.stringify(r, null, 2);
    const name = `kula-bench-${r.measured_at.slice(0, 19).replace(/[:]/g, '-')}.json`;
    try {
      if (Platform.OS === 'web' || !(await Sharing.isAvailableAsync())) {
        await Clipboard.setStringAsync(json);
        setSaid(t('bench.copied'));
        return;
      }
      const file = new File(Paths.cache, name);
      file.write(json);
      await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: name, UTI: 'public.json' });
    } catch {
      Alert.alert(t('bench.shareFailed'));
    }
  };

  const shown = result ?? history[0] ?? null;
  const measuredNote = shown?.local && shown.model ? t('bench.used', { name: shown.device.name.toLowerCase(), model: shown.model.name }) : null;
  return (
    <StaffPage title={t('bench.title')}>
      <Text style={styles.lede}>{t('bench.lede')}</Text>
      {!canBench() ? <Text style={styles.note}>{t('bench.noNative')}</Text> : null}
      <Text style={styles.meta}>{engine.model && engine.load ? t('bench.model', { name: engine.model.name.toLowerCase(), mode: engine.mode }) : t('bench.noModel')}</Text>
      {peers.length ? <Text style={styles.meta}>{peers.map((p) => p.name.toLowerCase()).join(' · ')}</Text> : null}
      <View style={styles.btn}>
        <Button label={running ? t('bench.running') : t('bench.run')} onPress={canBench() && !running ? run : undefined} />
      </View>
      {running ? <Text style={styles.step}>{running}</Text> : null}
      {said ? <Text style={styles.said}>{said}</Text> : null}

      {shown ? (
        <View style={styles.card}>
          <Text style={styles.small}>{up(t('bench.result'))} · {shown.measured_at.slice(0, 16).replace('T', ' ')}</Text>
          {benchLines(shown).map((l, i) => <Text key={i} style={i === 0 ? styles.cardHead : styles.line}>{l}</Text>)}
          {measuredNote ? <Text style={styles.used}>{measuredNote}</Text> : null}
          <View style={styles.actions}>
            <Pressable onPress={() => share(shown)} style={({ pressed }) => [styles.action, pressed && styles.pressed]}><Text style={styles.actionText}>{t('bench.share')}</Text></Pressable>
          </View>
        </View>
      ) : null}

      <Text style={styles.section}>{up(t('bench.history'))}</Text>
      {history.length === 0 ? <Text style={styles.note}>{t('bench.none')}</Text> : null}
      {history.map((r) => (
        <Pressable key={r.measured_at} onPress={() => setResult(r)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
          <View style={styles.rowText}>
            <Text style={styles.rowHead}>{r.measured_at.slice(0, 16).replace('T', ' ')} · {r.model ? r.model.name : '—'}</Text>
            <Text style={styles.line}>{[r.memory ? `${r.memory.bandwidth_gbs} gb/s` : null, r.local ? `${r.local.gen_tps.median} tok/s` : null, `${r.peers.filter((p) => !p.error).length}/${r.peers.length} peers`].filter(Boolean).join(' · ')}</Text>
          </View>
          <Pressable onPress={() => { forgetBench(r.measured_at); if (result?.measured_at === r.measured_at) setResult(null); }} hitSlop={10} accessibilityLabel={t('bench.forget')}><Text style={styles.x}>×</Text></Pressable>
        </Pressable>
      ))}
    </StaffPage>
  );
}

const styles = StyleSheet.create({
  lede: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 21, color: colors.mute, marginBottom: 10 },
  note: { fontFamily: fonts.regular, fontSize: 13, color: colors.mute, marginTop: 6 },
  meta: { fontFamily: fonts.jet, fontSize: 11.5, color: colors.meta, marginTop: 2 },
  btn: { marginTop: 16 },
  step: { fontFamily: fonts.jet, fontSize: 12, color: colors.spotText, marginTop: 10 },
  said: { fontFamily: fonts.regular, fontSize: 13, color: colors.mute, marginTop: 8 },
  card: { marginTop: 18, padding: 14, borderRadius: radius.md, borderWidth: 1, borderColor: colors.ink3, gap: 4 },
  small: { fontFamily: fonts.semibold, fontSize: 11, letterSpacing: 1, color: colors.mute },
  cardHead: { fontFamily: fonts.semibold, fontSize: 15, color: colors.paper, marginTop: 4 },
  line: { fontFamily: fonts.jet, fontSize: 11.5, lineHeight: 17, color: colors.mute },
  used: { fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18, color: colors.spotText, marginTop: 6 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 10 },
  action: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.paper },
  actionText: { fontFamily: fonts.semibold, fontSize: 13, color: colors.paper },
  pressed: { opacity: 0.6 },
  section: { fontFamily: fonts.semibold, fontSize: 11, letterSpacing: 1, color: colors.mute, marginTop: 24, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.ink3 },
  rowText: { flex: 1, gap: 2 },
  rowHead: { fontFamily: fonts.regular, fontSize: 13.5, color: colors.paper },
  x: { fontFamily: fonts.regular, fontSize: 22, color: colors.mute, paddingHorizontal: 8 },
});
