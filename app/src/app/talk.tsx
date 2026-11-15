import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path, Rect } from 'react-native-svg';
import { EdgeBack } from '@/components/BackButton';
import EmptyState from '@/components/EmptyState';
import PillAction from '@/components/PillAction';
import TalkSettings from '@/components/TalkSettings';
import { langNames, useLang } from '@/i18n';
import { tapLight } from '@/lib/haptics';
import { useEngine } from '@/llm/engine';
import { voiceNative } from '@/voice/native';
import { saveVoiceSettings } from '@/voice/settings';
import { noticeOf } from '@/voice/notice';
import { useTalk, type Banner } from '@/voice/useTalk';
import { colors, fonts, radius } from '@/theme/tokens';
import { brand, MAX_WIDTH } from '@/theme/layout';

// Talk mode (5.11.2026; laid out like the chat 15.11.2026): speak with the model and the
// phone's secretary, hands-free, through the phone or any headset. The same page as the chat:
// the title band, the conversation as bubbles, and at the bottom the one round button that
// listens (it breathes while listening, pulses while speaking), new conversation · type ·
// settings, and the line that says what stays on this phone. The loop and the tools are in
// src/voice/.
const PHASE_COLOR = { idle: colors.paper, listening: colors.spot, thinking: colors.paper2, speaking: colors.gold } as const;

export default function TalkScreen() {
  const { t, up } = useLang();
  const insets = useSafeAreaInsets();
  const engine = useEngine();
  const talk = useTalk();
  const { loop, turns, question, banner, route, settings } = talk;
  const [sheet, setSheet] = useState(false);
  const scroll = useRef<ScrollView>(null);

  // the button: breathes while listening, pulses while speaking, rests otherwise
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
  const halo = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, loop.phase === 'speaking' ? 1.35 : 1.22] });
  const haloOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] });

  const press = () => {
    tapLight();
    talk.press();
  };
  const active = loop.phase !== 'idle';
  const phaseText = t(`voice.phase.${loop.phase}`);
  const color = PHASE_COLOR[loop.phase];
  const n = voiceNative();
  const headset = route?.connected && route.name ? t('voice.route.headset', { name: route.name.toLowerCase() }) + (route.micRouted ? ` · ${t('voice.route.micOn')}` : '') : t('voice.route.phone');
  const sub = [engine.model?.name.toLowerCase(), n ? headset : null].filter(Boolean).join('  ·  ');
  const partial = loop.phase === 'listening' ? loop.partial : '';

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <EdgeBack />
      <View style={styles.band}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>{t('voice.title')}</Text>
          {/* the language you speak, in sight: it is often not the app's (an english app, a turkish voice) */}
          <View style={styles.langs} accessibilityRole="radiogroup">
            {(['tr', 'en', 'de'] as const).map((l) => (
              <Pressable key={l} onPress={() => { tapLight(); talk.close(); saveVoiceSettings({ lang: l }); }} accessibilityRole="radio" accessibilityState={{ checked: talk.lang === l }} accessibilityLabel={langNames[l]} hitSlop={6} style={({ pressed }) => [styles.lang, talk.lang === l && styles.langOn, pressed && styles.pressed]}>
                <Text style={[styles.langText, talk.lang === l && styles.langTextOn]}>{l}</Text>
              </Pressable>
            ))}
          </View>
        </View>
        {sub ? <Text style={styles.sub} numberOfLines={1}>{sub}</Text> : null}
      </View>

      <ScrollView ref={scroll} style={styles.flex} contentContainerStyle={styles.body} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })} testID="talk-turns">
        {!engine.load ? (
          <EmptyState text={t('voice.noEngine')} action={t('voice.noEngine.go')} onAction={() => router.push('/models')} testID="talk-no-engine" />
        ) : turns.length === 0 && !partial ? (
          <EmptyState text={t('voice.hands')} />
        ) : null}
        {turns.map((x) => {
          const me = x.who === 'you';
          return (
            <View key={x.id} style={[styles.turn, me ? styles.me : styles.them]} accessible accessibilityLabel={`${me ? t('voice.you') : t('voice.kula')}: ${x.text || t('voice.phase.thinking')}`}>
              <Text style={[styles.text, me && styles.textMe, x.error && styles.err]} selectable>{x.text || '…'}</Text>
            </View>
          );
        })}
        {partial ? (
          <View style={[styles.turn, styles.me, styles.live]}>
            <Text style={[styles.text, styles.textMe]}>{partial}</Text>
          </View>
        ) : null}
      </ScrollView>

      <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>
        {banner ? <Notice kind={banner} lang={talk.lang} onDismiss={talk.dismiss} onAllowMic={talk.allowMic} onOnline={talk.allowOnline} onDownload={() => void talk.downloadModel()} onRetry={talk.retry} onSettings={() => setSheet(true)} /> : null}

        <View style={styles.control}>
          <Pressable onPress={press} accessibilityRole="button" accessibilityLabel={phaseText} accessibilityHint={t('voice.hands')} testID="talk-circle" style={({ pressed }) => [styles.hit, pressed && styles.pressedBtn]}>
            <Animated.View pointerEvents="none" style={[styles.halo, { backgroundColor: color, opacity: active ? haloOpacity : 0, transform: [{ scale: halo }] }]} />
            <View style={[styles.circle, { backgroundColor: color }]}>
              {loop.phase === 'idle' || loop.phase === 'listening' ? <Mic /> : <StopGlyph />}
            </View>
          </Pressable>
          <View style={styles.phaseBox}>
            <Text style={styles.phase} accessibilityLiveRegion="polite">{phaseText}</Text>
            {question ? <Text style={styles.question}>{up(t('voice.question'))}</Text> : null}
          </View>
        </View>

        {active || question ? (
          <Pressable onPress={() => { tapLight(); talk.close(); }} accessibilityRole="button" accessibilityLabel={t('voice.stop')} style={({ pressed }) => [styles.stopBar, pressed && styles.pressed]} testID="talk-stop">
            <Text style={styles.stopText}>■  {t('voice.stop')}</Text>
          </Pressable>
        ) : (
          <View style={styles.tools}>
            <Pressable onPress={() => { tapLight(); talk.forget(); }} disabled={!turns.length} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('voice.forget')} accessibilityState={{ disabled: !turns.length }} style={styles.toolHit} testID="talk-forget"><Text style={[styles.tool, !turns.length && styles.off]}>{t('voice.forget')}</Text></Pressable>
            {/* the chat this page was opened from, not a second one on top of it */}
            <Pressable onPress={() => router.dismissTo('/chat')} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('voice.keyboard')} style={styles.toolHit} testID="talk-type"><Text style={styles.tool}>{t('voice.keyboard')}</Text></Pressable>
            <Pressable onPress={() => setSheet(true)} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('voice.settings')} style={styles.toolHit} testID="talk-settings"><Text style={styles.tool}>{t('voice.settings')}</Text></Pressable>
          </View>
        )}

        <Text style={[styles.private, !settings.onDeviceOnly && styles.privateWarn]} testID="talk-private">{settings.onDeviceOnly ? t('voice.private.on') : t('voice.private.online')}</Text>
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

