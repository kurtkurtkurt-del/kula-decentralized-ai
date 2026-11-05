import { useEffect, useState } from 'react';
import { serverText } from '@/lib/serverText';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import Svg, { Circle, Line } from 'react-native-svg';
import Avatar from '@/components/Avatar';
import { useAuth } from '@/auth/AuthContext';
import { blockUser, friendAccept, friendRequest, peopleSearch, peopleSuggested, type Found, type Relation, type Suggested } from '@/data/friends';
import { invalidate } from '@/lib/offline';
import { isTestHandle } from '@/data/local/testPeople';
import { TestTag } from '@/components/connect/TestTag';
import { upperData, useLang } from '@/i18n';
import type { Key } from '@/i18n/dict';
import { colors, fonts, radius } from '@/theme/tokens';
import { brand } from '@/theme/layout';

// Finding people: a search field with results while typing; suggestions when empty.
// Requests, accepts and the person page all start here.
export function PeopleSearch({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { t } = useLang();
  return (
    <View style={styles.search}>
      <Svg width={16} height={16} viewBox="0 0 16 16">
        <Circle cx={7} cy={7} r={5} stroke={colors.mute} strokeWidth={1.5} fill="none" />
        <Line x1={10.8} y1={10.8} x2={14.5} y2={14.5} stroke={colors.mute} strokeWidth={1.5} strokeLinecap="round" />
      </Svg>
      <TextInput value={value} onChangeText={onChange} placeholder={t('people.search')} placeholderTextColor={colors.meta} selectionColor={colors.spot} cursorColor={colors.paper} autoCapitalize="none" autoCorrect={false} returnKeyType="search" style={styles.searchInput} />
      {value ? (
        <Pressable onPress={() => onChange('')} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('people.clear')}>
          <Text style={styles.clear}>×</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export const refreshPeople = () => invalidate('friends', 'friendsKept', 'suggested', 'dms');

export function useConnect() {
  const { ensureSession } = useAuth();
  const [after, setAfter] = useState<Record<string, Relation>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (p: { id: string; handle: string }, relation: Relation) => {
    if (relation === 'friend') return openPerson(p.handle);
    if (relation === 'outgoing') return;
    if (!(await ensureSession())) return; // a guest adds friends like anyone
    setBusy(p.id);
    try {
      if (relation === 'incoming') {
        await friendAccept(p.id);
        setAfter((a) => ({ ...a, [p.id]: 'friend' }));
      } else {
        const r = await friendRequest(p.handle);
        setAfter((a) => ({ ...a, [p.id]: r === 'accepted' ? 'friend' : 'outgoing' }));
      }
      refreshPeople();
    } catch {
      /* the button stays as it was and can be retried */
    } finally {
      setBusy(null);
    }
  };
  return { after, busy, act };
}

export function confirmBlock(p: { id: string; name: string }, t: (k: Key, v?: Record<string, string | number>) => string, done: () => void) {
  Alert.alert(t('block.title', { name: p.name }), t('block.body'), [
    { text: t('block.keep'), style: 'cancel' },
    { text: t('block.go'), style: 'destructive', onPress: () => blockUser(p.id).then(() => { refreshPeople(); done(); }).catch((e) => Alert.alert(t('block.failed'), serverText(e))) },
  ]);
}

export function ActionButton({ relation, busy, onPress, wide }: { relation: Relation; busy: boolean; onPress: () => void; wide?: boolean }) {
  const { t } = useLang();
  const red = relation === 'none' || relation === 'incoming';
  const label = wide
    ? t(relation === 'none' ? 'people.add.long' : relation === 'incoming' ? 'people.accept.long' : relation === 'outgoing' ? 'people.asked.long' : 'people.friend')
    : t(relation === 'none' ? 'people.add' : relation === 'incoming' ? 'people.accept' : relation === 'outgoing' ? 'people.asked' : 'people.friend');
  return (
    <Pressable onPress={onPress} disabled={busy || relation === 'outgoing'} hitSlop={6} style={({ pressed }) => [red ? styles.btnRed : styles.btnLine, wide && styles.btnWide, pressed && styles.pressed]}>
      {busy ? <ActivityIndicator size="small" color={red ? colors.ink : colors.paper} /> : <Text style={[red ? styles.btnTextRed : styles.btnTextLine, wide && styles.btnTextWide]}>{label}</Text>}
    </Pressable>
  );
}

export const openPerson = (handle: string) => router.push({ pathname: '/person/[handle]', params: { handle } });

export function PeopleResults({ query }: { query: string }) {
  const { t, tn, up } = useLang();
  const { after, busy, act } = useConnect();
  const [state, setState] = useState<{ q: string; rows: Found[] | null; error: boolean }>({ q: '', rows: null, error: false });
  const q = query.trim().replace(/^@/, '');
  useEffect(() => {
    if (q.length < 2) return;
    let stale = false;
    const timer = setTimeout(() => {
      peopleSearch(q).then((rows) => !stale && setState({ q, rows, error: false })).catch(() => !stale && setState({ q, rows: null, error: true }));
    }, 280);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [q]);
  if (q.length < 2) return <Text style={styles.note}>{up(t('people.short'))}</Text>;
  if (state.q !== q) return <Text style={styles.note}>{up(t('people.searching'))}</Text>;
  if (state.error) return <Text style={styles.note}>{up(t('people.error'))}</Text>;
  if (!state.rows?.length) return <Text style={styles.note}>{up(t('people.none'))}</Text>;
  return (
    <View style={styles.results}>
      {state.rows.map((p) => {
        const relation = after[p.id] ?? p.relation;
        const name = (p.display_name ?? p.handle).toLowerCase();
        const meta = [`@${p.handle}`, p.city_name, p.mutual ? tn('people.mutual', p.mutual) : null].filter(Boolean).join(' · ');
        return (
          <View key={p.id} style={styles.row}>
            <Pressable onPress={() => openPerson(p.handle)} accessibilityRole="button" style={({ pressed }) => [styles.rowOpen, pressed && styles.pressed]}>
              <View style={styles.face}><Avatar name={p.handle} size={46} /></View>
              <View style={styles.rowText}>
                <View style={styles.nameRow}>
                  <Text style={[styles.rowName, styles.shrink]} numberOfLines={1}>{name}</Text>
                  {isTestHandle(p.handle) ? <TestTag plain /> : null}
                </View>
                <Text style={styles.rowMeta} numberOfLines={1}>{upperData(meta)}</Text>
              </View>
            </Pressable>
            <ActionButton relation={relation} busy={busy === p.id} onPress={() => act(p, relation)} />
          </View>
        );
      })}
    </View>
  );
}

// People you may know, as small squares in a row: tap the square for the page, the
// red + to send a request.
export function SuggestedRow() {
  const { t, up } = useLang();
  const { session } = useAuth();
  const { after, busy, act } = useConnect();
  const [rows, setRows] = useState<Suggested[]>([]);
  const uid = session?.user.id;
  useEffect(() => {
    if (!uid) return;
    let alive = true;
    peopleSuggested(6).then((r) => alive && setRows(r)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [uid]);
  if (!rows.length) return null;
  return (
    <View style={styles.suggest}>
      <Text style={styles.suggestWord}>{up(t('people.suggested'))}</Text>
      <View style={styles.suggestRow}>
        {rows.map((p) => {
          const name = (p.display_name ?? p.handle).toLowerCase();
          const relation: Relation = after[p.id] ?? 'none';
          const asked = relation !== 'none';
          return (
            <View key={p.id} style={styles.mini}>
              <Pressable onPress={() => openPerson(p.handle)} accessibilityRole="button" accessibilityLabel={name} style={({ pressed }) => pressed && styles.pressed}>
                <View style={styles.miniSquare}><Avatar name={p.handle} size={44} /></View>
              </Pressable>
              <Pressable onPress={() => act(p, relation)} disabled={asked || busy === p.id} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('people.add')} style={[styles.badge, asked && styles.badgeDone]}>
                <Text style={[styles.badgeText, asked && styles.badgeTextDone]}>{asked ? '✓' : '+'}</Text>
              </Pressable>
              <Text style={styles.miniName} numberOfLines={1}>{name}</Text>
              {isTestHandle(p.handle) ? <TestTag plain /> : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  search: { marginBottom: 18, height: 44, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.ink3, backgroundColor: colors.ink, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 10 },
  searchInput: { flex: 1, height: 44, fontFamily: fonts.regular, fontSize: 15, letterSpacing: -0.1, color: colors.paper, paddingVertical: 0 },
  clear: { fontFamily: fonts.regular, fontSize: 22, lineHeight: 24, color: colors.mute },
  note: { fontFamily: fonts.regular, fontSize: 10, letterSpacing: 1.6, color: colors.meta, marginTop: 6 },
  results: {},
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.ink3 },
  rowOpen: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12 },
  rowText: { flex: 1, gap: 3 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  shrink: { flexShrink: 1 },
  rowName: { fontFamily: fonts.semibold, fontSize: 17, letterSpacing: -0.4, color: colors.paper },
  rowMeta: { fontFamily: fonts.jet, fontSize: 10, letterSpacing: 0.8, color: colors.mute },
  face: { width: 46, height: 46, borderRadius: radius.sm, overflow: 'hidden' },
  btnRed: { paddingVertical: 8, paddingHorizontal: 14, backgroundColor: colors.spot, borderRadius: radius.pill, minWidth: 64, alignItems: 'center' },
  btnLine: { paddingVertical: 7, paddingHorizontal: 13, borderWidth: 1, borderColor: colors.paper, borderRadius: radius.pill, minWidth: 64, alignItems: 'center' },
  btnWide: { alignSelf: 'stretch', height: 54, borderRadius: radius.md, justifyContent: 'center', paddingVertical: 0 },
  btnTextWide: { fontSize: 17, letterSpacing: -0.3 },
  btnTextRed: { fontFamily: fonts.medium, fontSize: 13, color: colors.ink },
  btnTextLine: { fontFamily: fonts.medium, fontSize: 13, color: colors.paper },
  suggest: { marginTop: 22 },
  suggestWord: { fontFamily: fonts.regular, fontSize: 11, letterSpacing: 1.4, color: colors.mute, marginBottom: 10 },
  suggestRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  mini: { width: 52, alignItems: 'center', gap: 4 },
  miniSquare: { width: 44, height: 44, borderRadius: radius.sm, overflow: 'hidden' },
  badge: { position: 'absolute', top: -5, right: -1, width: 18, height: 18, borderRadius: 9, backgroundColor: colors.spot, alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: colors.ink },
  badgeDone: { backgroundColor: colors.paper },
  badgeText: { fontFamily: fonts.semibold, fontSize: 11, lineHeight: 13, color: colors.ink },
  badgeTextDone: { color: colors.ink, fontSize: 9 },
  miniName: { fontFamily: fonts.regular, fontSize: 9.5, color: colors.meta, maxWidth: 52 },
  pressed: { opacity: 0.6 },
  _pad: { paddingHorizontal: brand.left },
});
