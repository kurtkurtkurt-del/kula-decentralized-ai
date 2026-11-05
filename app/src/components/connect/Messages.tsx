import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Input from '@/components/Input';
import Avatar from '@/components/Avatar';
import type { LiveFriend } from '@/data/contribution';
import { dmStart, why, type DmThread } from '@/data/dms';
import type { FriendRow } from '@/data/friends';
import { upperData, useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';
import { brand } from '@/theme/layout';
import { isTestHandle } from '@/data/local/testPeople';
import { connectStyles as s } from './styles';
import { TestTag } from './TestTag';

// Connect's messages (5.11.2026; it was its own tab): your conversations, the friends
// working a night right now first with a ring, a new message to one of your people.
export default function Messages({ dms, live, friends }: { dms: DmThread[] | null; live: LiveFriend[]; friends: FriendRow[] }) {
  const insets = useSafeAreaInsets();
  const { t, up } = useLang();
  const [picking, setPicking] = useState(false);
  const [who, setWho] = useState('');
  const [said, setSaid] = useState<string | null>(null);

  const accepted = friends.filter((f) => f.status === 'accepted');
  const q = who.trim().toLowerCase().replace(/^@/, '');
  const shownFriends = accepted.filter((f) => !q || (f.handle ?? '').includes(q) || (f.display_name ?? '').toLowerCase().includes(q));
  const liveOf = (handle: string | null) => live.find((l) => l.handle === handle);
  const threads = [...(dms ?? [])].sort((a, b) => Number(!!liveOf(b.handle)) - Number(!!liveOf(a.handle)) || b.last_at.localeCompare(a.last_at));
  const pick = (f: FriendRow) => {
    if (!f.handle) return;
    setSaid(null);
    dmStart(f.handle)
      .then((id) => {
        setPicking(false);
        setWho('');
        router.push({ pathname: '/dm/[id]', params: { id, name: (f.display_name ?? f.handle ?? '').toLowerCase() } });
      })
      .catch((e) => setSaid(why(e)));
  };

  return (
    <>
      <Pressable onPress={() => (setPicking(true), setWho(''))} accessibilityRole="button" style={({ pressed }) => [styles.newRow, pressed && s.pressed]}>
        <View style={styles.newMark}><Text style={styles.newPlus}>+</Text></View>
        <Text style={styles.newText}>{t('messages.new')}</Text>
      </Pressable>
      {dms === null ? <Text style={s.note}>{t('messages.loading')}</Text> : null}
      {dms && !dms.length ? <Text style={s.note}>{t('messages.none')}</Text> : null}
      {threads.length ? (
        <View style={s.panel}>
          <View style={s.panelIn}>
            {threads.map((d) => {
              const out = liveOf(d.handle);
              return (
                <Pressable key={d.id} onPress={() => router.push({ pathname: '/dm/[id]', params: { id: d.id, name: (d.name ?? d.handle ?? '').toLowerCase() } })} accessibilityRole="button" style={({ pressed }) => [s.row, pressed && s.pressed]}>
                  <View style={[s.face, out && s.faceLive]}><Avatar name={d.handle ?? d.name ?? '?'} size={36} /></View>
                  <View style={s.text}>
                    <View style={styles.nameRow}>
                      <Text style={[s.name, styles.shrink]} numberOfLines={1}>{(d.name ?? d.handle ?? '').toLowerCase()}</Text>
                      {isTestHandle(d.handle) ? <TestTag plain /> : null}
                    </View>
                    <Text style={[s.meta, out && s.metaLive]} numberOfLines={1}>
                      {out ? `${up(t('messages.outNow'))} · ${upperData(out.title)}` : d.last_body ? `${d.last_mine ? t('word.you') + ': ' : ''}${d.last_body}` : t('messages.quiet')}
                    </Text>
                  </View>
                  {d.unread ? <Text style={styles.count}>{d.unread}</Text> : null}
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}

      <Modal visible={picking} animationType="slide" transparent onRequestClose={() => setPicking(false)}>
        <Pressable style={styles.scrim} onPress={() => setPicking(false)} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
          <Text style={styles.sheetTitle}>{t('messages.new')}</Text>
          <Input value={who} onChangeText={setWho} placeholder={t('messages.new.who')} autoFocus autoCapitalize="none" autoCorrect={false} />
          <View style={styles.sheetList}>
            {shownFriends.slice(0, 8).map((f) => (
              <Pressable key={f.other_id} onPress={() => pick(f)} accessibilityRole="button" style={({ pressed }) => [s.row, pressed && s.pressed]}>
                <View style={s.face}><Avatar name={f.handle ?? f.display_name ?? '?'} size={36} /></View>
                <View style={s.text}>
                  <View style={styles.nameRow}>
                    <Text style={[s.name, styles.shrink]} numberOfLines={1}>{(f.display_name ?? f.handle ?? '').toLowerCase()}</Text>
                    {isTestHandle(f.handle) ? <TestTag plain /> : null}
                  </View>
                  <Text style={s.meta} numberOfLines={1}>@{f.handle}</Text>
                </View>
              </Pressable>
            ))}
            {!shownFriends.length ? <Text style={s.note}>{accepted.length ? t('messages.new.none') : t('messages.new.noFriends')}</Text> : null}
            {said ? <Text style={[s.note, s.bad]}>{said}</Text> : null}
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  shrink: { flexShrink: 1 },
  newRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14, paddingVertical: 10 },
  newMark: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.spot, alignItems: 'center', justifyContent: 'center' },
  newPlus: { fontFamily: fonts.medium, fontSize: 20, lineHeight: 22, color: colors.ink },
  newText: { fontFamily: fonts.medium, fontSize: 15, color: colors.paper },
  scrim: { flex: 1, backgroundColor: 'rgba(31,26,20,0.4)' },
  sheet: { backgroundColor: colors.ink, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, borderTopWidth: 1, borderColor: colors.ink3, paddingHorizontal: brand.left, paddingTop: 18, gap: 12 },
  sheetTitle: { fontFamily: fonts.semibold, fontSize: 20, letterSpacing: -0.5, color: colors.paper },
  sheetList: { minHeight: 120 },
  count: { minWidth: 22, height: 22, paddingHorizontal: 6, borderRadius: 11, backgroundColor: colors.spot, color: colors.ink, fontFamily: fonts.semibold, fontSize: 11.5, lineHeight: 22, textAlign: 'center', overflow: 'hidden', marginRight: 8 },
});
