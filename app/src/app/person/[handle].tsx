import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Avatar from '@/components/Avatar';
import BackButton from '@/components/BackButton';
import NightCard from '@/components/NightCard';
import { ActionButton, confirmBlock, refreshPeople, useConnect } from '@/components/People';
import { useReport } from '@/components/ReportSheet';
import { useAuth } from '@/auth/AuthContext';
import { personCards, toCardData, type CardRow } from '@/data/contribution';
import { dmStart } from '@/data/dms';
import { friendRemove, person, type PersonCard, type Relation } from '@/data/friends';
import { isTestHandle, testPerson } from '@/data/local/testPeople';
import { TestTag } from '@/components/connect/TestTag';
import { upperData, useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';
import { brand } from '@/theme/layout';

// Someone's page: face, name, city, how many projects they keep and nights they did,
// the add/accept button, write and the cards of their nights (friends only).
export default function PersonScreen() {
  const { handle } = useLocalSearchParams<{ handle: string }>();
  const { t, up } = useLang();
  const insets = useSafeAreaInsets();
  const { session } = useAuth();
  const { after, busy, act } = useConnect();
  const [p, setP] = useState<PersonCard | null | undefined>(undefined);
  const [cards, setCards] = useState<CardRow[]>([]);
  const [gone, setGone] = useState(false);
  const reporting = useReport();
  useEffect(() => {
    let alive = true;
    person(handle).then((x) => alive && setP(x), () => alive && setP(null));
    personCards(handle).then((c) => alive && setCards(c), () => {});
    return () => { alive = false; };
  }, [handle]);
  if (p === undefined) return <View style={styles.root}><Text style={styles.quiet}>{t('person.loading')}</Text><BackButton /></View>;
  if (!p || gone) return <View style={styles.root}><Text style={styles.quiet}>{t('person.hidden')}</Text><BackButton /></View>;
  const relation: Relation = after[p.id] ?? p.relation;
  // a test person (data/local/testPeople.ts): marked, with their phone; nothing to report or block
  const testing = isTestHandle(p.handle);
  const device = testPerson({ handle: p.handle })?.device;
  const name = (p.display_name ?? p.handle).toLowerCase();
  const write = () => dmStart(p.handle).then((id) => router.push({ pathname: '/dm/[id]', params: { id, name } }), () => {});
  const remove = () =>
    Alert.alert(t('friend.remove'), name, [
      { text: t('word.cancel'), style: 'cancel' },
      { text: t('friend.remove'), style: 'destructive', onPress: () => friendRemove(p.id).then(() => { refreshPeople(); router.back(); }, () => {}) },
    ]);
  const width = 300;
  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 40 }]} showsVerticalScrollIndicator={false}>
        <View style={styles.head}>
          <View style={styles.face}><Avatar name={p.handle} size={72} /></View>
          <Text style={styles.name}>{name}</Text>
          <Text style={styles.meta}>{upperData([`@${p.handle}`, p.city_name, testing ? device : null].filter(Boolean).join(' · '))}</Text>
          {testing ? <TestTag /> : null}
          {p.bio ? <Text style={styles.bio}>{p.bio}</Text> : null}
          <Text style={styles.stats}>{up(`${t('person.kept', { n: p.kept_count ?? 0 })} · ${t('person.nights', { n: p.night_count ?? 0 })}`)}</Text>
        </View>
        {session && relation !== 'friend' ? <ActionButton wide relation={relation} busy={busy === p.id} onPress={() => act(p, relation)} /> : null}
        {relation === 'friend' ? (
          <View style={styles.actions}>
            <Pressable onPress={write} style={({ pressed }) => [styles.btn, pressed && styles.pressed]}><Text style={styles.btnText}>{t('dm.say')}</Text></Pressable>
            <Pressable onPress={remove} style={({ pressed }) => [styles.btnLine, pressed && styles.pressed]}><Text style={styles.btnLineText}>{t('friend.remove')}</Text></Pressable>
          </View>
        ) : null}
        <Text style={styles.section}>{up(t('passport.cards'))}</Text>
        {relation !== 'friend' ? <Text style={styles.quietIn}>{t('person.cards.locked')}</Text> : null}
        {relation === 'friend' && !cards.length ? <Text style={styles.quietIn}>{t('person.cards.empty')}</Text> : null}
        {relation === 'friend' && cards.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
            {cards.map((c, i) => <NightCard key={`${c.card_no}-${i}`} data={toCardData(c)} index={i} width={width} />)}
          </ScrollView>
        ) : null}
        {session && !testing ? (
          <View style={styles.foot}>
            <Pressable onPress={() => reporting.ask('profile', p.id)} hitSlop={8}><Text style={styles.footText}>{t('posts.report')}</Text></Pressable>
            <Pressable onPress={() => confirmBlock({ id: p.id, name }, t, () => setGone(true))} hitSlop={8}><Text style={styles.footText}>{t('block.do')}</Text></Pressable>
          </View>
        ) : null}
      </ScrollView>
      {reporting.sheet}
      <BackButton />
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  body: { paddingTop: brand.top + 52, paddingHorizontal: brand.left },
  quiet: { marginTop: brand.top + 60, textAlign: 'center', fontFamily: fonts.regular, fontSize: 14, color: colors.mute },
  quietIn: { fontFamily: fonts.regular, fontSize: 13, color: colors.mute, marginTop: 8 },
  head: { alignItems: 'center', gap: 6, marginBottom: 22 },
  face: { width: 72, height: 72, borderRadius: 36, overflow: 'hidden', marginBottom: 6 },
  name: { fontFamily: fonts.semibold, fontSize: 26, letterSpacing: -0.7, color: colors.paper },
  meta: { fontFamily: fonts.jet, fontSize: 10, letterSpacing: 1, color: colors.mute },
  bio: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.paper, textAlign: 'center', marginTop: 6 },
  stats: { fontFamily: fonts.regular, fontSize: 10, letterSpacing: 1.4, color: colors.meta, marginTop: 6 },
  actions: { flexDirection: 'row', gap: 10 },
  btn: { flex: 1, height: 50, borderRadius: radius.md, backgroundColor: colors.spot, alignItems: 'center', justifyContent: 'center' },
  btnText: { fontFamily: fonts.medium, fontSize: 15, color: colors.ink },
  btnLine: { flex: 1, height: 50, borderRadius: radius.md, borderWidth: 1, borderColor: colors.ink3, alignItems: 'center', justifyContent: 'center' },
  btnLineText: { fontFamily: fonts.medium, fontSize: 15, color: colors.paper },
  section: { fontFamily: fonts.regular, fontSize: 11, letterSpacing: 1.4, color: colors.mute, marginTop: 30 },
  strip: { gap: 14, paddingVertical: 14 },
  foot: { flexDirection: 'row', gap: 22, marginTop: 36 },
  footText: { fontFamily: fonts.regular, fontSize: 12, color: colors.meta, textDecorationLine: 'underline' },
  pressed: { opacity: 0.6 },
});