function Mic() {
  return (
    <Svg width={28} height={28} viewBox="0 0 24 24">
      <Rect x={9} y={3} width={6} height={11} rx={3} fill={colors.ink} />
      <Path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" stroke={colors.ink} strokeWidth={1.8} strokeLinecap="round" fill="none" />
    </Svg>
  );
}
function StopGlyph() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
      <Rect x={6} y={6} width={12} height={12} rx={2} fill={colors.ink} />
    </Svg>
  );
}

type NoticeProps = { kind: Banner; lang: 'en' | 'de' | 'tr'; onDismiss: () => void; onAllowMic: () => void; onOnline: () => void; onDownload: () => void; onRetry: () => void; onSettings: () => void };

function Notice({ kind, lang, onDismiss, onAllowMic, onOnline, onDownload, onRetry, onSettings }: NoticeProps) {
  const { t } = useLang();
  const n = voiceNative();
  const { text, actions } = noticeOf(kind);
  const run = {
    allowMic: onAllowMic,
    openSettings: () => void Linking.openSettings(),
    online: onOnline,
    download: onDownload,
    retry: onRetry,
    openAccess: () => n?.openNotificationAccess(),
    settings: onSettings,
  } as const;
  const shown = actions.filter((a) => a.go !== 'openAccess' || n);
  return (
    <View style={styles.notice} accessibilityRole="alert" testID={`talk-banner-${kind}`}>
      <Text style={styles.noticeText}>{t(text, { lang: langNames[lang] })}</Text>
      <View style={styles.noticeRow}>
        {shown.map((a, i) => (
          <Pressable key={a.go} onPress={run[a.go]} accessibilityRole="button" accessibilityLabel={t(a.label)} style={({ pressed }) => [styles.noticeBtn, i > 0 && styles.noticeBtnQuiet, pressed && styles.pressed]}>
            <Text style={[styles.noticeBtnText, i > 0 && styles.noticeBtnTextQuiet]}>{t(a.label)}</Text>
          </Pressable>
        ))}
        <PillAction label={t('word.close')} icon="close" small onPress={onDismiss} />
      </View>
    </View>
  );
}

