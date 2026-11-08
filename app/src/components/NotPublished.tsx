import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';

// A part of kula that is not out yet (8.11.2026: connect and the coops). The screen stays
// visible underneath, dimmed, and a note on top says it is not published; nothing under it can
// be pressed. Put it as the last child of a screen's root view (the root must fill the screen).
export default function NotPublished({ what }: { what?: string }) {
  const { tx } = useLang();
  return (
    <Pressable style={styles.cover} accessibilityRole="text" accessibilityLabel={tx('soon.title', 'not published yet')} onPress={() => {}}>
      <View style={styles.card}>
        <Text style={styles.title}>{tx('soon.title', 'not published yet')}</Text>
        <Text style={styles.body}>
          {what ?? tx('soon.body', 'this part of kula is not out yet. it comes in a later version; models, the brain, projects and your passport work now.')}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  cover: { ...StyleSheet.absoluteFill, zIndex: 50, backgroundColor: 'rgba(31,26,20,0.62)', alignItems: 'center', justifyContent: 'center', padding: 32 },
  card: { maxWidth: 340, borderRadius: radius.lg, paddingVertical: 22, paddingHorizontal: 22, backgroundColor: 'rgba(31,26,20,0.88)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.25)' },
  title: { fontFamily: fonts.semibold, fontSize: 20, color: colors.ink, textAlign: 'center' },
  body: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: 'rgba(255,255,255,0.78)', textAlign: 'center', marginTop: 8 },
});
