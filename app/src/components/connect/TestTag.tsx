import { StyleSheet, Text, View } from 'react-native';
import InfoTip from '@/components/InfoTip';
import { useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';

// The mark on a test person (data/local/testPeople.ts): a small "test" pill; tapped, a bubble
// says what they are. plain: the pill alone, for places too small for a tap of its own.
export function TestTag({ plain }: { plain?: boolean }) {
  const { t } = useLang();
  const pill = (
    <View style={styles.pill}>
      <Text style={styles.text}>{t('social.test')}</Text>
    </View>
  );
  if (plain) return pill;
  return <InfoTip title={t('social.test.title')} text={t('social.test.tip')}>{pill}</InfoTip>;
}

const styles = StyleSheet.create({
  pill: { alignSelf: 'center', paddingHorizontal: 6, height: 15, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.mute, justifyContent: 'center' },
  text: { fontFamily: fonts.medium, fontSize: 9, letterSpacing: 0.8, color: colors.mute },
});
