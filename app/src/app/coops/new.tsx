import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import StaffPage, { Field, Said } from '@/components/StaffPage';
import Button from '@/components/Button';
import Avatar from '@/components/Avatar';
import { COOP_COLORS, COOP_EMOJI, coopCreate, why, type CoopColor } from '@/data/coops';
import { friendsList, type FriendRow } from '@/data/friends';
import { invalidate } from '@/lib/offline';
import { isTestHandle } from '@/data/local/testPeople';
import { TestTag } from '@/components/connect/TestTag';
import { useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';

// A new coop: name, sign, colour, the friends in it from the start.
export default function NewCoopScreen() {
  const { t } = useLang();
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState(COOP_EMOJI[0]);
  const [color, setColor] = useState<CoopColor>('red');
  const [friends, setFriends] = useState<FriendRow[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [said, setSaid] = useState<string | null>(null);
  useEffect(() => { friendsList().then((f) => setFriends(f.filter((x) => x.status === 'accepted')), () => {}); }, []);
  const make = () =>
    coopCreate({ name: name.trim(), emoji, color }, friends.filter((f) => picked.includes(f.other_id)).map((f) => ({ id: f.other_id, handle: f.handle, name: f.display_name }))).then((id) => { invalidate('coops'); router.replace({ pathname: '/coops/[id]', params: { id } }); }, (e) => setSaid(why(e)));
  return (
    <StaffPage title={t('coops.new')}>
      <Field label={t('coops.f.name')} value={name} onChangeText={setName} placeholder={t('coops.f.name.placeholder')} maxLength={40} />
      <Text style={styles.label}>{t('coops.f.emoji')}</Text>
      <View style={styles.wrap}>
        {COOP_EMOJI.map((e) => (
          <Pressable key={e} onPress={() => setEmoji(e)} style={[styles.cell, e === emoji && styles.cellOn]}><Text style={styles.emoji}>{e}</Text></Pressable>
        ))}
      </View>
      <Text style={styles.label}>{t('coops.f.color')}</Text>
      <View style={styles.wrap}>
        {(Object.keys(COOP_COLORS) as CoopColor[]).map((c) => (
          <Pressable key={c} onPress={() => setColor(c)} style={[styles.swatch, { backgroundColor: COOP_COLORS[c] }, c === color && styles.swatchOn]} />
        ))}
      </View>
      <Text style={styles.label}>{t('coops.f.friends')}</Text>
      {!friends.length ? <Text style={styles.note}>{t('coops.f.friends.none')}</Text> : null}
      <View style={styles.wrap}>
        {friends.map((f) => {
          const on = picked.includes(f.other_id);
          return (
            <Pressable key={f.other_id} onPress={() => setPicked((p) => (on ? p.filter((x) => x !== f.other_id) : [...p, f.other_id]))} style={[styles.friend, on && styles.friendOn]}>
              <View style={styles.face}><Avatar name={f.handle ?? '?'} size={26} /></View>
              <Text style={[styles.friendText, on && styles.friendTextOn]}>{(f.display_name ?? f.handle ?? '').toLowerCase()}</Text>
              {isTestHandle(f.handle) ? <TestTag plain /> : null}
            </Pressable>
          );
        })}
      </View>
      <View style={styles.gap}><Button label={t('coops.f.make')} onPress={make} /></View>
      <Said text={said} bad />
    </StaffPage>
  );
}
const styles = StyleSheet.create({
  label: { fontFamily: fonts.regular, fontSize: 11, letterSpacing: 1.4, color: colors.mute, marginTop: 20, marginBottom: 10 },
  note: { fontFamily: fonts.regular, fontSize: 13, color: colors.mute },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: { width: 44, height: 44, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.ink3, alignItems: 'center', justifyContent: 'center' },
  cellOn: { borderColor: colors.paper, borderWidth: 2 },
  emoji: { fontSize: 22 },
  swatch: { width: 36, height: 36, borderRadius: 18 },
  swatchOn: { borderWidth: 3, borderColor: colors.paper },
  friend: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 12, paddingLeft: 4, height: 36, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.ink3 },
  friendOn: { backgroundColor: colors.paper, borderColor: colors.paper },
  face: { width: 26, height: 26, borderRadius: 13, overflow: 'hidden' },
  friendText: { fontFamily: fonts.medium, fontSize: 13, color: colors.paper },
  friendTextOn: { color: colors.ink },
  gap: { marginTop: 24 },
});
