import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { BranchId, EyeBranchView, EyeCard, EyeView } from '@godseye/core';
import { useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';

// god's eye on the brain tab (11.11.2026, src/eye/): the twelve as a small map, three across,
// each tile its number, its name, the branch's own few words and its gauge; a tap opens its page.
// Under it the cards the branches say, most important first, each with the phone's way to carry
// it out (or none) and a dismiss. The drawing is quiet: dark when a branch is not built, the
// terracotta when it stopped or warns, the accent when it has something to suggest.

export type TileTone = 'dark' | 'ok' | 'warn' | 'broken';

export function toneOf(b: EyeBranchView, cards: EyeCard[]): TileTone {
  if (b.error) return 'broken';
  if (!b.built) return 'dark';
  if (cards.some((c) => c.branch === b.id && c.kind === 'warn')) return 'warn';
  return 'ok';
}

const TONE: Record<TileTone, string> = { dark: colors.meta, ok: colors.spot, warn: colors.violet, broken: colors.violet };

export function EyeGrid({ view, onOpen }: { view: EyeView | null; onOpen: (id: BranchId) => void }) {
  const { t, tx } = useLang();
  if (!view) return <Text style={styles.waiting}>{t('eye.waiting')}</Text>;
  return (
    <View style={styles.grid}>
      {view.branches.map((b) => {
        const tone = toneOf(b, view.cards);
        const name = tx(`eye.branch.${b.id}`, b.name);
        const stat = b.error ? t('eye.broken', { why: b.error }) : b.built ? b.stat : t('eye.dark');
        const gauge = typeof b.gauge === 'number' && Number.isFinite(b.gauge) ? Math.max(0, Math.min(100, b.gauge)) : null;
        return (
          <Pressable
            key={b.id}
            onPress={() => onOpen(b.id)}
            accessibilityRole="button"
            accessibilityLabel={t('eye.a11y.tile', { n: b.n, name, stat })}
            style={({ pressed }) => [styles.tile, tone === 'warn' && styles.tileWarn, pressed && styles.pressed]}
          >
            <View style={styles.tileTop}>
              <Text style={styles.n}>{b.n}</Text>
              <View style={[styles.dot, { backgroundColor: TONE[tone] }, tone === 'dark' && styles.dotDark]} />
            </View>
            <Text style={[styles.name, !b.built && styles.dim]} numberOfLines={2}>{name}</Text>
            <Text style={styles.stat} numberOfLines={2}>{stat}</Text>
            <View style={styles.track}>
              {gauge != null ? <View style={[styles.fill, { width: `${gauge}%`, backgroundColor: TONE[tone] }]} /> : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

export type CardState = { busy?: boolean; said?: string; failed?: boolean };

/** What a tap did, in the phone's own words ('looked again: 1 answered…'); nothing, or only 'opened', says done. */
export function sayWord(w: unknown, done: string): string {
  const s = typeof w === 'string' ? w.trim().slice(0, 120) : '';
  return s && s !== 'opened' ? s : done;
}

/** One card: what the branch says, and what the phone can do about it. */
export function EyeCardView({ card, act, state, onApply, onDismiss }: {
  card: EyeCard;
  act: { kind: string } | null;
  state?: CardState;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const { t, tx } = useLang();
  const warn = card.kind === 'warn';
  const branch = tx(`eye.branch.${card.branch}`, card.branch);
  return (
    <View style={[styles.card, warn && styles.cardWarn]} accessible={false}>
      <Text style={[styles.kind, { color: warn ? colors.violet : colors.spotText }]}>
        {t(warn ? 'eye.card.warn' : 'eye.card.suggest')} · {t('eye.card.from', { branch })}
      </Text>
      <Text style={styles.title}>{card.title}</Text>
      <Text style={styles.why}>{card.why}</Text>
      {state?.said ? <Text style={[styles.said, state.failed && { color: colors.violet }]} accessibilityLiveRegion="polite">{state.said}</Text> : null}
      <View style={styles.buttons}>
        {act ? (
          <Pressable onPress={onApply} disabled={!!state?.busy} accessibilityRole="button" hitSlop={6} style={({ pressed }) => [styles.apply, (pressed || state?.busy) && styles.pressed]}>
            <Text style={styles.applyText}>{tx(`eye.apply.${act.kind}`, act.kind)}</Text>
          </Pressable>
        ) : card.action ? (
          <Text style={styles.notHere}>{t('eye.card.notHere')}</Text>
        ) : null}
        <Pressable onPress={onDismiss} accessibilityRole="button" hitSlop={8} style={styles.dismiss}>
          <Text style={styles.dismissText}>{t('eye.card.dismiss')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** The cards with their state while a tap is carried out. */
export function EyeCards({ cards, actOf, apply, dismiss }: {
  cards: EyeCard[];
  actOf: (c: EyeCard) => { kind: string } | null;
  apply: (id: string, shown: EyeCard['action']) => Promise<string>;
  dismiss: (id: string) => void;
}) {
  const { t, tx } = useLang();
  const [states, setStates] = useState<Record<string, CardState>>({});
  const set = (id: string, s: CardState) => setStates((x) => ({ ...x, [id]: s }));
  return (
    <View style={styles.cards}>
      {cards.map((c) => (
        <EyeCardView
          key={c.id}
          card={c}
          act={actOf(c)}
          state={states[c.id]}
          onApply={() => {
            set(c.id, { busy: true });
            // the action this card showed: if the card says another by now, nothing runs ('changed')
            apply(c.id, c.action).then(
              (word) => set(c.id, { said: sayWord(word, t('eye.card.done')) }),
              (e: Error) => set(c.id, e?.message === 'changed'
                ? { said: tx('eye.card.changed', 'the card changed, look again'), failed: true }
                : { said: t('eye.card.failed', { why: e?.message || '?' }), failed: true }),
            );
          }}
          onDismiss={() => dismiss(c.id)}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  waiting: { fontFamily: fonts.regular, fontSize: 13, color: colors.mute, paddingVertical: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  tile: { width: '32%', flexGrow: 1, minHeight: 92, padding: 9, borderRadius: radius.sm, backgroundColor: colors.ink2, borderWidth: 1, borderColor: 'transparent' },
  tileWarn: { borderColor: colors.violet },
  tileTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  n: { fontFamily: fonts.regular, fontSize: 10.5, letterSpacing: 0.6, color: colors.meta },
  dot: { width: 7, height: 7, borderRadius: 4 },
  dotDark: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.meta },
  name: { fontFamily: fonts.semibold, fontSize: 12.5, lineHeight: 15, color: colors.paper, marginTop: 4 },
  dim: { color: colors.mute },
  stat: { fontFamily: fonts.regular, fontSize: 11, lineHeight: 14, color: colors.mute, marginTop: 2, flexGrow: 1 },
  track: { height: 3, borderRadius: 2, backgroundColor: colors.ink3, marginTop: 6, overflow: 'hidden' },
  fill: { height: 3, borderRadius: 2 },
  pressed: { opacity: 0.7 },
  cards: { gap: 8, marginTop: 4 },
  card: { padding: 14, borderRadius: radius.md, backgroundColor: colors.ink2, gap: 4, borderLeftWidth: 3, borderLeftColor: colors.spot },
  cardWarn: { borderLeftColor: colors.violet },
  kind: { fontFamily: fonts.regular, fontSize: 11, letterSpacing: 0.4 },
  title: { fontFamily: fonts.semibold, fontSize: 15, lineHeight: 19, color: colors.paper },
  why: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, color: colors.paper2 },
  said: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.spotText },
  buttons: { flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 6 },
  apply: { paddingHorizontal: 14, height: 32, borderRadius: radius.pill, backgroundColor: colors.spot, justifyContent: 'center' },
  applyText: { fontFamily: fonts.semibold, fontSize: 13, color: colors.ink },
  notHere: { flex: 1, fontFamily: fonts.regular, fontSize: 12, color: colors.mute },
  dismiss: { paddingVertical: 6 },
  dismissText: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.mute },
});
