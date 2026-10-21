import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import StaffPage, { Said } from '@/components/StaffPage';
import Button from '@/components/Button';
import Input from '@/components/Input';
import { friendRequest } from '@/data/friends';
import { refreshPeople } from '@/components/People';
import { serverText } from '@/lib/serverText';
import { useLang } from '@/i18n';
import type { Key } from '@/i18n/dict';
import { colors, fonts } from '@/theme/tokens';

// Add a friend by handle: one field, one button, the server's word back.
export default function AddFriendScreen() {
  const { t } = useLang();
  const [handle, setHandle] = useState('');
  const [said, setSaid] = useState<string | null>(null);
  const [bad, setBad] = useState(false);
  const send = async () => {
    const h = handle.trim().replace(/^@/, '').toLowerCase();
    if (!h) return;
    try {
      const r = await friendRequest(h);
      const key = `friend.result.${r}` as Key;
      setBad(r === 'notfound' || r === 'yourself');
      setSaid(t(key));
      if (r === 'sent' || r === 'accepted' || r === 'queued') {
        refreshPeople();
        setTimeout(() => router.back(), 900);
      }
    } catch (e) {
      setBad(true);
      setSaid(serverText(e));
    }
  };
  return (
    <StaffPage title={t('friend.add')}>
      <Text style={styles.note}>{t('friend.add.note')}</Text>
      <Input value={handle} onChangeText={setHandle} placeholder={t('friend.placeholder')} autoCapitalize="none" autoCorrect={false} autoFocus onSubmitEditing={send} returnKeyType="send" />
      <View style={styles.gap}><Button label={t('friend.send')} onPress={send} /></View>
      <Said text={said} bad={bad} />
    </StaffPage>
  );
}
const styles = StyleSheet.create({
  note: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.mute, marginBottom: 14 },
  gap: { marginTop: 14 },
});
