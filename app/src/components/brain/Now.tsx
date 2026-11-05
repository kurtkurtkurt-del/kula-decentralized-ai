import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';
import { shareSegments } from './geometry';
import { partColor, STATE_COLOR } from './colors';

// Right now (5.11.2026): the speed as one big number, the model's parts as one stacked bar
// (who holds how much), a dot per device that fills while it works. The sentences are the
// accessibility labels.

export type NowProps = {
  speed: number | null;
  together: boolean; // apart: the devices' speeds added up
  split: { name: string; gb: number }[];
  devices: { id: string; busy: boolean; out?: boolean }[];
  loading: string | null; // the stage, already in words
  aloneFaster: boolean;
  generating: boolean;
  onChat?: () => void;
};

export default function Now({ speed, together, split, devices, loading, aloneFaster, generating, onChat }: NowProps) {
  const { t } = useLang();
  const segs = shareSegments(split);
  const busy = devices.filter((d) => d.busy).length;
  const busyText = t('brain.busy', { n: busy, all: devices.length });
  const speedText = speed != null ? `${t('brain.device.tps', { tps: speed })}${together ? ` ${t('brain.speed.together')}` : ''}` : '';
  return (
    <View style={styles.card}>
      {loading ? (
        <Text style={styles.loading} accessibilityLiveRegion="polite">{loading}</Text>
      ) : (
        <View style={styles.top}>
          <View style={styles.speed} accessible accessibilityLabel={[speedText, generating ? t('brain.generating') : ''].filter(Boolean).join(', ')}>
            <Text style={styles.big}>{speed != null ? speed : '–'}</Text>
            <View>
              <Text style={styles.unit}>tok/s</Text>
              {together ? <Text style={styles.small}>{t('brain.speed.together')}</Text> : null}
            </View>
          </View>
          <View style={styles.dots} accessible accessibilityLabel={busyText}>
            {devices.map((d) => (
              <View key={d.id} style={[styles.dot, { borderColor: STATE_COLOR[d.out ? 'out' : d.busy ? 'busy' : 'idle'] }, d.busy && { backgroundColor: STATE_COLOR.busy }]} />
            ))}
          </View>
        </View>
      )}

      {segs.length ? (
        <View accessible accessibilityLabel={`${t('brain.shares')}: ${segs.map((s) => `${s.name.toLowerCase()} ${s.gb} gb`).join(', ')}`}>
          <View style={styles.bar}>
            {segs.map((s, i) => (
              <View key={s.name} style={[styles.part, { flex: s.frac, backgroundColor: partColor(i) }]} />
            ))}
          </View>
          <View style={styles.legend}>
            {segs.map((s, i) => (
              <View key={s.name} style={styles.key}>
                <View style={[styles.keyDot, { backgroundColor: partColor(i) }]} />
                <Text style={styles.keyName} numberOfLines={1}>{s.name.toLowerCase()}</Text>
                <Text style={styles.keyGb}>{s.gb} gb</Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      <View style={styles.foot}>
        {aloneFaster ? (
          <View style={styles.chip} accessible accessibilityLabel={t('brain.plan.aloneFaster')}>
            <Text style={styles.chipText}>{t('brain.short.aloneFaster')}</Text>
          </View>
        ) : <View />}
        {onChat && !loading ? (
          <Pressable onPress={onChat} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('brain.open.chat')}>
            <Text style={styles.link}>{t('brain.open.chat')} ›</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, borderRadius: radius.md, backgroundColor: colors.ink2, marginTop: 4, gap: 12 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  speed: { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  big: { fontFamily: fonts.semibold, fontSize: 40, lineHeight: 42, letterSpacing: -1.4, color: colors.paper },
  unit: { fontFamily: fonts.medium, fontSize: 13, color: colors.paper2, marginBottom: 6 },
  small: { fontFamily: fonts.regular, fontSize: 11, color: colors.mute, marginTop: -4, marginBottom: 6 },
  loading: { fontFamily: fonts.medium, fontSize: 14, color: colors.spotText },
  dots: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 5, maxWidth: 120 },
  dot: { width: 11, height: 11, borderRadius: 6, borderWidth: 2 },
  bar: { flexDirection: 'row', height: 12, borderRadius: 6, overflow: 'hidden', gap: 2, backgroundColor: colors.ink2 },
  part: { height: 12 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 4, marginTop: 8 },
  key: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: '100%' },
  keyDot: { width: 7, height: 7, borderRadius: 4 },
  keyName: { fontFamily: fonts.regular, fontSize: 12, color: colors.paper, maxWidth: 120 },
  keyGb: { fontFamily: fonts.jet, fontSize: 10.5, color: colors.mute },
  foot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  chip: { paddingHorizontal: 9, height: 22, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.gold, justifyContent: 'center' },
  chipText: { fontFamily: fonts.medium, fontSize: 11.5, color: colors.paper2 },
  link: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.spotText },
});
