import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import StaffPage, { Quiet } from '@/components/StaffPage';
import Avatar from '@/components/Avatar';
import { myBlocks, unblockUser, type Blocked } from '@/data/friends';
import { useLang } from '@/i18n';
import { colors, fonts } from '@/theme/tokens';

export default function BlocksScreen() {
  const { t } = useLang();
  const [rows, setRows] = useState<Blocked[]>([]);
  const load = () => myBlocks().then(setRows, () => {});
  useEffect(() => { load(); }, []);
  const undo = (b: Blocked) =>
    Alert.alert(t('block.undo.title'), t('block.undo.body'), [{ text: t('word.cancel'), style: 'cancel' }, { text: t('block.undo'), onPress: () => unblockUser(b.id).then(load, () => {}) }]);
  return (
    <StaffPage title={t('block.list')}>
      {!rows.length ? <Quiet text={t('block.none')} /> : null}
      {rows.map((b) => (
        <View key={b.id} style={styles.row}>
          <View style={styles.face}><Avatar name={b.handle ?? '?'} size={32} /></View>
          <Text style={styles.name}>{(b.display_name ?? b.handle ?? '').toLowerCase()}</Text>
          <Pressable onPress={() => undo(b)} hitSlop={8}><Text style={styles.undo}>{t('block.undo')}</Text></Pressable>
        </View>
      ))}
    </StaffPage>
  );
}
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.ink3 },
  face: { width: 32, height: 32, borderRadius: 16, overflow: 'hidden' },
  name: { flex: 1, fontFamily: fonts.medium, fontSize: 15, color: colors.paper },
  undo: { fontFamily: fonts.regular, fontSize: 13, color: colors.spotText, textDecorationLine: 'underline' },
});
