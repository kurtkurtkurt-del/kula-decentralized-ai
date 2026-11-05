import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useLang } from '@/i18n';
import { ladder, STEPS, stepRoute, type StepFacts } from '@/llm/steps';
import { saveUxFlags } from '@/llm/store';
import { tapSelect } from '@/lib/haptics';
import { colors, fonts, radius } from '@/theme/tokens';

// The first-run ladder on top of the models tab (5.11.2026): four rungs, the one you are on
// lit, one sentence on why, one button to the next thing. Any rung can be tapped. Once all
// four are done the bar says so once and never comes back ("hide" does the same early).
export default function StepBar({ facts, firstModelId }: { facts: StepFacts; firstModelId: string | null }) {
  const { t, up } = useLang();
  const l = ladder(facts);
  const hide = () => saveUxFlags({ stepsDone: true });
  const go = (s: (typeof STEPS)[number]) => {
    tapSelect();
    router.push(stepRoute(s, firstModelId) as never);
  };
  return (
    <View style={styles.box} testID="step-bar">
      <View style={styles.top}>
        <Text style={styles.kicker}>{up(l.allDone ? t('steps.allDone') : t('steps.of', { n: l.index + 1, all: STEPS.length }))}</Text>
        <Pressable onPress={hide} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('steps.hide')} style={styles.hide}>
          <Text style={styles.hideText}>{t('steps.hide')}</Text>
        </Pressable>
      </View>
      <View style={styles.rungs} accessibilityRole="tablist">
        {STEPS.map((s, i) => {
          const done = l.done.includes(s);
          const now = l.current === s;
          const state = done ? t('a11y.done') : now ? t('a11y.current') : t('a11y.todo');
          return (
            <Pressable key={s} onPress={() => go(s)} accessibilityRole="tab" accessibilityState={{ selected: now }} accessibilityLabel={t('a11y.step', { name: t(`steps.${s}`), state })} style={({ pressed }) => [styles.rung, pressed && styles.pressed]}>
              <View style={[styles.dot, done && styles.dotDone, now && styles.dotNow]}>
                <Text style={[styles.dotText, (done || now) && styles.dotTextOn]}>{done ? '✓' : i + 1}</Text>
              </View>
              <Text style={[styles.rungText, now && styles.rungNow]} numberOfLines={1}>{t(`steps.${s}`)}</Text>
              {i < STEPS.length - 1 ? <Text style={styles.arrow}>→</Text> : null}
            </Pressable>
          );
        })}
      </View>
      {l.current ? (
        <>
          <Text style={styles.why}>{t(`steps.${l.current}.why`)}</Text>
          <Pressable onPress={() => go(l.current!)} accessibilityRole="button" accessibilityLabel={t(`steps.${l.current}.go`)} style={({ pressed }) => [styles.go, pressed && styles.pressed]}>
            <Text style={styles.goText}>{t(`steps.${l.current}.go`)} ›</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginTop: 14, padding: 14, borderRadius: radius.md, backgroundColor: colors.ink2, gap: 10 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  kicker: { fontFamily: fonts.regular, fontSize: 10, letterSpacing: 1.4, color: colors.spotText, flexShrink: 1 },
  hide: { minHeight: 32, justifyContent: 'center' },
  hideText: { fontFamily: fonts.regular, fontSize: 12, color: colors.meta },
  rungs: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', rowGap: 6 },
  rung: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 44, paddingRight: 4 },
  dot: { width: 22, height: 22, borderRadius: 11, borderWidth: 1, borderColor: colors.mute, alignItems: 'center', justifyContent: 'center' },
  dotDone: { backgroundColor: colors.paper, borderColor: colors.paper },
  dotNow: { backgroundColor: colors.spot, borderColor: colors.spot },
  dotText: { fontFamily: fonts.medium, fontSize: 11, color: colors.mute },
  dotTextOn: { color: colors.ink },
  rungText: { fontFamily: fonts.medium, fontSize: 13, color: colors.mute },
  rungNow: { color: colors.paper },
  arrow: { fontFamily: fonts.regular, fontSize: 12, color: colors.meta, marginLeft: 4 },
  why: { fontFamily: fonts.regular, fontSize: 13.5, lineHeight: 19, color: colors.paper2 },
  go: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: colors.paper },
  goText: { fontFamily: fonts.medium, fontSize: 13.5, color: colors.ink },
  pressed: { opacity: 0.7 },
});
