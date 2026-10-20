import { Pressable, StyleSheet } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useLang } from '@/i18n';
import { colors } from '@/theme/tokens';

// A round share mark for the bottom right corner of a photo.
export default function ShareButton({ onPress, style }: { onPress: () => void; style?: object }) {
  const { t } = useLang();
  return (
    <Pressable onPress={onPress} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('project.share')} style={({ pressed }) => [styles.btn, style, pressed && styles.pressed]}>
      <Svg width={18} height={18} viewBox="0 0 24 24">
        <Path d="M12 3v12M7.5 7.5 12 3l4.5 4.5M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" stroke={colors.paper} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      </Svg>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btn: { position: 'absolute', right: 12, bottom: 12, width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(14,13,12,0.72)', borderWidth: 1, borderColor: 'rgba(243,241,236,0.18)', alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.7 },
});
