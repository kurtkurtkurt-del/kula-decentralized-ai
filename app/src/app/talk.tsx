import { useEffect, useState } from 'react';
import { Animated, Easing, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EdgeBack } from '@/components/BackButton';
import TalkSettings from '@/components/TalkSettings';
import { langNames, useLang } from '@/i18n';
import { tapLight } from '@/lib/haptics';
import { useEngine } from '@/llm/engine';
import { voiceNative } from '@/voice/native';
import { useTalk, type Banner } from '@/voice/useTalk';
import { colors, fonts, night, radius } from '@/theme/tokens';
import { brand } from '@/theme/layout';

// Talk mode (5.11.2026): speak with the phone's own model, hands-free, through the phone or
// any headset (later the glasses clip). A calm dark screen: one large circle that breathes
// while it listens and pulses while it speaks, the words heard and the reply under it, and
// stop · type · settings at the bottom. The loop and the tools are in src/voice/.
const PHASE_COLOR = { idle: night.edge, listening: colors.green, thinking: night.sky2, speaking: colors.gold } as const;

export default function TalkScreen() {
  const { t, up } = useLang();
  const insets = useSafeAreaInsets();
  const engine = useEngine();
  const talk = useTalk();
  const { loop, reply, question, banner, route, settings } = talk;
  const [sheet, setSheet] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // the circle: breathes while listening, pulses while speaking, rests otherwise
  const [pulse] = useState(() => new Animated.Value(0));
  useEffect(() => {
    pulse.stopAnimation();
    pulse.setValue(0);
    if (loop.phase === 'idle') return;
    const ms = loop.phase === 'speaking' ? 520 : loop.phase === 'listening' ? 1400 : 900;
    const anim = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: ms, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0, duration: ms, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    anim.start();
    return () => anim.stop();
  }, [loop.phase, pulse]);
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, loop.phase === 'speaking' ? 1.1 : 1.06] });
  const ring = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.15, 0.45] });

  const press = () => {
    tapLight();
    talk.press();
  };
  const heard = loop.phase === 'listening' ? loop.partial : loop.heard;
  const phaseText = t(`voice.phase.${loop.phase}`);
  const color = PHASE_COLOR[loop.phase];
  const n = voiceNative();
  const headset = route?.connected && route.name ? t('voice.route.headset', { name: route.name.toLowerCase() }) + (route.micRouted ? ` · ${t('voice.route.micOn')}` : '') : t('voice.route.phone');

  return (
    <View style={[styles.root, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 12 }]}>
      <StatusBar style="light" />
      <EdgeBack />
      <View style={styles.top}>
        <Text style={styles.title}>{t('voice.title')}</Text>
        <Text style={styles.meta} numberOfLines={1}>{engine.model ? engine.model.name.toLowerCase() : ''}{n ? `  ·  ${headset}` : ''}</Text>
      </View>

      {!engine.load ? (
        <Pressable onPress={() => router.push('/models')} accessibilityRole="link" style={styles.note}>
          <Text style={styles.noteText}>{t('voice.noEngine')} <Text style={styles.link}>{t('voice.noEngine.go')} ›</Text></Text>
        </Pressable>
      ) : null}

      <View style={styles.middle}>
        <Pressable onPress={press} accessibilityRole="button" accessibilityLabel={phaseText} accessibilityHint={t('voice.hands')} testID="talk-circle" style={styles.circleHit}>
          <Animated.View style={[styles.halo, { borderColor: color, opacity: ring, transform: [{ scale: Animated.multiply(scale, 1.12) }] }]} />
          <Animated.View style={[styles.circle, { backgroundColor: color, transform: [{ scale }] }]} />
        </Pressable>
        <Text style={styles.phase} accessibilityLiveRegion="polite">{phaseText}</Text>
        {question ? <Text style={styles.question}>{up(t('voice.question'))}</Text> : null}
      </View>

      <ScrollView style={styles.words} contentContainerStyle={styles.wordsIn}>
        {heard ? <Text style={styles.heard}><Text style={styles.who}>{t('voice.you')}  </Text>{heard}</Text> : null}
        {reply ? <Text style={styles.reply} selectable><Text style={styles.who}>{t('voice.kula')}  </Text>{reply}</Text> : null}
        {!heard && !reply && loop.phase === 'idle' ? <Text style={styles.hands}>{t('voice.hands')}</Text> : null}
      </ScrollView>

      {banner ? <BannerBox kind={banner} lang={talk.lang} downloading={downloading} onDismiss={talk.dismiss} onAllowMic={talk.allowMic} onOnline={talk.allowOnline} onDownload={async () => { setDownloading(true); await talk.downloadModel(); }} onSettings={() => setSheet(true)} /> : null}

      <Text style={[styles.private, !settings.onDeviceOnly && styles.privateWarn]}>{settings.onDeviceOnly ? t('voice.private.on') : t('voice.private.online')}</Text>

      <View style={styles.bar}>
        <BarButton label={t('voice.stop')} onPress={() => { tapLight(); talk.close(); }} disabled={loop.phase === 'idle'} />
        <BarButton label={t('voice.keyboard')} onPress={() => { talk.close(); router.push('/chat'); }} />
        <BarButton label={t('voice.forget')} onPress={() => { talk.close(); talk.forget(); }} />
        <BarButton label={t('voice.settings')} onPress={() => setSheet(true)} />
      </View>

      <Modal visible={sheet} transparent animationType="slide" onRequestClose={() => setSheet(false)}>
        <Pressable style={styles.dim} onPress={() => setSheet(false)} accessibilityRole="button" accessibilityLabel={t('word.close')} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 20 }]}>
          <Text style={styles.sheetHead}>{up(t('voice.set.title'))}</Text>
          <ScrollView>
            <TalkSettings />
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

function BarButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={8} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled }} style={({ pressed }) => [styles.barBtn, pressed && styles.pressed, disabled && styles.off]}>
      <Text style={styles.barText}>{label}</Text>
    </Pressable>
  );
}

type BannerProps = { kind: Banner; lang: 'en' | 'de' | 'tr'; downloading: boolean; onDismiss: () => void; onAllowMic: () => void; onOnline: () => void; onDownload: () => void; onSettings: () => void };

// What stands between the user and talking, in one line, with the one or two ways out.
function BannerBox({ kind, lang, downloading, onDismiss, onAllowMic, onOnline, onDownload, onSettings }: BannerProps) {
  const { t } = useLang();
  const n = voiceNative();
  let text = '';
  const actions: { label: string; onPress: () => void }[] = [];
  switch (kind) {
    case 'permission':
      text = t('voice.banner.permission');
      actions.push({ label: t('voice.banner.allow'), onPress: onAllowMic });
      break;
    case 'blocked':
      text = t('voice.banner.blocked');
      actions.push({ label: t('voice.banner.openSettings'), onPress: () => Linking.openSettings() });
      break;
    case 'unavailable':
      text = t('voice.banner.unavailable');
      break;
    case 'noOnDevice':
      text = t('voice.banner.noOnDevice');
      actions.push({ label: t('voice.banner.useOnline'), onPress: onOnline });
      break;
    case 'noModel':
      text = downloading ? t('voice.banner.downloading') : t('voice.banner.noModel', { lang: langNames[lang] });
      if (!downloading) actions.push({ label: t('voice.banner.download'), onPress: onDownload });
      actions.push({ label: t('voice.banner.useOnline'), onPress: onOnline });
      break;
    case 'notificationAccess':
      text = t('voice.banner.notificationAccess');
      if (n) actions.push({ label: t('voice.banner.openAccess'), onPress: () => n.openNotificationAccess() });
      actions.push({ label: t('voice.settings'), onPress: onSettings });
      break;
    case 'calendarPermission':
      text = t('voice.banner.calendarPermission');
      actions.push({ label: t('voice.banner.openSettings'), onPress: () => Linking.openSettings() });
      break;
    case 'noEngine':
      text = t('voice.noEngine');
      actions.push({ label: t('voice.noEngine.go'), onPress: () => router.push('/models') });
      break;
  }
  return (
    <View style={styles.banner}>
      <Text style={styles.bannerText}>{text}</Text>
      <View style={styles.bannerRow}>
        {actions.map((a) => (
          <Pressable key={a.label} onPress={a.onPress} accessibilityRole="button" style={({ pressed }) => [styles.bannerBtn, pressed && styles.pressed]}>
            <Text style={styles.bannerBtnText}>{a.label}</Text>
          </Pressable>
        ))}
        <Pressable onPress={onDismiss} accessibilityRole="button" style={({ pressed }) => [styles.bannerBtn, styles.bannerQuiet, pressed && styles.pressed]}>
          <Text style={styles.bannerQuietText}>{t('word.close')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const CIRCLE = 190;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: night.sky0, paddingHorizontal: brand.left },
  top: { gap: 2 },
  title: { fontFamily: fonts.semibold, fontSize: 30, lineHeight: 32, letterSpacing: -0.9, color: night.star },
  meta: { fontFamily: fonts.regular, fontSize: 11.5, color: '#9C8C78' },
  note: { marginTop: 12, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: night.edge },
  noteText: { fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18, color: '#C9BBA6' },
  link: { fontFamily: fonts.medium, color: colors.gold },
  middle: { alignItems: 'center', justifyContent: 'center', paddingTop: 28, paddingBottom: 12, gap: 18 },
  circleHit: { width: CIRCLE * 1.3, height: CIRCLE * 1.3, alignItems: 'center', justifyContent: 'center' },
  halo: { position: 'absolute', width: CIRCLE, height: CIRCLE, borderRadius: CIRCLE / 2, borderWidth: 2 },
  circle: { width: CIRCLE, height: CIRCLE, borderRadius: CIRCLE / 2, opacity: 0.92 },
  phase: { fontFamily: fonts.medium, fontSize: 15, color: night.star, letterSpacing: 0.2 },
  question: { fontFamily: fonts.regular, fontSize: 10.5, letterSpacing: 1.4, color: colors.gold },
  words: { flex: 1 },
  wordsIn: { gap: 12, paddingVertical: 8 },
  who: { fontFamily: fonts.regular, fontSize: 10.5, letterSpacing: 1.2, color: '#8A7B68' },
  heard: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 21, color: '#B9AA95' },
  reply: { fontFamily: fonts.regular, fontSize: 18, lineHeight: 26, color: night.star },
  hands: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: '#8A7B68', textAlign: 'center' },
  banner: { padding: 12, borderRadius: radius.md, backgroundColor: night.phone, gap: 10, marginBottom: 8 },
  bannerText: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: night.star },
  bannerRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  bannerBtn: { minHeight: 36, paddingHorizontal: 12, borderRadius: radius.pill, backgroundColor: night.star, justifyContent: 'center' },
  bannerBtnText: { fontFamily: fonts.medium, fontSize: 12.5, color: night.sky0 },
  bannerQuiet: { backgroundColor: 'transparent', borderWidth: 1, borderColor: night.edge },
  bannerQuietText: { fontFamily: fonts.medium, fontSize: 12.5, color: night.star },
  private: { fontFamily: fonts.regular, fontSize: 11, lineHeight: 15, color: '#8A7B68', textAlign: 'center', marginBottom: 10 },
  privateWarn: { color: colors.gold },
  bar: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  barBtn: { flex: 1, minHeight: 44, borderRadius: radius.pill, borderWidth: 1, borderColor: night.edge, alignItems: 'center', justifyContent: 'center' },
  barText: { fontFamily: fonts.medium, fontSize: 12.5, color: night.star },
  off: { opacity: 0.35 },
  pressed: { opacity: 0.7 },
  dim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { maxHeight: '82%', backgroundColor: colors.ink, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, paddingHorizontal: brand.left, paddingTop: 18 },
  sheetHead: { fontFamily: fonts.regular, fontSize: 10.5, letterSpacing: 1.4, color: colors.meta, marginBottom: 4 },
});
