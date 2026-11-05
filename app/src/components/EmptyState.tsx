import { Pressable, StyleSheet, Text, View } from 'react-native';
import { colors, fonts, radius } from '@/theme/tokens';

// An empty place that says what to do (5.11.2026): one sentence and, where there is one,
// the single button that moves things on. Quiet: a beige block, no illustration.
export default function EmptyState({ text, action, onAction, testID }: { text: string; action?: string; onAction?: () => void; testID?: string }) {
  return (
    <View style={styles.box} testID={testID} accessible accessibilityRole="summary">
      <Text style={styles.text}>{text}</Text>
      {action && onAction ? (
        <Pressable onPress={onAction} accessibilityRole="button" accessibilityLabel={action} style={({ pressed }) => [styles.btn, pressed && styles.pressed]}>
          <Text style={styles.btnText}>{action} ›</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginTop: 10, padding: 14, borderRadius: radius.md, backgroundColor: colors.ink2, gap: 10 },
  text: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.paper2 },
  btn: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: colors.paper },
  btnText: { fontFamily: fonts.medium, fontSize: 13.5, color: colors.ink },
  pressed: { opacity: 0.7 },
});
