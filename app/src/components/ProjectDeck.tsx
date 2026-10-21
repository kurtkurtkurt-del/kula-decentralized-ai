import { forwardRef, useCallback, useImperativeHandle, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useAppSize } from '@/hooks/useAppSize';
import { Image } from 'expo-image';
import { SvgUri } from 'react-native-svg';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Extrapolation, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';
import { router } from 'expo-router';
import Button from '@/components/Button';
import { posterUrl, type Project } from '@/data/deck';
import { useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';

const fallback = require('../../assets/intro/concert.jpg');
type Direction = 'left' | 'right';
export type DeckHandle = { undo: () => void; swipe: (direction: Direction) => void };
type Props = {
  projects: Project[];
  bottom: number; // bottom edge of the caption
  top: number;    // upper bound for the poster
  onSwipe: (p: Project, direction: Direction) => void;
  onUndo?: (p: Project) => void;
  onReset?: () => void;
};
const THRESHOLD = 110;
const VELOCITY = 800;
const PULL = 90;
type CardHandle = { promote: () => void; fly: (d: Direction) => void };

// A project as a card: the poster (the site's drawn SVG, or a photo) above an ink
// caption: red title, the org, model · nights · phones. Right keeps, left lets go,
// down opens the project page. Each card owns its position, so the card behind is at
// rest when the top one flies off.
const Card = forwardRef<CardHandle, { p: Project; active: boolean; bottom: number; top: number; onDone: (d: Direction) => void }>(function Card({ p, active, bottom, top, onDone }, ref) {
  const { width } = useAppSize();
  const { t, tn, up } = useLang();
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const shown = useSharedValue(active ? 1 : 0);
  const flyOff = useCallback((dir: Direction) => {
    x.set(withTiming(dir === 'right' ? width * 1.5 : -width * 1.5, { duration: 260 }, () => runOnJS(onDone)(dir)));
  }, [x, width, onDone]);
  useImperativeHandle(ref, () => ({ promote: () => shown.set(withTiming(1, { duration: 320 })), fly: flyOff }), [shown, flyOff]);
  const details = () => router.push(`/project/${p.slug}`);
  const pan = Gesture.Pan()
    .enabled(active)
    .onUpdate((e) => {
      x.set(e.translationX);
      y.set(e.translationY * 0.6);
    })
    .onEnd((e) => {
      const flung = Math.abs(e.velocityX) > VELOCITY;
      const sideways = Math.abs(e.translationX) > Math.abs(e.translationY);
      if (sideways && (Math.abs(x.get()) > THRESHOLD || flung)) {
        const dir: Direction = x.get() > 0 || (flung && e.velocityX > 0) ? 'right' : 'left';
        x.set(withTiming(dir === 'right' ? width * 1.5 : -width * 1.5, { duration: 260 }, () => runOnJS(onDone)(dir)));
        return;
      }
      if (!sideways && (e.translationY > PULL || e.velocityY > 900)) runOnJS(details)();
      x.set(withSpring(0, { damping: 18, stiffness: 180 }));
      y.set(withSpring(0, { damping: 18, stiffness: 180 }));
    });
  const style = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ translateX: x.value }, { translateY: y.value }, { rotate: `${interpolate(x.value, [-width, 0, width], [-10, 0, 10])}deg` }, { scale: 0.97 + 0.03 * shown.value }],
  }));
  const keepEdge = useAnimatedStyle(() => ({ opacity: interpolate(x.value, [width * 0.15, width * 0.4], [0, 1], Extrapolation.CLAMP) }));
  const letGoEdge = useAnimatedStyle(() => ({ opacity: interpolate(x.value, [-width * 0.4, -width * 0.15], [1, 0], Extrapolation.CLAMP) }));
  const [broken, setBroken] = useState(false);
  const poster = p.image_url || broken ? null : posterUrl(p);
  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[styles.slot, style]}>
        {/* the poster, fitted between the pickers and the caption */}
        <View style={[styles.posterArea, { top, bottom: bottom + 150 }]}>
          <View style={styles.poster}>
            {p.image_url ? <Image source={{ uri: p.image_url }} style={styles.fill} contentFit="cover" /> : poster ? <SvgUri uri={poster} width="100%" height="100%" onError={() => setBroken(true)} /> : <Image source={fallback} style={styles.fill} contentFit="cover" />}
            <View style={styles.tag}><Text style={styles.tagText}>{p.model}</Text></View>
            <View style={styles.tagRight}><Text style={styles.tagText}>{up(p.country ?? '')}{p.city_name ? ` · ${up(p.city_name)}` : ''}</Text></View>
          </View>
        </View>
        <View style={[styles.caption, { bottom }]}>
          <Pressable style={styles.stripLeft} onPress={details} accessibilityRole="button" accessibilityLabel={t('word.details')}>
            <Text style={styles.stripLeftText}>{up(t('word.details'))} ↓</Text>
          </Pressable>
          <Pressable style={styles.block} onPress={details}>
            <Text style={styles.title} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.7}>{p.title.toLowerCase()}</Text>
            <Text style={styles.org} numberOfLines={1}>{p.org.toLowerCase()}</Text>
            <Text style={styles.meta} numberOfLines={1}>{`${tn('deck.nights', p.nights_wanted)} · ${tn('deck.phones', p.phones_wanted)} · ${p.est_kwh} kwh`}</Text>
          </Pressable>
          <Pressable style={({ pressed }) => [styles.strip, pressed && styles.pressed]} onPress={() => flyOff('right')} accessibilityRole="button" accessibilityLabel={t('word.keep')}>
            <Text style={styles.stripText}>{up(t('word.keep'))}</Text>
          </Pressable>
        </View>
        {active ? (
          <>
            <Animated.View pointerEvents="none" style={[styles.edgeRight, keepEdge]} />
            <Animated.View pointerEvents="none" style={[styles.edgeLeft, letGoEdge]}>
              <Text style={styles.letGo}>{up(t('word.letgo'))}</Text>
            </Animated.View>
          </>
        ) : null}
      </Animated.View>
    </GestureDetector>
  );
});

