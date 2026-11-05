import { useEffect, type ReactNode } from 'react';
import { StyleSheet, Text, View, useWindowDimensions, type ScrollViewProps } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { router } from 'expo-router';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, Extrapolation, interpolate, runOnJS, useAnimatedScrollHandler, useAnimatedStyle, useSharedValue, withDelay, withSequence, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useT } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';

const go = () => (router.canGoBack() ? router.back() : router.replace('/'));

const CLOSE = 120;   // pulled this far down closes the page
const FLING = 900;   // or flung this fast

// DJ, night, friend and profile pages open like a card: at the top, pulling down makes
// the page follow the finger and closes it on release. A handle with a down chevron sits
// on top of the page's header; the page nudges down once on open so the gesture is
// discoverable, and while pulling a label says what letting go will do.
// When scrolled, the gesture scrolls; back at the top it pulls again.
// header: the page's top band, rendered inside the card so it moves with it and the
// handle can sit above it.
// closable=false (the five main tabs, 5.11.2026): a plain scroll with the header, no pull-to-close,
// no handle. A tab is not a card; pulling it down used to send the app to '/'.
export default function PullDownScroll({ children, style, header, closable = true, ...rest }: ScrollViewProps & { header?: ReactNode; closable?: boolean }) {
  if (!closable) {
    return (
      <View style={styles.wrap}>
        <Animated.ScrollView style={style} {...rest}>{children}</Animated.ScrollView>
        {header}
      </View>
    );
  }
  return <ClosableScroll style={style} header={header} {...rest}>{children}</ClosableScroll>;
}

function ClosableScroll({ children, style, header, ...rest }: ScrollViewProps & { header?: ReactNode }) {
  const t = useT();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const scrollY = useSharedValue(0);
  const drag = useSharedValue(0);
  const armed = useSharedValue(0);
  const base = useSharedValue(0);

  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      scrollY.set(e.contentOffset.y);
    },
  });

  const native = Gesture.Native();
  const pan = Gesture.Pan()
    .activeOffsetY(6)
    .failOffsetX([-14, 14])
    .simultaneousWithExternalGesture(native)
    .onUpdate((e) => {
      if (scrollY.value <= 1) {
        if (armed.value === 0) {
          armed.set(1);
          base.set(e.translationY);
        }
        drag.set(Math.max(0, (e.translationY - base.value) * 0.85));
      } else {
        armed.set(0);
        drag.set(0);
      }
    })
    .onEnd((e) => {
      const d = drag.value;
      armed.set(0);
      if (d > CLOSE || (d > 24 && e.velocityY > FLING)) {
        drag.set(withTiming(height, { duration: 220 }, () => runOnJS(go)()));
      } else {
        drag.set(withSpring(0, { damping: 18, stiffness: 180 }));
      }
    });

  // one small nudge after opening: down 18 px and back
  const nudge = useSharedValue(0);
  useEffect(() => {
    nudge.set(withDelay(450, withSequence(withTiming(18, { duration: 260, easing: Easing.out(Easing.quad) }), withSpring(0, { damping: 9, stiffness: 160 }))));
  }, [nudge]);

  const move = useAnimatedStyle(() => ({ transform: [{ translateY: drag.value + nudge.value }] }));
  const hint = useAnimatedStyle(() => ({
    opacity: interpolate(drag.value, [20, 70], [0, 1], Extrapolation.CLAMP),
    transform: [{ translateY: interpolate(drag.value, [0, CLOSE], [-6, 0], Extrapolation.CLAMP) }],
  }));
  const ready = useAnimatedStyle(() => ({
    backgroundColor: drag.value > CLOSE ? colors.spot : colors.paper,
    width: interpolate(drag.value, [0, CLOSE], [44, 64], Extrapolation.CLAMP),
  }));

  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.wrap, move]}>
        <GestureDetector gesture={native}>
          <Animated.ScrollView onScroll={onScroll} scrollEventThrottle={16} style={style} {...rest}>
            {children}
          </Animated.ScrollView>
        </GestureDetector>
        {header}
        {/* Handle: "pull down here". Turns red once letting go will close the page. */}
        <View style={[styles.handleWrap, { top: insets.top + 6 }]} pointerEvents="none">
          <Animated.View style={[styles.handle, ready]} />
          <Svg width={18} height={10} viewBox="0 0 18 10" style={styles.chevron}>
            <Path d="M2 2l7 6 7-6" stroke={colors.paper} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </Svg>
          <Animated.View style={[styles.hint, hint]}>
            <Text style={styles.hintText}>{t('pull.close')}</Text>
          </Animated.View>
        </View>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.ink },
  handleWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 30, elevation: 30 },
  handle: { height: 5, borderRadius: 3, backgroundColor: colors.paper },
  chevron: { marginTop: 4 },
  hint: { marginTop: 8, backgroundColor: colors.ink, borderRadius: radius.pill, paddingVertical: 4, paddingHorizontal: 12 },
  hintText: { fontFamily: fonts.medium, fontSize: 12, color: colors.paper },
});
