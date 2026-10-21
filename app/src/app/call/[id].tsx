import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import StaffPage, { Said } from '@/components/StaffPage';
import Button from '@/components/Button';
import Avatar from '@/components/Avatar';
import { useReport } from '@/components/ReportSheet';
import { openPerson } from '@/components/People';
import { callAnswer, callCancel, callGet, callPeople, type CallInvite, type CallPerson, type MyCall } from '@/data/calls';
import { chooseTonight } from '@/night/useNight';
import { dayLabel } from '@/data/when';
import { invalidate } from '@/lib/offline';
import { serverText } from '@/lib/serverText';
import { upperData, useLang } from '@/i18n';
import { colors, fonts } from '@/theme/tokens';

// One call: the project, the night, who started it, who is in. Answer in or out; the
// host can call it off.
export default function CallScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, tn, up } = useLang();
  const [invite, setInvite] = useState<CallInvite | null>(null);
  const [mine, setMine] = useState<MyCall | null>(null);
  const [people, setPeople] = useState<CallPerson[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const reporting = useReport();
  const load = useCallback(() => {
    callGet(id).then((r) => { setInvite(r.invite); setMine(r.mine); setLoaded(true); }, (e) => { setSaid(serverText(e)); setLoaded(true); });
    callPeople(id).then(setPeople, () => {});
  }, [id]);
  useEffect(load, [load]);
  const answer = (a: 'in' | 'out') =>
    callAnswer(id, a).then(() => { if (a === 'in' && invite) chooseTonight(invite.slug); invalidate('calls'); load(); }, (e) => setSaid(serverText(e)));
  const off = () =>
    Alert.alert(t('call.callOff'), t('call.callOff.sure'), [{ text: t('word.cancel'), style: 'cancel' }, { text: t('call.callOff'), style: 'destructive', onPress: () => callCancel(id).then(() => { invalidate('calls'); router.back(); }, (e) => setSaid(serverText(e))) }]);
  const c = invite ?? mine;
  if (!loaded) return <StaffPage title={t('call.kicker')}><Said text={t('flow.loading')} /></StaffPage>;
  if (!c) return <StaffPage title={t('call.kicker')}><Said text={said ?? t('call.gone')} bad /></StaffPage>;
  const host = invite ? (invite.host_name ?? invite.host_handle ?? '?').toLowerCase() : t('word.you');
  return (
    <StaffPage title={t('call.kicker')}>
      <Pressable onPress={() => router.push(`/project/${c.slug}`)}>
        <Text style={styles.title}>{upperData(c.title)}</Text>
        <Text style={styles.meta}>{upperData(c.model)}</Text>
      </Pressable>
      <Text style={styles.line}>{up(t('call.night'))} · {dayLabel(c.night)}</Text>
      <Text style={styles.line}>{up(t('call.host'))} · {host}</Text>
      {c.note ? <Text style={styles.note}>“{c.note}”</Text> : null}
      {invite ? (
        <View style={styles.answer}>
          {invite.mine === 'in' ? <Text style={styles.state}>{t('call.answered.in')}</Text> : invite.mine === 'out' ? <Text style={styles.state}>{t('call.answered.out')}</Text> : null}
          <View style={styles.btns}>
            <View style={styles.btn}><Button label={t('call.in')} kind={invite.mine === 'in' ? 'line' : 'red'} onPress={() => answer('in')} /></View>
            <View style={styles.btn}><Button label={t('call.out')} kind="line" onPress={() => answer('out')} /></View>
          </View>
        </View>
      ) : null}
      <Text style={styles.section}>{up(`${t('call.who')} · ${tn('call.people', c.going)}`)}</Text>
      {people.map((p, i) => (
        <Pressable key={`${p.handle}-${i}`} onPress={() => p.handle && openPerson(p.handle)} style={styles.row}>
          <View style={styles.face}><Avatar name={p.handle ?? '?'} size={30} /></View>
          <Text style={styles.name}>{(p.display_name ?? p.handle ?? '').toLowerCase()}{p.host ? ` · ${t('call.host')}` : ''}</Text>
        </Pressable>
      ))}
      {mine ? <Pressable onPress={off} style={styles.danger}><Text style={styles.dangerText}>{t('call.callOff')}</Text></Pressable> : null}
      {invite ? <Pressable onPress={() => reporting.ask('call', id)} style={styles.danger}><Text style={styles.dangerText}>{t('report.call')}</Text></Pressable> : null}
      {reporting.sheet}
      <Said text={said} bad />
    </StaffPage>
  );
}
const styles = StyleSheet.create({
  title: { fontFamily: fonts.semibold, fontSize: 26, letterSpacing: -0.7, color: colors.paper },
  meta: { fontFamily: fonts.regular, fontSize: 12, color: colors.meta, marginTop: 2 },
  line: { fontFamily: fonts.regular, fontSize: 12, letterSpacing: 1, color: colors.mute, marginTop: 12 },
  note: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 22, color: colors.paper, marginTop: 14 },
  answer: { marginTop: 24, gap: 10 },
  state: { fontFamily: fonts.medium, fontSize: 13, color: colors.spotText },
  btns: { flexDirection: 'row', gap: 10 },
  btn: { flex: 1 },
  section: { fontFamily: fonts.regular, fontSize: 11, letterSpacing: 1.4, color: colors.mute, marginTop: 30, marginBottom: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: colors.ink3 },
  face: { width: 30, height: 30, borderRadius: 15, overflow: 'hidden' },
  name: { fontFamily: fonts.medium, fontSize: 14, color: colors.paper },
  danger: { marginTop: 28, alignSelf: 'flex-start' },
  dangerText: { fontFamily: fonts.regular, fontSize: 13, color: colors.spotText, textDecorationLine: 'underline' },
  pressed: { opacity: 0.6 },
});
