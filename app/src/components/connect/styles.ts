import { StyleSheet } from 'react-native';
import { colors, fonts, radius } from '@/theme/tokens';

// The rows, faces and notes connect's parts share (people, messages, circles).
export const connectStyles = StyleSheet.create({
  note: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.mute, marginTop: 12 },
  bad: { color: colors.spotText },
  section: { fontFamily: fonts.regular, fontSize: 11, letterSpacing: 1.4, color: colors.mute, marginTop: 24 },
  sectionLive: { color: colors.spotText },
  panel: { borderWidth: 1, borderColor: colors.ink3, borderRadius: radius.md, overflow: 'hidden', marginTop: 8 },
  panelIn: { marginBottom: -1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: colors.ink3 },
  pressed: { opacity: 0.6 },
  face: { width: 36, height: 36, borderRadius: 18, overflow: 'hidden', backgroundColor: colors.ink2 },
  faceLive: { borderWidth: 2, borderColor: colors.spot },
  text: { flex: 1, gap: 3 },
  name: { fontFamily: fonts.medium, fontSize: 16, letterSpacing: -0.2, color: colors.paper },
  meta: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.meta },
  metaLive: { color: colors.spotText },
});
