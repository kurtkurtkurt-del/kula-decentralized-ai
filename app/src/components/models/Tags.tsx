import { StyleSheet, Text, View } from 'react-native';
import InfoTip from '@/components/InfoTip';
import { useLang } from '@/i18n';
import type { Fit } from '@/llm/fit';
import { colors, fonts, radius } from '@/theme/tokens';
import ModelIcon from './ModelIcon';

// What a model is good at, as small icons (6.11.2026: the user wanted the models more
// visual). Each icon is a tap target; the bubble says the word and one short line. The
// chosen list's tags are read off each model's "good at" / "use for" text in catalog.ts;
// a hugging face file gets a guess from its name and size.
export type TagId = 'chat' | 'fast' | 'summary' | 'translate' | 'extract' | 'write' | 'reason' | 'code' | 'quality';

const CATALOG_TAGS: Record<string, TagId[]> = {
  'qwen3-0.6b-q8': ['fast', 'chat'],
  'gemma3-1b-q4': ['summary', 'translate', 'chat'],
  'llama3.2-1b-q4': ['extract', 'chat'],
  'qwen2.5-1.5b-q4': ['write', 'summary', 'extract', 'translate'],
  'qwen3-1.7b-q8': ['reason', 'translate'],
  'llama3.2-3b-q4': ['chat', 'write', 'code'],
  'qwen3-4b-q4': ['reason', 'code', 'write'],
  'phi4-mini-q4': ['reason', 'code'],
  'qwen2.5-7b-q4': ['quality', 'write', 'code', 'translate'],
  'qwen3-30b-a3b': ['quality', 'reason', 'code', 'translate'],
  'gemma4-26b-a4b': ['quality', 'write', 'translate', 'code'],
};

export function tagsOf(m: { id: string; name: string; params_b: number }): TagId[] {
  const known = CATALOG_TAGS[m.id];
  if (known) return known;
  const n = `${m.id} ${m.name}`.toLowerCase();
  const out: TagId[] = [];
  if (m.params_b > 0 && m.params_b <= 1) out.push('fast');
  if (/coder|code/.test(n)) out.push('code');
  if (/r1|think|reason|math/.test(n)) out.push('reason');
  if (/instruct|chat|-it\b/.test(n)) out.push('chat');
  if (m.params_b >= 7) out.push('quality');
  return out;
}

export function TagIcons({ tags, size = 15 }: { tags: TagId[]; size?: number }) {
  const { t } = useLang();
  if (!tags.length) return null;
  return (
    <View style={styles.row}>
      {tags.map((id) => (
        <InfoTip key={id} title={t(`modelsui.tag.${id}`)} text={t(`modelsui.tag.${id}.why`)} accessibilityLabel={t(`modelsui.tag.${id}`)}>
          <View style={[styles.tag, { width: size + 14, height: size + 14, borderRadius: (size + 14) / 2 }]}>
            <ModelIcon name={id} size={size} color={colors.paper2} />
          </View>
        </InfoTip>
      ))}
    </View>
  );
}

/** The fit as a badge with a mark: ✓ fits · ~ tight · two people together · × no. */
export function FitBadge({ fit, together }: { fit: Pick<Fit, 'verdict'>; together: Pick<Fit, 'verdict'> | null }) {
  const { t } = useLang();
  const v = fit.verdict === 'fits' ? 'fits' : fit.verdict === 'tight' ? 'tight' : together && together.verdict !== 'no' ? 'together' : 'no';
  const text = v === 'fits' ? t('models.fits') : v === 'tight' ? t('models.tight') : v === 'together' ? t('models.together') : t('models.no');
  const tone = v === 'fits' ? styles.ok : v === 'no' ? styles.none : styles.mid;
  return (
    <InfoTip title={text} text={t(`modelsui.fit.${v}`)}>
      <View style={[styles.badge, tone]}>
        <ModelIcon name={v} size={12} color={v === 'no' ? colors.paper2 : colors.ink} strokeWidth={2} />
        <Text style={[styles.badgeText, v === 'no' && styles.badgeTextNo]}>{text}</Text>
      </View>
    </InfoTip>
  );
}

/** The crown beside the main device's name. */
export function MainMark({ label, size = 14 }: { label?: string; size?: number }) {
  return (
    <View style={styles.main} accessibilityLabel={label}>
      <ModelIcon name="crown" size={size} color={colors.gold} />
      {label ? <Text style={styles.mainText}>{label}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  tag: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.ink2 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, height: 22, borderRadius: radius.pill },
  ok: { backgroundColor: colors.green },
  mid: { backgroundColor: colors.gold },
  none: { backgroundColor: colors.ink3 },
  badgeText: { fontFamily: fonts.medium, fontSize: 10.5, color: colors.ink, letterSpacing: 0.4 },
  badgeTextNo: { color: colors.paper2 },
  main: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  mainText: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.paper2 },
});
