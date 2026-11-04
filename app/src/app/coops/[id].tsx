import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import StaffPage, { Said } from '@/components/StaffPage';
import Avatar from '@/components/Avatar';
import PickerSheet from '@/components/PickerSheet';
import { useAuth } from '@/auth/AuthContext';
import { COOP_COLORS, coopDelete, coopGet, coopInvite, coopLeave, coopNightSet, coopNights, coopRemove, inviteUrl, tonight, why, type Coop, type CoopNight } from '@/data/coops';
import { kept } from '@/data/friends';
import type { Project } from '@/data/projects';
import { chooseTonight } from '@/night/useNight';
import { invalidate } from '@/lib/offline';
import { openPerson } from '@/components/People';
import { dayLabel } from '@/data/when';
import { upperData, useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';

// One coop: tonight's project (anyone sets it from their kept projects), the people
// with a red ring on whoever is working now, the nights done together, invite, leave.
export default function CoopScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, up } = useLang();
  const { session } = useAuth();
  const [coop, setCoop] = useState<Coop | null>(null);
  const [nights, setNights] = useState<CoopNight[]>([]);
  const [mine, setMine] = useState<Project[]>([]);
  const [picking, setPicking] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const load = useCallback(() => {
    coopGet(id).then(setCoop, (e) => setSaid(why(e)));
    coopNights(id).then((n) => setNights(n ?? []), () => {});
    kept().then(setMine, () => {});
  }, [id]);
  useEffect(load, [load]);
  const owner = coop?.me === 'owner';
  const setNight = (slug: string) => {
    setPicking(false);
    coopNightSet(id, tonight(), slug).then(() => { chooseTonight(slug); invalidate('coops'); load(); }, (e) => setSaid(why(e)));
  };
  const invite = () =>
    coopInvite(id).then((code) => Share.share({ message: `${t('coops.invite.message', { name: coop?.name ?? '', code })}\n${inviteUrl(code)}` }), (e) => setSaid(why(e)));
  const leave = () =>
    Alert.alert(owner ? t('coops.delete') : t('coops.leave'), owner ? t('coops.delete.sure') : t('coops.leave.sure'), [
      { text: t('word.cancel'), style: 'cancel' },
      { text: owner ? t('coops.delete') : t('coops.leave'), style: 'destructive', onPress: () => (owner ? coopDelete(id) : coopLeave(id)).then(() => { invalidate('coops'); router.back(); }, (e) => setSaid(why(e))) },
    ]);
  const remove = (uid: string, name: string) =>
    Alert.alert(t('coops.remove'), name, [{ text: t('word.cancel'), style: 'cancel' }, { text: t('coops.remove'), style: 'destructive', onPress: () => coopRemove(id, uid).then(load, (e) => setSaid(why(e))) }]);
  if (!coop) return <StaffPage title={t('coops.title')}><Said text={said ?? t('flow.loading')} bad={!!said} /></StaffPage>;
  const tint = COOP_COLORS[coop.color];
  return (
    <StaffPage title={`${coop.emoji} ${coop.name.toLowerCase()}`}>
      <View style={[styles.tonight, { borderColor: tint }]}>
        <Text style={styles.kicker}>{up(t('word.tonight'))}</Text>
        {coop.tonight ? (
          <Pressable onPress={() => router.push(`/project/${coop.tonight!.slug}`)}>
            <Text style={styles.tonightTitle}>{upperData(coop.tonight.title)}</Text>
            <Text style={styles.meta}>{upperData(coop.tonight.model)}</Text>
          </Pressable>
        ) : (
          <Text style={styles.note}>{t('coops.tonight.none')}</Text>
        )}
        <Pressable onPress={() => setPicking(true)} style={({ pressed }) => [styles.pick, { backgroundColor: tint }, pressed && styles.pressed]}>
          <Text style={styles.pickText}>{t('coops.tonight.pick')}</Text>
        </Pressable>
      </View>

      <Text style={styles.section}>{up(t('coops.members', { n: coop.members.length }))}</Text>
      {coop.members.map((m) => (
        <Pressable key={m.id} onPress={() => m.handle && openPerson(m.handle)} onLongPress={() => owner && m.role !== 'owner' && remove(m.id, (m.name ?? m.handle ?? '').toLowerCase())} style={styles.row}>
          <View style={[styles.face, m.live && styles.faceLive]}><Avatar name={m.handle ?? '?'} size={34} /></View>
          <View style={styles.rowText}>
            <Text style={styles.name}>{(m.name ?? m.handle ?? '').toLowerCase()}{m.id === session?.user.id ? ` · ${t('word.you')}` : ''}</Text>
            <Text style={[styles.meta, m.live && styles.live]}>{m.live ? t('coops.live') : m.role === 'owner' ? t('coops.owner') : `@${m.handle}`}</Text>
          </View>
        </Pressable>
      ))}
      <Pressable onPress={invite} style={({ pressed }) => [styles.line, pressed && styles.pressed]}><Text style={styles.lineText}>{t('coops.invite')} · {t('coops.invite.share')}</Text></Pressable>
      <Text style={styles.hint}>{t('coops.invite.hint')}</Text>

      <Text style={styles.section}>{up(t('coops.nights'))}</Text>
      {!nights.length ? <Text style={styles.note}>{t('coops.nights.none')}</Text> : null}
      {nights.map((n) => (
        <View key={n.night} style={styles.row}>
          <View style={styles.rowText}>
            <Text style={styles.name}>{dayLabel(n.night)} · {upperData(n.title)}</Text>
            <Text style={styles.meta}>{t('coops.night.line', { phones: n.phones, tokens: Math.round(n.tokens).toLocaleString(), credits: n.credits })}</Text>
          </View>
        </View>
      ))}

      <Pressable onPress={leave} style={({ pressed }) => [styles.danger, pressed && styles.pressed]}><Text style={styles.dangerText}>{owner ? t('coops.delete') : t('coops.leave')}</Text></Pressable>
      <Said text={said} bad />
      <PickerSheet open={picking} title={t('coops.tonight.pick')} options={mine.map((p) => ({ id: p.slug, label: p.title, extra: p.model }))} selected={coop.tonight?.slug ?? null} onSelect={setNight} onClose={() => setPicking(false)} note={!mine.length ? t('connect.emptyMine') : undefined} />
    </StaffPage>
  );
}
const styles = StyleSheet.create({
  tonight: { borderWidth: 2, borderRadius: radius.md, padding: 14, gap: 6 },
  kicker: { fontFamily: fonts.regular, fontSize: 10, letterSpacing: 1.6, color: colors.mute },
  tonightTitle: { fontFamily: fonts.semibold, fontSize: 20, letterSpacing: -0.5, color: colors.paper },
  pick: { marginTop: 8, height: 44, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  pickText: { fontFamily: fonts.medium, fontSize: 14, color: colors.ink },
  section: { fontFamily: fonts.regular, fontSize: 11, letterSpacing: 1.4, color: colors.mute, marginTop: 28, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.ink3 },
  rowText: { flex: 1, gap: 2 },
  face: { width: 34, height: 34, borderRadius: 17, overflow: 'hidden' },
  faceLive: { borderWidth: 2, borderColor: colors.spot },
  name: { fontFamily: fonts.medium, fontSize: 15, color: colors.paper },
  meta: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.meta },
  live: { color: colors.spotText },
  note: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: colors.mute },
  hint: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.meta, marginTop: 6 },
  line: { marginTop: 12, height: 44, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.paper, alignItems: 'center', justifyContent: 'center' },
  lineText: { fontFamily: fonts.medium, fontSize: 14, color: colors.paper },
  danger: { marginTop: 36, alignSelf: 'flex-start' },
  dangerText: { fontFamily: fonts.regular, fontSize: 13, color: colors.spotText, textDecorationLine: 'underline' },
  pressed: { opacity: 0.6 },
});