const SIZE = 64;
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  flex: { flex: 1 },
  band: { paddingTop: brand.top - 8, paddingHorizontal: brand.left, paddingBottom: 10, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: { fontFamily: fonts.semibold, fontSize: 30, lineHeight: 32, letterSpacing: -0.9, color: colors.paper },
  sub: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.mute },
  langs: { flexDirection: 'row', gap: 6 },
  lang: { minWidth: 40, height: 32, paddingHorizontal: 10, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.ink3, alignItems: 'center', justifyContent: 'center' },
  langOn: { backgroundColor: colors.paper, borderColor: colors.paper },
  langText: { fontFamily: fonts.medium, fontSize: 13, color: colors.paper },
  langTextOn: { color: colors.ink },
  body: { paddingHorizontal: brand.left, paddingVertical: 8, gap: 10 },
  turn: { maxWidth: '88%', padding: 12, borderRadius: radius.md },
  me: { alignSelf: 'flex-end', backgroundColor: colors.paper },
  them: { alignSelf: 'flex-start', backgroundColor: colors.ink2 },
  live: { opacity: 0.6 },
  text: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 21, color: colors.paper },
  textMe: { color: colors.ink },
  err: { color: colors.violet },
  bottom: { paddingHorizontal: brand.left, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.ink3, gap: 10 },
  notice: { padding: 14, borderRadius: radius.md, backgroundColor: colors.ink2, gap: 10 },
  noticeText: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.paper2 },
  noticeRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 },
  noticeBtn: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: colors.paper },
  noticeBtnQuiet: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.paper },
  noticeBtnText: { fontFamily: fonts.medium, fontSize: 13.5, color: colors.ink },
  noticeBtnTextQuiet: { color: colors.paper },
  control: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  hit: { width: SIZE + 16, height: SIZE + 16, alignItems: 'center', justifyContent: 'center' },
  halo: { position: 'absolute', width: SIZE, height: SIZE, borderRadius: SIZE / 2 },
  circle: { width: SIZE, height: SIZE, borderRadius: SIZE / 2, alignItems: 'center', justifyContent: 'center' },
  phaseBox: { flex: 1, gap: 4 },
  phase: { fontFamily: fonts.medium, fontSize: 15, lineHeight: 20, color: colors.paper },
  question: { fontFamily: fonts.regular, fontSize: 10.5, letterSpacing: 1.4, color: colors.spotText },
  stopBar: { minHeight: 44, borderRadius: radius.md, backgroundColor: colors.violet, alignItems: 'center', justifyContent: 'center' },
  stopText: { fontFamily: fonts.semibold, fontSize: 14, color: '#fff', letterSpacing: 0.3 },
  tools: { flexDirection: 'row', gap: 18, minHeight: 44, alignItems: 'center' },
  toolHit: { minHeight: 36, justifyContent: 'center' },
  tool: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.spotText },
  private: { fontFamily: fonts.regular, fontSize: 11, lineHeight: 15, color: colors.mute },
  privateWarn: { color: colors.violet },
  off: { opacity: 0.35 },
  pressed: { opacity: 0.7 },
  pressedBtn: { opacity: 0.85, transform: [{ scale: 0.97 }] },
  dim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { marginTop: 'auto', alignSelf: 'center', width: '100%', maxWidth: MAX_WIDTH, maxHeight: '82%', backgroundColor: colors.ink, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, paddingHorizontal: brand.left, paddingTop: 18 },
  sheetHead: { fontFamily: fonts.regular, fontSize: 10.5, letterSpacing: 1.4, color: colors.meta, marginBottom: 4 },
});
