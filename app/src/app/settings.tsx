import { useState } from 'react';
import { Alert, Linking, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import Constants from 'expo-constants';
import StaffPage, { Field, Said } from '@/components/StaffPage';
import Button from '@/components/Button';
import LangRow from '@/components/LangRow';
import PickerSheet from '@/components/PickerSheet';
import { Panel, Row, Section, Switch, Value } from '@/components/Row';
import { useAuth } from '@/auth/AuthContext';
import { useProfile } from '@/data/profile';
import { MIN_BATTERY_CHOICES, exportToFile, nightRules, saveNightRules, saveProfile, saveSettings } from '@/data/settings';
import { useCities } from '@/data/cities';
import { SITE } from '@/data/projects';
import { invalidate } from '@/lib/offline';
import { serverText } from '@/lib/serverText';
import { useRefreshOnFocus } from '@/hooks/useRefresh';
import { useLang } from '@/i18n';
import { DEMO } from '@/lib/supabase';
import { saveSettings as saveLlmSettings, useSettings as useLlmSettings } from '@/llm/store';
import { relayUrlOf } from '@/llm/peers';
import { colors, fonts } from '@/theme/tokens';

const HOURS = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);

// Settings: the night window (when the phone may work, wi-fi only), the profile
// (name, handle, city, bio), what you get told about, privacy, language, account.
export default function SettingsScreen() {
  const { t } = useLang();
  const { session, isAnonymous, isDemo, signOut } = useAuth();
  const tick = useRefreshOnFocus('profile');
  const profile = useProfile(tick);
  const { cities } = useCities();
  const [picking, setPicking] = useState<'from' | 'to' | 'city' | 'battery' | null>(null);
  // the night's local rules (night-2): on charge only, the battery threshold
  const [rules, setRules] = useState(nightRules);
  const setRule = (patch: Parameters<typeof saveNightRules>[0]) => { saveNightRules(patch); setRules(nightRules()); };
  // the relay "share far away" and "add by code" use (docs/RELAY.md); kept on this phone only
  const llm = useLlmSettings();
  const [relay, setRelay] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [bio, setBio] = useState('');
  const [city, setCity] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  // a guest (anonymous, or the shared demo account) counts as signed in: every page opens
  // as it does for an account; making a real one is the one thing only offered here
  const member = !!session;
  const guest = !session || isAnonymous || isDemo;
  const flip = (k: 'wifi_only' | 'discoverable' | 'notify_friends' | 'notify_calls' | 'notify_coops' | 'notify_dms' | 'notify_cards') =>
    profile && saveSettings({ [k]: !profile[k] }).catch((e) => setSaid(serverText(e)));
  const startEdit = () => {
    setName(profile?.display_name ?? '');
    setHandle(profile?.handle ?? '');
    setBio(profile?.bio ?? '');
    setCity(profile?.city_slug ?? null);
    setEditing(true);
  };
  const save = () =>
    saveProfile({ handle: handle.trim().toLowerCase(), name: name.trim(), city, bio: bio.trim() }).then((r) => {
      if (r === 'ok') { invalidate('profile'); setEditing(false); setSaid(null); } else setSaid(t(`settings.handle.${r}` as never));
    }, (e) => setSaid(serverText(e)));
  const leave = () =>
    Alert.alert(t('settings.leave'), t('settings.leave.body'), [{ text: t('settings.leave.stay'), style: 'cancel' }, { text: t('settings.leave.go'), style: 'destructive', onPress: () => signOut().then(() => router.replace('/')) }]);
  const exportMe = () => exportToFile().catch(() => Alert.alert(t('settings.export.failed')));
  const cityName = cities.find((c) => c.id === (editing ? city : profile?.city_slug))?.name;
  return (
    <StaffPage title={t('settings.title')}>
      <Section title={t('settings.night')} />
      <Text style={styles.hint}>{t('night.window', { from: profile?.night_from?.slice(0, 5) ?? '23:00', to: profile?.night_to?.slice(0, 5) ?? '07:30' })}</Text>
      <Panel>
        <Row label={t('settings.night.from')} onPress={() => setPicking('from')} right={<Value text={profile?.night_from?.slice(0, 5) ?? '23:00'} more />} />
        <Row label={t('settings.night.to')} onPress={() => setPicking('to')} right={<Value text={profile?.night_to?.slice(0, 5) ?? '07:30'} more />} />
        <Row label={t('settings.night.wifi')} hint={t('settings.night.wifi.hint')} onPress={() => flip('wifi_only')} right={<Switch on={profile?.wifi_only ?? true} />} />
        <Row label={t('settings.night.charge')} hint={t('settings.night.charge.hint')} onPress={() => setRule({ chargeOnly: !rules.chargeOnly })} right={<Switch on={rules.chargeOnly} />} />
        <Row label={t('settings.night.battery')} hint={t('settings.night.battery.hint')} onPress={() => setPicking('battery')} right={<Value text={`${rules.minBattery} %`} more />} />
        <Row label={t('settings.night.report')} onPress={() => router.push('/night/report')} right={<Value text="" more />} />
      </Panel>

      <Section title={t('settings.profile')} />
      {member && !editing ? (
        <Panel>
          <Row label={t('settings.name')} right={<Value text={profile?.display_name ?? '—'} />} />
          <Row label={t('settings.handle')} right={<Value text={profile?.handle ? `@${profile.handle}` : '—'} />} />
          <Row label={t('settings.city')} right={<Value text={cityName ?? profile?.city_name ?? t('settings.city.none')} />} />
          <Row label={t('settings.edit')} onPress={startEdit} right={<Value text="" more />} />
        </Panel>
      ) : null}
      {member && editing ? (
        <View>
          <Field label={t('settings.name')} value={name} onChangeText={setName} placeholder={t('settings.name.placeholder')} maxLength={40} />
          <Field label={t('settings.handle')} value={handle} onChangeText={setHandle} autoCapitalize="none" autoCorrect={false} maxLength={24} />
          <Text style={styles.hint}>{t('settings.handle.about')}</Text>
          <Panel><Row label={t('settings.city')} onPress={() => setPicking('city')} right={<Value text={cityName ?? t('settings.city.none')} more />} /></Panel>
          <Field label={t('settings.bio')} value={bio} onChangeText={setBio} placeholder={t('settings.bio.placeholder')} maxLength={140} multiline />
          <View style={styles.btns}>
            <View style={styles.btn}><Button label={t('settings.save')} onPress={save} /></View>
            <View style={styles.btn}><Button label={t('word.cancel')} kind="line" onPress={() => setEditing(false)} /></View>
          </View>
        </View>
      ) : null}

      {member ? (
        <>
          <Section title={t('notify.title')} />
          <Panel>
            <Row label={t('notify.friends')} hint={t('notify.friends.hint')} onPress={() => flip('notify_friends')} right={<Switch on={!!profile?.notify_friends} />} />
            <Row label={t('notify.calls')} hint={t('notify.calls.hint')} onPress={() => flip('notify_calls')} right={<Switch on={!!profile?.notify_calls} />} />
            <Row label={t('notify.coops')} hint={t('notify.coops.hint')} onPress={() => flip('notify_coops')} right={<Switch on={!!profile?.notify_coops} />} />
            <Row label={t('notify.dms')} hint={t('notify.dms.hint')} onPress={() => flip('notify_dms')} right={<Switch on={!!profile?.notify_dms} />} />
            <Row label={t('notify.cards')} hint={t('notify.cards.hint')} onPress={() => flip('notify_cards')} right={<Switch on={!!profile?.notify_cards} />} />
          </Panel>
          <Section title={t('settings.privacy')} />
          <Panel>
            <Row label={t('settings.kept')} hint={profile?.kept_visibility === 'private' ? t('settings.vis.private') : t('settings.vis.friends')} onPress={() => saveSettings({ kept_visibility: profile?.kept_visibility === 'private' ? 'friends' : 'private' })} right={<Switch on={profile?.kept_visibility !== 'private'} />} />
            <Row label={t('settings.findable')} hint={t('settings.findable.hint')} onPress={() => flip('discoverable')} right={<Switch on={!!profile?.discoverable} />} />
            <Row label={t('block.list')} onPress={() => router.push('/blocks')} right={<Value text="" more />} />
          </Panel>
        </>
      ) : null}

      <Section title={t('settings.app')} />
      <LangRow />
      <Panel>
        <Row label={t('settings.bench')} hint={t('settings.bench.hint')} onPress={() => router.push('/bench')} right={<Value text="" more />} />
        <Row label={t('settings.web')} hint={t('settings.web.hint')} onPress={() => Linking.openURL(SITE)} right={<Value text="" more />} />
        <Row label={t('settings.server')} hint={DEMO ? t('settings.server.demo') : undefined} right={<Value text={DEMO ? 'demo' : 'live'} />} />
        <Row label={t('settings.version')} right={<Value text={Constants.expoConfig?.version ?? '0'} />} />
        <Row label={t('audit.title')} hint={t('audit.hint')} onPress={() => router.push('/audit')} right={<Value text="" more />} />
      </Panel>
      <Field label={t('settings.relay')} value={relay ?? llm.relayUrl} onChangeText={setRelay} onBlur={() => { if (relay !== null) { saveLlmSettings({ relayUrl: relay.trim() ? relayUrlOf(relay) : '' }); setRelay(null); } }} placeholder="wss://relay.example" autoCapitalize="none" autoCorrect={false} keyboardType="url" />
      <Text style={styles.hint}>{t('settings.relay.hint')}</Text>

      <Section title={t('settings.account')} />
      <Panel>
        {member ? <Row label={t('settings.export')} hint={t('settings.export.hint')} onPress={exportMe} right={<Value text="" more />} /> : null}
        {guest ? <Row label={t('settings.makeAccount')} hint={t('settings.guest.hint')} onPress={() => router.push({ pathname: '/signup', params: { mode: 'up' } })} right={<Value text="" more />} /> : null}
        {guest ? <Row label={t('word.signin')} onPress={() => router.push({ pathname: '/signup', params: { mode: 'in' } })} right={<Value text="" more />} /> : null}
        {session ? <Row label={t('settings.leave')} hint={t('settings.leave.hint')} onPress={leave} danger /> : null}
      </Panel>
      <Said text={said} bad />

      <PickerSheet open={picking === 'from' || picking === 'to'} title={t(picking === 'to' ? 'settings.night.to' : 'settings.night.from')} options={HOURS.map((h) => ({ id: h, label: h }))} selected={(picking === 'to' ? profile?.night_to : profile?.night_from)?.slice(0, 5) ?? null} onSelect={(h) => { saveSettings(picking === 'to' ? { night_to: h } : { night_from: h }).catch((e) => setSaid(serverText(e))); setPicking(null); }} onClose={() => setPicking(null)} />
      <PickerSheet open={picking === 'battery'} title={t('settings.night.battery')} options={MIN_BATTERY_CHOICES.map((n) => ({ id: String(n), label: `${n} %` }))} selected={String(rules.minBattery)} onSelect={(id) => { setRule({ minBattery: Number(id) }); setPicking(null); }} onClose={() => setPicking(null)} />
      <PickerSheet open={picking === 'city'} title={t('settings.city')} options={cities.map((c) => ({ id: c.id, label: c.name, extra: c.country.toUpperCase() }))} selected={city} onSelect={(id) => { setCity(id); setPicking(null); }} onClose={() => setPicking(null)} note={t('settings.city.hint')} />
    </StaffPage>
  );
}
const styles = StyleSheet.create({
  hint: { fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18, color: colors.mute, marginTop: 4 },
  btns: { flexDirection: 'row', gap: 10, marginTop: 18 },
  btn: { flex: 1 },
});
