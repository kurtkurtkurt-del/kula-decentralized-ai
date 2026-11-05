import { useState } from 'react';
import { LayoutAnimation, Pressable, StyleSheet, Text, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import BrainGlyph from '@/components/BrainGlyph';
import { useLang } from '@/i18n';
import type { BrainEntry } from '@/llm/brainlog';
import { colors, fonts, radius } from '@/theme/tokens';
import { TONE_COLOR } from './colors';
import { big } from './stats';
import { shortKey, unitTotals, type Group } from './grouping';

// What it decided, as a timeline (5.11.2026): a mark per kind on a rail, a few words, the time
// on the right; a run of the same line folds into one row with a count. A tap opens the
// sentences (at most OPEN of them); a screen reader hears the newest sentence either way.
const OPEN = 6;

const two = (n: number) => String(n).padStart(2, '0');
export const clock = (ms: number, now = Date.now()) => {
  const d = new Date(ms);
  const today = new Date(now).toDateString() === d.toDateString();
  return `${today ? '' : `${two(d.getDate())}.${two(d.getMonth() + 1)} `}${two(d.getHours())}:${two(d.getMinutes())}`;
};

type Tx = ReturnType<typeof useLang>['tx'];

/** The row's few words: its short key with the newest line's values; a run of units adds up. */
function words(g: Group, tx: Tx): string {
  const e = g.items[0];
  if (g.kind === 'unit' && g.items.length > 1) {
    const u = unitTotals(g.items);
    return tx('brain.short.units', undefined, { devices: u.devices, n: u.n, tokens: big(u.tokens) });
  }
  const s = shortKey(e.key);
  return s ? tx(s, undefined, e.vars) : tx(e.key, e.key, e.vars);
}
const sentence = (e: BrainEntry, tx: Tx) => tx(e.key, e.key, e.vars);

function Row({ g, first, last, open, onToggle }: { g: Group; first: boolean; last: boolean; open: boolean; onToggle: () => void }) {
  const { t, tx } = useLang();
  const color = TONE_COLOR[g.tone];
  const n = g.items.length;
  const label = [sentence(g.items[0], tx), n > 1 ? t('brain.a11y.more', { n: n - 1 }) : '', clock(g.at)].filter(Boolean).join('. ');
  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded: open }}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.railCol}>
        {first && last ? null : <View style={[styles.rail, first && styles.railFirst, last && styles.railLast]} />}
        <BrainGlyph kind={g.kind} color={color} />
      </View>
      <View style={styles.body}>
        <View style={styles.line}>
          <Text style={[styles.words, g.tone === 'bad' && { color }]} numberOfLines={1}>{words(g, tx)}</Text>
          {n > 1 ? <View style={[styles.count, { borderColor: color }]}><Text style={styles.countText}>×{n}</Text></View> : null}
          <Text style={styles.time}>{clock(g.at)}</Text>
        </View>
        {open ? (
          <View style={styles.open}>
            {g.items.slice(0, OPEN).map((e, i) => (
              <View key={`${e.at}-${i}`} style={styles.item}>
                <Text style={styles.sentence}>{sentence(e, tx)}</Text>
                {e.detail ? <Text style={styles.detail}>{e.detail}</Text> : null}
                {n > 1 ? <Text style={styles.itemTime}>{clock(e.at)}</Text> : null}
              </View>
            ))}
            {n > OPEN ? <Text style={styles.detail}>{t('brain.a11y.more', { n: n - OPEN })}</Text> : null}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

export default function Timeline({ groups }: { groups: Group[] }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const reduce = useReducedMotion();
  const toggle = (id: string) => {
    if (!reduce) LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  return (
    <View style={styles.list}>
      {groups.map((g, i) => (
        <Row key={g.id} g={g} first={i === 0} last={i === groups.length - 1} open={open.has(g.id)} onToggle={() => toggle(g.id)} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { marginTop: 4 },
  row: { flexDirection: 'row', gap: 12, minHeight: 44 },
  pressed: { opacity: 0.6 },
  railCol: { width: 26, alignItems: 'center', paddingTop: 9 },
  rail: { position: 'absolute', top: 0, bottom: 0, left: 12.5, width: 1, backgroundColor: colors.ink3 },
  railFirst: { top: 22 },
  railLast: { bottom: undefined, height: 22 },
  body: { flex: 1, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.ink3 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  words: { flex: 1, fontFamily: fonts.medium, fontSize: 14, color: colors.paper },
  count: { paddingHorizontal: 6, height: 18, borderRadius: radius.pill, borderWidth: 1, justifyContent: 'center' },
  countText: { fontFamily: fonts.jet, fontSize: 10, color: colors.paper2 },
  time: { fontFamily: fonts.jet, fontSize: 10.5, color: colors.meta },
  open: { marginTop: 8, gap: 8 },
  item: { gap: 2 },
  sentence: { fontFamily: fonts.regular, fontSize: 13.5, lineHeight: 19, color: colors.paper },
  detail: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 16, color: colors.mute },
  itemTime: { fontFamily: fonts.jet, fontSize: 10, color: colors.meta },
});
