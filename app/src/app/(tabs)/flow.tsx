import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import Svg, { Path } from 'react-native-svg';
import Storage from 'expo-sqlite/kv-store';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ProjectDeck, { type DeckHandle } from '@/components/ProjectDeck';
import BigPicker from '@/components/BigPicker';
import Tips from '@/components/Tips';
import { Chevron } from '@/components/Pill';
import { useTabBarSpace } from '@/components/TabBar';
import { useAuth } from '@/auth/AuthContext';
import { COUNTRIES } from '@/data/cities';
import { fetchDeck, resetSwipes, swipe, unswipe, type Project } from '@/data/deck';
import { useTabReset } from '@/hooks/useTabReset';
import { OfflineError, onBackOnline } from '@/lib/offline';
import { serverText } from '@/lib/serverText';
import { upperData, useLang } from '@/i18n';
import { colors, fonts } from '@/theme/tokens';
import { brand } from '@/theme/layout';

const ACTIONS = 92;

// The flow: the project deck, one card at a time, with a country picker on top.
// Keep and let go are saved when signed in (a guest just moves on).
export default function FlowScreen() {
  const { session } = useAuth();
  const { t, tx, up } = useLang();
  const insets = useSafeAreaInsets();
  const tabSpace = useTabBarSpace();
  const deck = useRef<DeckHandle>(null);
  const [country, setCountry] = useState<string | null>(() => Storage.getItemSync('country'));
  const [sheet, setSheet] = useState(false);
  const [swiped, setSwiped] = useState(0);
  const [reloads, setReloads] = useState(0);
  const [headBottom, setHeadBottom] = useState(0);
  const failed = useRef(false);
  useEffect(() => onBackOnline(() => failed.current && setReloads((n) => n + 1)), []);
  useTabReset('flow', () => {
    setSheet(false);
    setSwiped(0);
    setReloads((n) => n + 1);
  });
  const key = `${country}/${session?.user.id ?? ''}/${reloads}`;
  const [result, setResult] = useState<{ key: string; rows: Project[] | null; error: string | null }>({ key: '', rows: null, error: null });
  useEffect(() => {
    let cancelled = false;
    fetchDeck(country, 40)
      .then((rows) => {
        failed.current = rows.length === 0;
        if (!cancelled) setResult({ key, rows, error: null });
      })
      .catch((e) => {
        failed.current = true;
        if (!cancelled) setResult({ key, rows: null, error: e instanceof OfflineError ? 'offline' : serverText(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [country, key]);
  const rows = result.key === key ? result.rows : null;
  const error = result.key === key ? result.error : null;

  const onSwipe = useCallback((p: Project, direction: 'left' | 'right') => {
    setSwiped((n) => n + 1);
    if (session) swipe(p.slug, direction).catch(() => {});
  }, [session]);
  const onUndo = useCallback((p: Project) => {
    setSwiped((n) => Math.max(0, n - 1));
    if (session) unswipe(p.slug).catch(() => {});
  }, [session]);
  const onReset = useCallback(() => {
    setSwiped(0);
    (session ? resetSwipes() : Promise.resolve()).catch(() => {}).then(() => setReloads((n) => n + 1));
  }, [session]);
  const pick = (id: string) => {
    const v = id === '*' ? null : id;
    setSwiped(0);
    setCountry(v);
    if (v) Storage.setItemSync('country', v);
    else Storage.removeItemSync('country');
  };
  const label = country ? tx('country.' + country, COUNTRIES.find((c) => c.id === country)?.label ?? country) : t('filter.everywhere');
  const headTop = Math.max(brand.top, insets.top + 24) - 8;

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <View style={[styles.head, { top: headTop }]} onLayout={(e) => setHeadBottom(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}>
        <Pressable onPress={() => setSheet(true)} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('filter.where')} style={({ pressed }) => [styles.where, pressed && styles.pressed]}>
          <Text style={styles.whereText} numberOfLines={1}>{label}</Text>
          <Chevron color={colors.paper} />
        </Pressable>
      </View>
      <View style={styles.stage}>
        {error ? (
          <Text style={styles.note}>{error === 'offline' ? up(t('offline.empty')) : upperData(error)}</Text>
        ) : rows ? (
          <ProjectDeck ref={deck} key={key} projects={rows} bottom={tabSpace + ACTIONS} top={(headBottom || headTop + 30) + 14} onSwipe={onSwipe} onUndo={onUndo} onReset={onReset} />
        ) : (
          <Text style={styles.note}>{up(t('flow.loading'))}</Text>
        )}
        {rows && rows.length > swiped ? (
          <View style={[styles.actions, { bottom: tabSpace + 14 }]}>
            <Pressable onPress={() => deck.current?.swipe('left')} accessibilityRole="button" accessibilityLabel={t('word.letgo')} style={({ pressed }) => [styles.act, pressed && styles.pressed]}>
              <Svg width={22} height={22} viewBox="0 0 22 22"><Path d="M5 5l12 12M17 5L5 17" stroke={colors.paper} strokeWidth={2} strokeLinecap="round" /></Svg>
            </Pressable>
            <Pressable onPress={() => deck.current?.undo()} disabled={swiped === 0} accessibilityRole="button" accessibilityLabel={t('flow.undo')} style={({ pressed }) => [styles.act, styles.actSmall, swiped === 0 && styles.actOff, pressed && styles.pressed]}>
              <Svg width={18} height={18} viewBox="0 0 14 14"><Path d="M5 3 2 6l3 3M2 6h6.5a3.5 3.5 0 0 1 0 7H6" stroke={colors.paper} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" fill="none" /></Svg>
            </Pressable>
            <Pressable onPress={() => deck.current?.swipe('right')} accessibilityRole="button" accessibilityLabel={t('word.keep')} style={({ pressed }) => [styles.act, styles.actKeep, pressed && styles.pressed]}>
              <Svg width={24} height={24} viewBox="0 0 24 24"><Path d="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2Z" fill={colors.paper} /></Svg>
            </Pressable>
          </View>
        ) : null}
      </View>
      <BigPicker open={sheet} title={t('filter.where')} options={[{ id: '*', label: t('filter.everywhere') }, ...COUNTRIES.map((c) => ({ id: c.id, label: tx('country.' + c.id, c.label) }))]} selected={country ?? '*'} onSelect={pick} onClose={() => setSheet(false)} />
      <Tips page="flow" tip={{ title: 'tips.flow.1.t', body: 'tips.flow.1.b', motion: 'swipe' }} bottom={tabSpace + 92} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  head: { position: 'absolute', left: brand.left, right: brand.left, zIndex: 1 },
  where: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', maxWidth: '72%' },
  whereText: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 26, lineHeight: 30, letterSpacing: -0.8, color: colors.paper },
  pressed: { opacity: 0.6 },
  stage: { flex: 1 },
  note: { fontFamily: fonts.regular, fontSize: 11, letterSpacing: 1.4, color: colors.mute, textAlign: 'center', marginTop: 40 },
  actions: { position: 'absolute', left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 28 },
  act: { width: 60, height: 60, borderRadius: 30, borderWidth: 1, borderColor: colors.ink3, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  actSmall: { width: 46, height: 46, borderRadius: 23 },
  actOff: { opacity: 0.35 },
  actKeep: { backgroundColor: colors.spot, borderColor: colors.spot },
});
