import { useEffect, useState } from 'react';
import { AppState, StyleSheet, Text } from 'react-native';
import PickerSheet from '@/components/PickerSheet';
import { Panel, Row, Switch, Value } from '@/components/Row';
import { langNames, langs, useLang, type Lang } from '@/i18n';
import { phoneCalendar } from '@/voice/calendar';
import { downloadModel } from '@/voice/listen';
import { voiceNative } from '@/voice/native';
import { LOCALES, RATES, saveVoiceSettings, useVoiceSettings, voiceLang } from '@/voice/settings';
import { colors, fonts } from '@/theme/tokens';

// Talk mode's settings (voice/settings.ts), in settings → talk mode and as the talk screen's
// sheet: on-device only, the voice's language and speed, hands-free, the headset mic, and
// the two accesses the secretary asks for (notification access, the calendar) with their state.
export default function TalkSettings() {
  const { t, lang: appLang } = useLang();
  const s = useVoiceSettings();
  const native = voiceNative();
  const [picking, setPicking] = useState<'lang' | 'rate' | null>(null);
  const [access, setAccess] = useState<boolean | null>(() => (native ? native.notificationAccess() : null));
  const [calendar, setCalendar] = useState<boolean | null>(null);
  const [model, setModel] = useState<'done' | 'started' | 'failed' | null>(null);
  const vlang = voiceLang(s, appLang);

  // the states change in the system's screens: read them again when the app comes back
  useEffect(() => {
    let live = true;
    const readCalendar = () => phoneCalendar.permission(false).then((v) => live && setCalendar(v), () => live && setCalendar(null));
    void readCalendar();
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active') return;
      setAccess(native ? native.notificationAccess() : null);
      void readCalendar();
    });
    return () => {
      live = false;
      sub.remove();
    };
  }, [native]);

  const askCalendar = () => phoneCalendar.permission(true).then(setCalendar, () => setCalendar(false));
  const fetchModel = () => downloadModel(LOCALES[vlang]).then(setModel);

  return (
    <>
      <Text style={styles.hint}>{t('voice.set.lede')}</Text>
      <Panel>
        <Row label={t('voice.set.onDevice')} hint={s.onDeviceOnly ? t('voice.set.onDevice.on') : t('voice.set.onDevice.off')} onPress={() => saveVoiceSettings({ onDeviceOnly: !s.onDeviceOnly })} right={<Switch on={s.onDeviceOnly} />} />
        <Row label={t('voice.set.lang')} onPress={() => setPicking('lang')} right={<Value text={s.lang === 'app' ? t('voice.set.lang.app') : langNames[s.lang]} more />} />
        <Row label={t('voice.set.rate')} onPress={() => setPicking('rate')} right={<Value text={`${s.rate}×`} more />} />
        <Row label={t('voice.set.continuous')} hint={t('voice.set.continuous.hint')} onPress={() => saveVoiceSettings({ continuous: !s.continuous })} right={<Switch on={s.continuous} />} />
        {native ? <Row label={t('voice.set.headset')} hint={t('voice.set.headset.hint')} onPress={() => saveVoiceSettings({ headsetMic: !s.headsetMic })} right={<Switch on={s.headsetMic} />} /> : null}
        <Row label={t('voice.set.model')} hint={t('voice.set.model.hint', { lang: langNames[vlang] })} onPress={fetchModel} right={<Value text={model ? t(`voice.set.model.${model}`) : ''} more />} />
      </Panel>
      <Panel>
        {native ? (
          <>
            <Row label={t('voice.set.access')} hint={t('voice.set.access.hint')} onPress={() => native.openNotificationAccess()} right={<Value text={access ? t('voice.set.on') : t('voice.set.off')} more />} />
            <Row label={t('voice.set.appInfo')} hint={t('voice.set.appInfo.hint')} onPress={() => native.openAppSettings()} right={<Value text="" more />} />
          </>
        ) : null}
        <Row label={t('voice.set.calendar')} hint={t('voice.set.calendar.hint')} onPress={calendar ? undefined : askCalendar} right={<Value text={calendar ? t('voice.set.allowed') : t('voice.set.notAllowed')} more={!calendar} />} />
      </Panel>
      {!native ? <Text style={styles.hint}>{t('voice.set.native')}</Text> : null}

      <PickerSheet open={picking === 'lang'} title={t('voice.set.lang')} options={[{ id: 'app', label: t('voice.set.lang.app') }, ...langs.map((l) => ({ id: l, label: langNames[l], extra: LOCALES[l] }))]} selected={s.lang} onSelect={(id) => saveVoiceSettings({ lang: id as 'app' | Lang })} onClose={() => setPicking(null)} />
      <PickerSheet open={picking === 'rate'} title={t('voice.set.rate')} options={RATES.map((r) => ({ id: String(r), label: `${r}×` }))} selected={String(s.rate)} onSelect={(id) => saveVoiceSettings({ rate: Number(id) })} onClose={() => setPicking(null)} />
    </>
  );
}

const styles = StyleSheet.create({
  hint: { fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18, color: colors.mute, marginTop: 4 },
});
