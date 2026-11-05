import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import Avatar from '@/components/Avatar';
import { PeopleResults, PeopleSearch, SuggestedRow, openPerson } from '@/components/People';
import type { LiveFriend } from '@/data/contribution';
import { why } from '@/data/dms';
import { friendAccept, type FriendRow } from '@/data/friends';
import { useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';
import { connectStyles as s } from './styles';

// Connect's people: find someone, the requests waiting for you, your people as faces (the
// ones working a night now ringed), who to add. Moved here from the messages tab.
export default function YourPeople({ friends, live, onChanged }: { friends: FriendRow[]; live: LiveFriend[]; onChanged: () => void }) {
  const { t, up } = useLang();
  const [query, setQuery] = useState('');
  const [said, setSaid] = useState<string | null>(null);
  const accepted = friends.filter((f) => f.status === 'accepted');
  const requests = friends.filter((f) => f.status === 'pending' && f.direction === 'incoming');
  const liveOf = (handle: string | null) => live.find((l) => l.handle === handle);

  return (
    <>
      <View style={styles.search}><PeopleSearch value={query} onChange={setQuery} /></View>
      {query.trim() ? (
        <PeopleResults query={query} />
      ) : (
        <>
          {requests.length ? (
            <>
              <Text style={[s.section, s.sectionLive]}>{up(`${t('messages.requests')} · ${requests.length}`)}</Text>
              <View style={s.panel}>
                <View style={s.panelIn}>
                  {requests.map((f) => (
                    <View key={f.other_id} style={s.row}>
                      <Pressable onPress={() => f.handle && openPerson(f.handle)} style={styles.rowLeft} accessibilityRole="button">
                        <View style={s.face}><Avatar name={f.handle ?? f.display_name ?? '?'} size={36} /></View>
                        <View style={s.text}>
                          <Text style={s.name} numberOfLines={1}>{(f.display_name ?? f.handle ?? '').toLowerCase()}</Text>
                          <Text style={s.meta} numberOfLines={1}>@{f.handle}</Text>
                        </View>
                      </Pressable>
                      <Pressable onPress={() => friendAccept(f.other_id).then(onChanged, (e) => setSaid(why(e)))} style={({ pressed }) => [styles.accept, pressed && s.pressed]} accessibilityRole="button">
                        <Text style={styles.acceptText}>{t('people.accept')}</Text>
                      </Pressable>
                    </View>
                  ))}
                </View>
              </View>
            </>
          ) : null}
          <Text style={s.section}>{up(`${t('messages.yourPeople')} · ${accepted.length}`)}</Text>
          <View style={styles.grid}>
            {accepted.map((f) => {
              const out = liveOf(f.handle);
              return (
                <Pressable key={f.other_id} onPress={() => f.handle && openPerson(f.handle)} style={({ pressed }) => [styles.cell, pressed && s.pressed]} accessibilityRole="button">
                  <View style={[styles.bigFace, out && s.faceLive]}><Avatar name={f.handle ?? f.display_name ?? '?'} size={60} /></View>
                  <Text style={styles.cellName} numberOfLines={1}>{(f.display_name ?? f.handle ?? '').toLowerCase()}</Text>
                  <Text style={[styles.cellState, out && s.metaLive]} numberOfLines={1}>{out ? t('messages.outNow') : ' '}</Text>
                </Pressable>
              );
            })}
            <Pressable onPress={() => router.push('/friend/add')} style={({ pressed }) => [styles.cell, pressed && s.pressed]} accessibilityRole="button">
              <View style={[styles.bigFace, styles.faceAdd]}><Text style={styles.facePlus}>+</Text></View>
              <Text style={styles.cellName}>{t('connect.add')}</Text>
              <Text style={styles.cellState}> </Text>
            </Pressable>
          </View>
          {!accepted.length ? <Text style={s.note}>{t('messages.new.noFriends')}</Text> : null}
          <SuggestedRow />
        </>
      )}
      {said ? <Text style={[s.note, s.bad]}>{said}</Text> : null}
    </>
  );
}

const styles = StyleSheet.create({
  search: { marginTop: 14 },
  rowLeft: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  accept: { height: 30, paddingHorizontal: 12, borderRadius: radius.pill, backgroundColor: colors.paper, justifyContent: 'center' },
  acceptText: { fontFamily: fonts.medium, fontSize: 12, color: colors.ink },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 14, marginTop: 10 },
  cell: { width: '25%', alignItems: 'center', gap: 5 },
  bigFace: { width: 60, height: 60, borderRadius: 30, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.ink2 },
  faceAdd: { backgroundColor: 'transparent', borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.mute },
  facePlus: { fontFamily: fonts.medium, fontSize: 24, color: colors.mute },
  cellName: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.paper, maxWidth: 80 },
  cellState: { fontFamily: fonts.regular, fontSize: 10, color: colors.meta },
});
