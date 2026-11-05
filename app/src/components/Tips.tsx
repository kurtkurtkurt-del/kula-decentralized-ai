import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, FadeIn, FadeOut, SlideInDown, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import Storage from 'expo-sqlite/kv-store';
import { Image } from 'expo-image';
import { useLang, type Key } from '@/i18n';
import { colors, fonts, radius, tint } from '@/theme/tokens';

// First visit to a page: one short tip over the page (since 12.10.2026 a single one;
// two pages were too many), then never again on that page. Settings → about →
// "show the tips again" clears them all (resetTips).
// motion: swipe (a small card going right, then left), tap (a ring that pulses).

export type Tip = { title: Key; body: Key; motion?: 'swipe' | 'tap' };
export const TIP_PAGES = ['models', 'people', 'network', 'passport', 'panel', 'project', 'call', 'coop'] as const;
type Page = (typeof TIP_PAGES)[number];

const key = (page: Page) => `tip.${page}`;
const seen = (page: Page) => {
  try {
    return Storage.getItemSync(key(page)) === '1';
  } catch {
    return false;
  }
};
export function resetTips() {
  for (const p of TIP_PAGES) {
    try {
      Storage.removeItemSync(key(p));
    } catch {}
  }
}

// The title in the app's big letters: the last word red, with the dot of the logo.
function BigTitle({ text }: { text: string }) {
  const words = text.split(' ');
  const last = words.pop();
  return (
    <Text style={styles.big}>
      {words.length ? `${words.join(' ')}\n` : ''}
      <Text style={styles.bigRed}>{last}.</Text>
    </Text>
  );
}

// bottom is kept for the callers; the full-screen demo (1D) does not need it.
export default function Tips({ page, tip }: { page: Page; tip: Tip; bottom?: number }) {
  const { t } = useLang();
  const [on, setOn] = useState(false);
  // A short wait, so the page is there before the demo comes.
  useEffect(() => {
    if (seen(page)) return;
    const id = setTimeout(() => setOn(true), 900);
    return () => clearTimeout(id);
  }, [page]);
  if (!on) return null;
  const close = () => {
    try {
      Storage.setItemSync(key(page), '1');
    } catch {}
    setOn(false);
  };
  return (
    <Animated.View entering={FadeIn.duration(260)} exiting={FadeOut.duration(220)} style={styles.screen}>
      <Animated.View entering={SlideInDown.duration(380).easing(Easing.out(Easing.cubic))} style={styles.middle}>
        <Motion kind={tip.motion ?? 'tap'} />
        <BigTitle text={t(tip.title)} />
        <Text style={styles.body}>{t(tip.body)}</Text>
      </Animated.View>
      <View style={styles.foot}>
        <Pressable onPress={close} accessibilityRole="button" style={({ pressed }) => [styles.next, pressed && styles.pressed]}>
          <Text style={styles.nextText}>{t('tips.done')}</Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}

function Motion({ kind }: { kind: 'swipe' | 'tap' }) {
  const v = useSharedValue(0);
  useEffect(() => {
    v.set(
      kind === 'swipe'
        ? withRepeat(withSequence(withDelay(300, withTiming(1, { duration: 520 })), withTiming(0, { duration: 380 }), withDelay(200, withTiming(-1, { duration: 520 })), withTiming(0, { duration: 380 })), -1)
        : withRepeat(withSequence(withTiming(1, { duration: 900, easing: Easing.out(Easing.cubic) }), withTiming(0, { duration: 0 })), -1),
    );
  }, [kind, v]);
  const card = useAnimatedStyle(() => ({ transform: [{ translateX: v.value * 34 }, { rotate: `${v.value * 12}deg` }] }));
  const keep = useAnimatedStyle(() => ({ opacity: Math.max(0, v.value) }));
  const drop = useAnimatedStyle(() => ({ opacity: Math.max(0, -v.value) }));
  const ring = useAnimatedStyle(() => ({ opacity: 1 - v.value, transform: [{ scale: 0.6 + v.value * 0.9 }] }));
  if (kind === 'swipe') {
    return (
      <View style={styles.motion}>
        <Animated.View style={[styles.mini, card]}>
          <Image source={require('../../assets/intro/concert.jpg')} style={StyleSheet.absoluteFill} contentFit="cover" />
          <Animated.View style={[styles.miniTint, styles.miniKeep, keep]} />
          <Animated.View style={[styles.miniTint, styles.miniDrop, drop]} />
        </Animated.View>
      </View>
    );
  }
  return (
    <View style={styles.motion}>
      <Animated.View style={[styles.ring, ring]} />
      <View style={styles.finger} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 50, backgroundColor: 'rgba(255,255,255,0.9)', justifyContent: 'center', paddingHorizontal: 28 },
  middle: { alignItems: 'center' },
  big: { fontFamily: fonts.logo, fontSize: 46, lineHeight: 44, letterSpacing: -0.5, color: colors.paper, textAlign: 'center', marginTop: 28 },
  bigRed: { color: colors.spotText },
  body: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 21, color: colors.mute, textAlign: 'center', marginTop: 14, maxWidth: 300 },
  foot: { position: 'absolute', left: 28, right: 28, bottom: 56, alignItems: 'center', gap: 16 },
  next: { alignSelf: 'stretch', height: 50, borderRadius: radius.pill, backgroundColor: colors.paper, alignItems: 'center', justifyContent: 'center' },
  nextText: { fontFamily: fonts.medium, fontSize: 16, color: colors.ink },
  pressed: { opacity: 0.6 },
  motion: { width: 150, height: 200, alignItems: 'center', justifyContent: 'center' },
  mini: { width: 120, height: 170, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.ink3, shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 18, shadowOffset: { width: 0, height: 10 }, elevation: 10 },
  miniTint: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  miniKeep: { backgroundColor: tint(0.55) },
  miniDrop: { backgroundColor: 'rgba(31,26,20,0.3)' },
  ring: { position: 'absolute', width: 96, height: 96, borderRadius: 48, borderWidth: 2.5, borderColor: colors.spot },
  finger: { width: 26, height: 26, borderRadius: 13, backgroundColor: colors.paper },
});
