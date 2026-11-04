import { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import PullDownScroll from '@/components/PullDownScroll';
import Button from '@/components/Button';
import Avatar from '@/components/Avatar';
import { useTabBarSpace } from '@/components/TabBar';
import { useAuth } from '@/auth/AuthContext';
import { callInbox, type CallInvite } from '@/data/calls';
import { COOP_COLORS, myCoops, type CoopRow } from '@/data/coops';
import { friendsLive, type LiveFriend } from '@/data/contribution';
import { friendsKept, kept, type FriendKept } from '@/data/friends';
import type { Project } from '@/data/projects';
import { useRefreshOnFocus } from '@/hooks/useRefresh';
import { upperData, useLang } from '@/i18n';
import { dayLabel } from '@/data/when';
import { colors, fonts, radius } from '@/theme/tokens';
import { brand } from '@/theme/layout';

// Connect: your coops (who you work nights with), the calls waiting for you, the
// projects your friends keep (grouped, so one project shows once with every friend on
// it), and your own kept projects as a row.
export default function ConnectScreen() {
  const { session } = useAuth();
  const insets = useSafeAreaInsets();
  const tabSpace = useTabBarSpace();
  const { t, tn, up } = useLang();
  const tick = useRefreshOnFocus('coops', 'friendsKept', 'kept', 'calls', 'live');
  const [coops, setCoops] = useState<CoopRow[]>([]);
  const [calls, setCalls] = useState<CallInvite[]>([]);
  const [theirs, setTheirs] = useState<FriendKept[] | null>(null);
  const [mine, setMine] = useState<Project[]>([]);
  const [live, setLive] = useState<LiveFriend[]>([]);
  const uid = session?.user.id;
  const load = useCallback(() => {
    if (!uid) return;
    myCoops().then((c) => setCoops(c ?? []), () => {});
    callInbox().then(setCalls, () => {});
    friendsKept().then(setTheirs, () => setTheirs([]));
    kept().then(setMine, () => {});
    friendsLive().then(setLive, () => {});
  }, [uid]);
  useEffect(load, [load, tick]);

  const grouped = Object.values(
    (theirs ?? []).reduce<Record<string, FriendKept & { friends: string[] }>>((acc, k) => {
      const g = acc[k.slug] ?? { ...k, friends: [] };
      if (!g.friends.includes(k.friend)) g.friends.push(k.friend);
      acc[k.slug] = g;
      return acc;
    }, {}),
  );
  const open = (slug: string) => router.push(`/project/${slug}`);

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <PullDownScroll
        header={<View style={styles.band}><Text style={styles.title}>{t('connect.title')}</Text></View>}
        contentContainerStyle={[styles.body, { paddingBottom: tabSpace + insets.bottom + 28 }]}
        showsVerticalScrollIndicator={false}
      >
        {!session ? (
          <View style={styles.empty}>
            <Text style={styles.note}>{t('connect.emptyMineGuest')}</Text>
            <View style={styles.cta}><Button label={t('word.signup')} onPress={() => router.push('/signup')} /></View>
          </View>
        ) : (
          <>
            <View style={styles.headRow}>
              <Text style={styles.section}>{up(t('coops.title'))}</Text>
              <Pressable onPress={() => router.push('/coops/join')} hitSlop={8}><Text style={styles.link}>{t('coops.join')}</Text></Pressable>
            </View>
            <View style={styles.coopRow}>
              {coops.map((c) => (
                <Pressable key={c.id} onPress={() => router.push({ pathname: '/coops/[id]', params: { id: c.id } })} style={({ pressed }) => [styles.coop, { borderColor: COOP_COLORS[c.color] }, pressed && styles.pressed]}>
                  <Text style={styles.coopEmoji}>{c.emoji}</Text>
                  <Text style={styles.coopName} numberOfLines={1}>{c.name.toLowerCase()}</Text>
                  <Text style={styles.coopMeta} numberOfLines={1}>{c.tonight_title ? upperData(c.tonight_title) : t('coops.members', { n: c.members })}</Text>
                </Pressable>
              ))}
              <Pressable onPress={() => router.push('/coops/new')} style={({ pressed }) => [styles.coop, styles.coopNew, pressed && styles.pressed]}>
                <Text style={styles.coopPlus}>+</Text>
                <Text style={styles.coopName}>{t('coops.new')}</Text>
              </Pressable>
            </View>
            {!coops.length ? <Text style={styles.note}>{t('connect.coops.none')}</Text> : null}

            {calls.length ? (
              <>
                <Text style={[styles.section, styles.sectionTop]}>{up(t('flow.calls'))}</Text>
                {calls.map((c) => (
                  <Pressable key={c.id} onPress={() => router.push({ pathname: '/call/[id]', params: { id: c.id } })} style={({ pressed }) => [styles.call, pressed && styles.pressed]}>
                    <View style={styles.callDot} />
                    <View style={styles.rowText}>
                      <Text style={styles.rowName} numberOfLines={1}>{upperData(c.title)}</Text>
                      <Text style={styles.rowMeta} numberOfLines={1}>{t('call.from', { name: (c.host_name ?? c.host_handle ?? '?').toLowerCase() })} · {dayLabel(c.night)} · {tn('call.people', c.going)}</Text>
                    </View>
                    <Text style={[styles.answer, c.mine === 'in' && styles.answerIn]}>{c.mine === 'in' ? t('call.answered.in') : c.mine === 'out' ? t('call.answered.out') : '›'}</Text>
                  </Pressable>
                ))}
              </>
            ) : null}

            <Text style={[styles.section, styles.sectionTop]}>{up(t('connect.withPeople'))}</Text>
            {theirs === null ? <Text style={styles.note}>{t('flow.loading')}</Text> : null}
            {theirs && !theirs.length ? <Text style={styles.note}>{t('connect.emptyNoFriends')}</Text> : null}
            {grouped.map((g) => {
              const out = live.find((l) => l.slug === g.slug);
              return (
                <Pressable key={g.slug} onPress={() => open(g.slug)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                  <View style={styles.faces}>
                    {g.friends.slice(0, 3).map((f, i) => (
                      <View key={f} style={[styles.faceSmall, { marginLeft: i ? -10 : 0 }, out && styles.faceLive]}><Avatar name={f} size={30} /></View>
                    ))}
                  </View>
                  <View style={styles.rowText}>
                    <Text style={styles.rowName} numberOfLines={1}>{upperData(g.title)}</Text>
                    <Text style={[styles.rowMeta, out && styles.live]} numberOfLines={1}>
                      {out ? `${t('connect.live')} · ${out.handle}` : `${tn('connect.friendsKept', g.friends.length)} · ${upperData(g.model)}`}
                    </Text>
                  </View>
                  <Text style={styles.answer}>›</Text>
                </Pressable>
              );
            })}

            <Text style={[styles.section, styles.sectionTop]}>{up(t('deck.yours'))}</Text>
            {!mine.length ? <Text style={styles.note}>{t('connect.emptyMine')}</Text> : null}
            <View style={styles.chips}>
              {mine.map((p) => (
                <Pressable key={p.slug} onPress={() => open(p.slug)} style={({ pressed }) => [styles.chip, pressed && styles.pressed]}>
                  <Text style={styles.chipText} numberOfLines={1}>{upperData(p.title)}</Text>
                </Pressable>
              ))}
            </View>
          </>
        )}
      </PullDownScroll>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  band: { position: 'absolute', top: 0, left: 0, right: 0, height: brand.top + 44, backgroundColor: colors.ink, zIndex: 2 },
  title: { position: 'absolute', top: brand.top - 8, left: brand.left, fontFamily: fonts.semibold, fontSize: 30, lineHeight: 32, letterSpacing: -0.9, color: colors.paper },
  body: { paddingTop: brand.top + 48, paddingHorizontal: brand.left },
  empty: { marginTop: 36 },
  cta: { marginTop: 20 },
  note: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.mute, marginTop: 10 },
  headRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 10 },
  section: { fontFamily: fonts.regular, fontSize: 11, letterSpacing: 1.4, color: colors.mute, marginTop: 10 },
  sectionTop: { marginTop: 30 },
  link: { fontFamily: fonts.medium, fontSize: 12, color: colors.spotText },
  coopRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 },
  coop: { width: '47%', flexGrow: 1, borderWidth: 1.5, borderRadius: radius.md, padding: 12, gap: 4, backgroundColor: colors.ink },
  coopNew: { borderColor: colors.ink3, borderStyle: 'dashed' },
  coopEmoji: { fontSize: 22 },
  coopPlus: { fontFamily: fonts.medium, fontSize: 22, lineHeight: 28, color: colors.mute },
  coopName: { fontFamily: fonts.semibold, fontSize: 15, letterSpacing: -0.3, color: colors.paper },
  coopMeta: { fontFamily: fonts.regular, fontSize: 11, color: colors.meta },
  call: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.ink3 },
  callDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.spot },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.ink3 },
  faces: { flexDirection: 'row', minWidth: 30 },
  faceSmall: { width: 30, height: 30, borderRadius: 15, overflow: 'hidden', borderWidth: 1.5, borderColor: colors.ink },
  faceLive: { borderColor: colors.spot },
  rowText: { flex: 1, gap: 3 },
  rowName: { fontFamily: fonts.medium, fontSize: 16, letterSpacing: -0.2, color: colors.paper },
  rowMeta: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.meta },
  live: { color: colors.spotText },
  answer: { fontFamily: fonts.regular, fontSize: 12, color: colors.meta },
  answerIn: { color: colors.spotText },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  chip: { paddingHorizontal: 12, height: 34, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.ink3, justifyContent: 'center', maxWidth: '100%' },
  chipText: { fontFamily: fonts.medium, fontSize: 13, color: colors.paper },
  pressed: { opacity: 0.6 },
});
