import { useEffect } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { colors, fonts, intro, night } from '@/theme/tokens';
import { brand } from '@/theme/layout';
import Backdrop from '@/components/Backdrop';

type Props = { onDone: () => void };

// The dark opens onto kula's night (phones on charge, joined into one network) and the
// name appears in the sky above them.
export default function Intro({ onDone }: Props) {
  const photo = useSharedValue(0);
  const word = useSharedValue(0);

  useEffect(() => {
    photo.set(withDelay(intro.hold, withTiming(1, { duration: intro.photoIn })));
    word.set(withDelay(intro.wordDelay, withTiming(1, { duration: intro.word })));
    const leave = setTimeout(onDone, intro.leaveAt);
    return () => clearTimeout(leave);
  }, [photo, word, onDone]);

  const photoStyle = useAnimatedStyle(() => ({ opacity: photo.value }));
  const wordStyle = useAnimatedStyle(() => ({ opacity: word.value }));

  return (
    <Pressable style={styles.root} onPress={onDone}>
      <StatusBar style="light" />
      <Animated.View style={[StyleSheet.absoluteFill, photoStyle]}>
        <Backdrop />
      </Animated.View>
      <Animated.Text style={[styles.word, wordStyle]}>
        kula<Text style={styles.dot}>.</Text>
      </Animated.Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: night.sky0, alignItems: 'center', justifyContent: 'center' },
  word: { fontFamily: fonts.logo, fontSize: brand.logoBig, letterSpacing: -0.5, color: colors.ink, marginBottom: '28%' },
  dot: { color: colors.spot },
});
