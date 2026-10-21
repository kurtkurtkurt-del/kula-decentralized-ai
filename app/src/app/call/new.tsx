import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import StaffPage, { Field, Said } from '@/components/StaffPage';
import Button from '@/components/Button';
import PickerSheet from '@/components/PickerSheet';
import { useAuth } from '@/auth/AuthContext';
import { callAudience, callCreate, type Audience, type Reach } from '@/data/calls';
import { tonight } from '@/data/coops';
import { kept } from '@/data/friends';
import type { Project } from '@/data/deck';
import { dayLabel } from '@/data/when';
import { invalidate } from '@/lib/offline';
import { serverText } from '@/lib/serverText';
import { upperData, useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';

const nightAfter = (days: number) => {
  const d = new Date(Date.now() - 12 * 3600_000 + days * 86400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// A call: "work on this project with me tonight", sent one, two or three waves of
// friends out. Project from your kept ones, night from the next seven.
export default function NewCallScreen() {
  const { slug: given } = useLocalSearchParams<{ slug?: string }>();
  const { t } = useLang();
  const { session, isAnonymous } = useAuth();
  const [mine, setMine] = useState<Project[]>([]);
  const [slug, setSlug] = useState<string | null>(given ?? null);
  const [night, setNight] = useState(tonight());
  const [reach, setReach] = useState<Reach>(1);
  const [note, setNote] = useState('');
  const [audience, setAudience] = useState<Audience | null>(null);
  const [picking, setPicking] = useState<'project' | 'night' | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  useEffect(() => { kept().then(setMine, () => {}); callAudience().then(setAudience, () => {}); }, []);
  const project = mine.find((p) => p.slug === slug);
  const reached = audience ? [audience.wave1, audience.wave1 + audience.wave2, audience.wave1 + audience.wave2 + audience.wave3][reach - 1] : null;
  const go = () => {
    if (!session || isAnonymous) return router.push('/signup');
    if (!slug) return setSaid(t('call.pick'));
    setSending(true);
    callCreate(slug, night, reach, note.trim() || null).then((id) => { invalidate('calls'); router.replace({ pathname: '/call/[id]', params: { id } }); }, (e) => { setSaid(serverText(e)); setSending(false); });
  };
  const nights = Array.from({ length: 7 }, (_, i) => nightAfter(i));
  return (
    <StaffPage title={t('call.createIt')}>
      <Text style={styles.kicker}>{t('call.kicker')}</Text>
      <Text style={styles.label}>{t('call.pick')}</Text>
      <Pressable onPress={() => setPicking('project')} style={styles.choice}><Text style={[styles.choiceText, !project && styles.placeholder]}>{project ? upperData(project.title) : t('call.pick')}</Text><Text style={styles.chev}>›</Text></Pressable>
      <Text style={styles.label}>{t('call.when')}</Text>
      <Pressable onPress={() => setPicking('night')} style={styles.choice}><Text style={styles.choiceText}>{dayLabel(night)}</Text><Text style={styles.chev}>›</Text></Pressable>
      <Text style={styles.label}>{t('call.wave')}</Text>
      <View style={styles.waves}>
        {([1, 2, 3] as Reach[]).map((r) => (
          <Pressable key={r} onPress={() => setReach(r)} style={[styles.wave, r === reach && styles.waveOn]}><Text style={[styles.waveText, r === reach && styles.waveTextOn]}>{r}</Text></Pressable>
        ))}
        <Text style={styles.reach}>{reached !== null ? (reached ? t('call.wave.reached', { n: reached }) : t('call.emptyWave')) : ''}</Text>
      </View>
      <Field label={t('call.note')} value={note} onChangeText={setNote} placeholder={t('call.note.placeholder')} maxLength={140} />
      <View style={styles.gap}><Button label={sending ? t('call.sending') : session && !isAnonymous ? t('call.createIt') : t('call.signIn')} onPress={go} /></View>
      <Said text={said} bad />
      <PickerSheet open={picking === 'project'} title={t('call.pick')} options={mine.map((p) => ({ id: p.slug, label: p.title, extra: p.model }))} selected={slug} onSelect={(id) => { setSlug(id); setPicking(null); }} onClose={() => setPicking(null)} note={!mine.length ? t('connect.emptyMine') : undefined} />
      <PickerSheet open={picking === 'night'} title={t('call.when')} options={nights.map((n) => ({ id: n, label: dayLabel(n) }))} selected={night} onSelect={(id) => { setNight(id); setPicking(null); }} onClose={() => setPicking(null)} />
    </StaffPage>
  );
}
const styles = StyleSheet.create({
  kicker: { fontFamily: fonts.regular, fontSize: 10, letterSpacing: 1.6, color: colors.spotText, marginBottom: 6 },
  label: { fontFamily: fonts.regular, fontSize: 11, letterSpacing: 1.4, color: colors.mute, marginTop: 20, marginBottom: 8 },
  choice: { height: 50, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.ink3, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  choiceText: { fontFamily: fonts.medium, fontSize: 15, color: colors.paper },
  placeholder: { color: colors.mute },
  chev: { fontFamily: fonts.regular, fontSize: 18, color: colors.meta },
  waves: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  wave: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderColor: colors.ink3, alignItems: 'center', justifyContent: 'center' },
  waveOn: { backgroundColor: colors.spot, borderColor: colors.spot },
  waveText: { fontFamily: fonts.semibold, fontSize: 16, color: colors.paper },
  waveTextOn: { color: colors.ink },
  reach: { flex: 1, fontFamily: fonts.regular, fontSize: 12, color: colors.mute, marginLeft: 6 },
  gap: { marginTop: 24 },
});