const ProjectDeck = forwardRef<DeckHandle, Props>(function ProjectDeck({ projects, bottom, top, onSwipe, onUndo, onReset }, ref) {
  const { t, up } = useLang();
  const [i, setI] = useState(0);
  const nextRef = useRef<CardHandle>(null);
  const topRef = useRef<CardHandle>(null);
  const cur = projects[i];
  const next = projects[i + 1];
  const done = useCallback((direction: Direction) => {
    if (cur) onSwipe(cur, direction);
    nextRef.current?.promote();
    setI((n) => n + 1);
  }, [cur, onSwipe]);
  useImperativeHandle(ref, () => ({
    undo: () => {
      if (i === 0) return;
      const prev = projects[i - 1];
      setI(i - 1);
      if (prev && onUndo) onUndo(prev);
    },
    swipe: (d) => topRef.current?.fly(d),
  }), [i, projects, onUndo]);
  if (!cur) {
    return (
      <View style={[styles.empty, { paddingBottom: bottom }]}>
        <Text style={styles.emptyText}>{t('deck.empty')}</Text>
        <Text style={styles.emptyMono}>{up(projects.length ? t('deck.seenAll') : t('deck.nothing'))}</Text>
        {onReset && projects.length > 0 ? (
          <View style={styles.resetBtn}>
            <Button label={t('deck.startOver')} kind="line" onPress={onReset} />
          </View>
        ) : null}
      </View>
    );
  }
  return (
    <View style={styles.stage}>
      {next ? <Card ref={nextRef} key={next.id} p={next} active={false} bottom={bottom} top={top} onDone={done} /> : null}
      <Card ref={topRef} key={cur.id} p={cur} active bottom={bottom} top={top} onDone={done} />
    </View>
  );
});
export default ProjectDeck;

const styles = StyleSheet.create({
  stage: { flex: 1 },
  slot: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: colors.ink, overflow: 'hidden', borderRadius: radius.lg },
  fill: { width: '100%', height: '100%' },
  posterArea: { position: 'absolute', left: 12, right: 12, alignItems: 'center', justifyContent: 'center' },
  poster: { width: '100%', aspectRatio: 2 / 3, maxHeight: '100%', borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.ink2 },
  tag: { position: 'absolute', top: 10, left: 10, backgroundColor: colors.ink, borderRadius: radius.sm, paddingVertical: 6, paddingHorizontal: 9 },
  tagRight: { position: 'absolute', top: 10, right: 10, backgroundColor: colors.ink, borderRadius: radius.sm, paddingVertical: 6, paddingHorizontal: 9 },
  tagText: { fontFamily: fonts.jet, fontSize: 9.5, letterSpacing: 1.2, color: colors.paper },
  caption: { position: 'absolute', left: 8, right: 8, flexDirection: 'row', alignItems: 'stretch', borderRadius: radius.lg, overflow: 'hidden' },
  block: { flex: 1, minHeight: 124, backgroundColor: colors.ink, paddingHorizontal: 14, paddingTop: 14, paddingBottom: 13, gap: 3, justifyContent: 'center' },
  title: { fontFamily: fonts.logo, fontSize: 32, lineHeight: 31, letterSpacing: -0.8, color: colors.spotText, marginBottom: 4 },
  org: { fontFamily: fonts.medium, fontSize: 14, letterSpacing: -0.2, color: colors.paper },
  meta: { fontFamily: fonts.jet, fontSize: 9.5, letterSpacing: 1, color: colors.mute, marginTop: 4 },
  strip: { width: 56, backgroundColor: colors.spot, alignItems: 'center', justifyContent: 'center' },
  stripText: { fontFamily: fonts.jet, fontSize: 11, letterSpacing: 2, color: colors.ink, transform: [{ rotate: '-90deg' }], width: 120, textAlign: 'center' },
  stripLeft: { width: 44, backgroundColor: colors.ink, borderRightWidth: 1, borderRightColor: colors.ink3, alignItems: 'center', justifyContent: 'center' },
  stripLeftText: { fontFamily: fonts.jet, fontSize: 10, letterSpacing: 2, color: colors.paper, transform: [{ rotate: '-90deg' }], width: 120, textAlign: 'center' },
  edgeRight: { position: 'absolute', top: 0, right: 0, bottom: 0, width: 56, backgroundColor: colors.spot },
  edgeLeft: { position: 'absolute', top: 0, left: 0, bottom: 0, width: 56, borderRightWidth: 1.5, borderRightColor: colors.paper, alignItems: 'center', justifyContent: 'center' },
  letGo: { fontFamily: fonts.jet, fontSize: 11, letterSpacing: 2, color: colors.paper, transform: [{ rotate: '-90deg' }], width: 120, textAlign: 'center' },
  pressed: { opacity: 0.75 },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6 },
  resetBtn: { marginTop: 18, alignSelf: 'stretch', paddingHorizontal: 40 },
  emptyText: { fontFamily: fonts.medium, fontSize: 22, letterSpacing: -0.5, color: colors.paper },
  emptyMono: { fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1.6, color: colors.mute },
});
