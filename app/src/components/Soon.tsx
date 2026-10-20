import { StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { colors, fonts } from '@/theme/tokens';
import { brand } from '@/theme/layout';

// A tab that is not built yet: its name and one line. Replaced screen by screen.
export default function Soon({ title, line }: { title: string; line: string }) {
  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.line}>{line}</Text>
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink, paddingTop: brand.top, paddingHorizontal: brand.left },
  title: { fontFamily: fonts.semibold, fontSize: 30, letterSpacing: -0.9, color: colors.paper },
  line: { fontFamily: fonts.regular, fontSize: 14, color: colors.mute, marginTop: 10 },
});
