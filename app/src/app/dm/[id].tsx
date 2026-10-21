import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import BackButton from '@/components/BackButton';
import { Said } from '@/components/StaffPage';
import { useReport } from '@/components/ReportSheet';
import { dmListen, dmSend, dmThread, dmUnsay, dmWaiting, why, type DmLine } from '@/data/dms';
import { markDmSeen } from '@/data/messages';
import { useLang } from '@/i18n';
import { colors, fonts } from '@/theme/tokens';
import { brand } from '@/theme/layout';

// A direct conversation: you and one friend. New lines are read when the channel says
// so (and every 15 s as a fallback); a long press on your own line takes it back, on
// theirs reports it.
export default function DmScreen() {
  const { id, name: given } = useLocalSearchParams<{ id: string; name?: string }>();
  const { t } = useLang();
  const insets = useSafeAreaInsets();
  const [name, setName] = useState(given ?? '');
  const [lines, setLines] = useState<DmLine[]>([]);
  const [text, setText] = useState('');
  const [said, setSaid] = useState<string | null>(null);
  const last = useRef(0);
  const scroll = useRef<ScrollView>(null);
  const more = useCallback(
    () =>
      dmThread(id, last.current).then((got) => {
        if (!got.length) return;
        last.current = got[got.length - 1].id;
        markDmSeen(id, last.current);
        const theirs = got.find((l) => !l.mine);
        if (theirs?.name) setName(theirs.name.toLowerCase());
        setLines((l) => [...l, ...got.filter((g) => !l.some((x) => x.id === g.id))]);
      }, (e) => setSaid(why(e))),
    [id],
  );
  useEffect(() => {
    more();
    const stop = dmListen(id, more);
    const timer = setInterval(more, 15000);
    return () => {
      stop();
      clearInterval(timer);
    };
  }, [id, more]);
  const [waiting, setWaiting] = useState(() => dmWaiting(id));
  const send = () => {
    const body = text.trim();
    if (!body) return;
    setText('');
    dmSend(id, body).then((sent) => (sent === null ? setWaiting(dmWaiting(id)) : more()), (e) => { setText(body); setSaid(why(e)); });
  };
  const drop = (l: DmLine) =>
    Alert.alert(t('staff.delete'), t('dm.delete'), [
      { text: t('staff.delete.keep'), style: 'cancel' },
      { text: t('staff.delete'), style: 'destructive', onPress: () => dmUnsay(l.id).then(() => setLines((x) => x.filter((y) => y.id !== l.id)), () => {}) },
    ]);
  const reporting = useReport();
  const time = (iso: string) => iso.slice(11, 16);
  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <View style={styles.band}><Text style={styles.title} numberOfLines={1}>{name || t('messages.title')}</Text></View>
      <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView ref={scroll} contentContainerStyle={styles.body} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}>
          {!lines.length ? <Text style={styles.quiet}>{t('messages.dm.none')}</Text> : null}
          {lines.map((l) =>
            l.mine ? (
              <Pressable key={l.id} onLongPress={() => drop(l)} style={styles.mineWrap}>
                <View style={styles.bubbleMine}><Text style={styles.textMine}>{l.body}</Text></View>
                <Text style={styles.metaMine}>{time(l.created_at)}</Text>
              </Pressable>
            ) : (
              <Pressable key={l.id} onLongPress={() => reporting.ask('dm', String(l.id))} style={styles.theirsWrap}>
                <View style={styles.bubble}><Text style={styles.text}>{l.body}</Text></View>
                <Text style={styles.metaSmall}>{time(l.created_at)}</Text>
              </Pressable>
            ),
          )}
          {waiting.map((w) => (
            <View key={w.id} style={styles.mineWrap}>
              <View style={[styles.bubbleMine, { opacity: 0.5 }]}><Text style={styles.textMine}>{w.body}</Text></View>
              <Text style={styles.metaMine}>{t('offline.waiting')}</Text>
            </View>
          ))}
          <Said text={said} bad />
        </ScrollView>
        {reporting.sheet}
        <View style={[styles.input, { paddingBottom: insets.bottom + 10 }]}>
          <View style={styles.pill}>
            <TextInput value={text} onChangeText={setText} placeholder={t('dm.say')} placeholderTextColor={colors.mute} selectionColor={colors.spot} maxLength={1000} multiline style={styles.pillInput} />
            <Pressable onPress={send} style={({ pressed }) => [styles.send, !text.trim() && styles.sendOff, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={t('dm.send')}>
              <Text style={styles.sendText}>↑</Text>
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
      <BackButton lift={70} />
    </View>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  band: { position: 'absolute', top: 0, left: 0, right: 0, height: brand.top + 40, backgroundColor: colors.ink, zIndex: 2 },
  title: { position: 'absolute', top: brand.top, left: brand.left + 40, right: brand.left + 40, textAlign: 'center', fontFamily: fonts.medium, fontSize: brand.smallSize, letterSpacing: -0.3, color: colors.paper },
  body: { paddingTop: brand.top + 52, paddingHorizontal: brand.left, paddingBottom: 16, gap: 12 },
  quiet: { fontFamily: fonts.regular, fontSize: 13, color: colors.mute, textAlign: 'center', marginTop: 40 },
  theirsWrap: { alignSelf: 'flex-start', gap: 3, maxWidth: '80%' },
  bubble: { alignSelf: 'flex-start', backgroundColor: colors.ink2, borderRadius: 18, borderBottomLeftRadius: 5, paddingHorizontal: 13, paddingVertical: 9 },
  mineWrap: { alignSelf: 'flex-end', alignItems: 'flex-end', gap: 3, maxWidth: '80%' },
  bubbleMine: { backgroundColor: colors.spot, borderRadius: 18, borderBottomRightRadius: 5, paddingHorizontal: 13, paddingVertical: 9 },
  metaSmall: { fontFamily: fonts.regular, fontSize: 10, color: colors.meta, marginLeft: 4 },
  metaMine: { fontFamily: fonts.regular, fontSize: 10, color: colors.meta, marginRight: 4 },
  text: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 21, color: colors.paper },
  textMine: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 21, color: colors.ink },
  input: { paddingHorizontal: 10, paddingTop: 8, backgroundColor: colors.ink },
  pill: { flexDirection: 'row', alignItems: 'flex-end', minHeight: 46, borderRadius: 23, borderWidth: 1, borderColor: colors.ink3, paddingLeft: 16, paddingRight: 5, paddingVertical: 5 },
  pillInput: { flex: 1, fontFamily: fonts.regular, fontSize: 15, color: colors.paper, maxHeight: 110, paddingTop: 8, paddingBottom: 8 },
  send: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.spot, alignItems: 'center', justifyContent: 'center' },
  sendOff: { opacity: 0.35 },
  sendText: { fontFamily: fonts.semibold, fontSize: 18, color: colors.ink },
  pressed: { opacity: 0.6 },
});
