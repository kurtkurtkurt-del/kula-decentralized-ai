import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLang } from '@/i18n';
import { explain } from '@/llm/errors';
import { leftText } from '@/llm/progress';
import { cancelDownload, pauseDownload, retryDownload, type Download } from '@/llm/store';
import { tapSelect } from '@/lib/haptics';
import { colors, fonts, radius } from '@/theme/tokens';

// One download (5.11.2026): name, state in words, speed and time left (a smoothed rate over
// the last few seconds), pause / resume / retry, and the note that it keeps going in the
// background and survives a kill. Used on the models tab and on the model page.
// × (or a long press on the card, as on a model row) removes it (6.11.2026): cancelled, the
// half file deleted, gone from the list at once, also when it is paused or failed
// (store.ts cancelDownload says why it used to come back).
const gb = (b: number) => `${(b / 1024 ** 3).toFixed(b < 1024 ** 3 ? 2 : 1)} gb`;

export default function DownloadCard({ d, compact }: { d: Download; compact?: boolean }) {
  const { t, tx } = useLang();
  const bps = d.state === 'running' ? d.bps : null;

  const pct = d.total > 0 ? Math.min(100, Math.round((d.got / d.total) * 100)) : 0;
  const failed = d.state === 'error';
  const paused = d.state === 'paused';
  const stateLine = failed ? explain(d.error, tx) : paused ? t('dl.paused') : d.state === 'retrying' ? t('models.state.retrying') : d.state === 'checking' ? t('models.state.checking') : t('models.state.running');
  const tail = [gb(d.got) + ' / ' + gb(d.total), d.state === 'running' && bps ? t('dl.speed', { mbs: (bps / 1048576).toFixed(1) }) : '', d.state === 'running' ? leftText(t, d.total - d.got, bps) : ''].filter(Boolean).join(' · ');
  const remove = () => { tapSelect(); cancelDownload(d.id).catch(() => {}); };
  const primary = failed || paused ? { label: failed ? t('models.retry') : t('dl.resume'), on: () => retryDownload(d.id) } : { label: t('dl.pause'), on: () => pauseDownload(d.id) };

  return (
    <Pressable onLongPress={remove} style={styles.card} accessible={false} testID={`download-${d.id}`}>
      <View style={styles.head}>
        <View style={styles.text}>
          <Text style={styles.name} numberOfLines={1}>{d.model.name.toLowerCase()}</Text>
          <Text style={[styles.meta, failed && styles.bad]}>{stateLine}</Text>
          <Text style={styles.meta}>{tail}</Text>
        </View>
        <View style={styles.btns}>
          <Pressable onPress={() => { tapSelect(); primary.on(); }} accessibilityRole="button" accessibilityLabel={primary.label} style={({ pressed }) => [styles.btn, pressed && styles.pressed]}>
            <Text style={styles.btnText}>{primary.label}</Text>
          </Pressable>
          <Pressable onPress={remove} accessibilityRole="button" accessibilityLabel={`${t('modelsui.dl.remove')} · ${d.model.name.toLowerCase()}`} hitSlop={8} testID={`download-remove-${d.id}`} style={({ pressed }) => [styles.x, pressed && styles.pressed]}>
            <Text style={styles.xText}>×</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.bar} accessibilityRole="progressbar" accessibilityLabel={t('a11y.progress', { pct })} accessibilityValue={{ min: 0, max: 100, now: pct }}>
        <View style={[styles.barIn, { width: `${pct}%` }, paused && styles.barPaused]} />
      </View>
      {!compact && !failed ? <Text style={styles.note}>{t('dl.background')}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.ink3, gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  text: { flex: 1, gap: 3 },
  name: { fontFamily: fonts.semibold, fontSize: 16, color: colors.paper },
  meta: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 16, color: colors.mute },
  bad: { color: colors.violet, fontFamily: fonts.medium },
  btns: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  btn: { paddingHorizontal: 14, minHeight: 44, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.paper, justifyContent: 'center' },
  btnText: { fontFamily: fonts.medium, fontSize: 13, color: colors.paper },
  x: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  xText: { fontFamily: fonts.regular, fontSize: 22, color: colors.meta },
  bar: { height: 4, backgroundColor: colors.ink3, borderRadius: 2, overflow: 'hidden' },
  barIn: { height: 4, backgroundColor: colors.spot },
  barPaused: { backgroundColor: colors.meta },
  note: { fontFamily: fonts.regular, fontSize: 11.5, lineHeight: 15, color: colors.meta },
  pressed: { opacity: 0.6 },
});
