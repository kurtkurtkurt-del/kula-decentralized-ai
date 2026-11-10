import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EdgeBack } from '@/components/BackButton';
import EmptyState from '@/components/EmptyState';
import PickerSheet from '@/components/PickerSheet';
import { useLang } from '@/i18n';
import { chat, useEngine, type Photos, type Reply } from '@/llm/engine';
import { photoSide, photoTurn, useReading, withPhotos, type Seen } from '@/llm/vision';
import { keepChatPhoto, pickPhotos, type PickFrom } from '@/tasks/photos';
import { explain } from '@/llm/errors';
import { tapLight, tapSelect } from '@/lib/haptics';
import type { Message } from '@/llm/native';
import { useSettings } from '@/llm/store';
import { colors, fonts, radius } from '@/theme/tokens';
import { brand } from '@/theme/layout';

// The chat: a streaming reply, stop, new chat; under every reply its numbers (tok/s, first
// token, which device). "batch test" sends eight short prompts to every device at once:
// the small rehearsal of what a kula night does (apart mode). Nothing is kept.
// Photos (10.11.2026): a message can carry up to MAX_PHOTOS photos (kept with the turn, like
// its text; small copies in the cache). llm/vision.ts answers them: a chat model that sees
// photos gets them directly ("seen by"); otherwise the chosen vision model reads them first
// and its words go into the prompt ("read by"). The reading always happens on this phone;
// in apart or split mode only the text goes to the other devices.
type Turn = { role: 'user' | 'assistant'; text: string; stats?: Reply; error?: string; stopped?: boolean; photos?: string[]; seen?: Seen; seenBy?: string };
const MAX_PHOTOS = 3;
/** The conversation as text for the model: earlier photos become the vision model's notes. */
const asMessages = (turns: Turn[]): Message[] => turns.map((x) => ({ role: x.role, content: x.role === 'user' ? withPhotos(x.text, x.photos?.length ?? 0, x.seen) : x.text }));
// qwen3 reasons inside <think>…</think>; shown as a dot until the answer starts, then dropped
const shown = (t: string) => (t.includes('<think>') ? (t.includes('</think>') ? t.slice(t.indexOf('</think>') + 8).trim() : '…') : t);
const r1 = (x: number) => Math.round(x * 10) / 10;
const BATCH = ['name three fruits.', 'what is 17 × 6?', 'one sentence about the sea.', 'translate "good night" to german.', 'a haiku about phones.', 'what colour is the sky at noon?', 'count from one to five.', 'why do cats purr? one line.'];

export default function ChatScreen() {
  const { t, tx, up } = useLang();
  const insets = useSafeAreaInsets();
  const engine = useEngine();
  const settings = useSettings();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [batch, setBatch] = useState<{ n: number; s: number; tps: number; lines: string[] } | null>(null);
  const [photos, setPhotos] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const reading = useReading();
  const running = useRef<ReturnType<typeof chat> | null>(null);
  const scroll = useRef<ScrollView>(null);
  const resetNext = useRef(true);
  // "to the end": shown once the reader has scrolled up out of the tail; streaming does not
  // drag them back down while it is shown
  const [atEnd, setAtEnd] = useState(true);
  const atEndRef = useRef(true);
  const [copied, setCopied] = useState<number | null>(null);
  useEffect(() => {
    if (copied == null) return;
    const id = setTimeout(() => setCopied(null), 1600);
    return () => clearTimeout(id);
  }, [copied]);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const near = contentSize.height - (contentOffset.y + layoutMeasurement.height) < 80;
    atEndRef.current = near;
    if (near !== atEnd) setAtEnd(near);
  };
  const toEnd = () => {
    atEndRef.current = true;
    setAtEnd(true);
    scroll.current?.scrollToEnd({ animated: true });
  };

  // asks the model with `history`, streaming into the last turn; `prior` is the list the
  // turns are rebuilt from (regenerate drops the old answer first)
  const ask = async (history: Message[], prior: Turn[], images?: Photos) => {
    setTurns([...prior, { role: 'assistant', text: '' }]);
    let acc = '';
    try {
      const run = chat(history, (piece) => {
        acc += piece;
        setTurns((xs) => xs.map((x, i) => (i === xs.length - 1 ? { ...x, text: acc } : x)));
        if (atEndRef.current) scroll.current?.scrollToEnd({ animated: false });
      }, { maxTokens: settings.maxTokens, temperature: settings.temperature, reset: resetNext.current || !!images, images });
      resetNext.current = false;
      running.current = run;
      const stats = await run;
      setTurns((xs) => xs.map((x, i) => (i === xs.length - 1 ? { ...x, text: acc, stats, stopped: stats.stopped } : x)));
    } catch (e) {
      setTurns((xs) => xs.map((x, i) => (i === xs.length - 1 ? { ...x, text: acc, error: explain(e, tx) } : x)));
    } finally {
      running.current = null;
    }
  };
  const send = async () => {
    const pics = photos;
    const q = text.trim() || (pics.length ? t('vision.ask') : '');
    if (!q || !engine.load || engine.generating || preparing) return;
    setText('');
    setPhotos([]);
    const mine: Turn = { role: 'user', text: q, ...(pics.length ? { photos: pics } : {}) };
    const history: Message[] = [...asMessages(turns), { role: 'user', content: q }];
    if (!pics.length) return ask(history, [...turns, mine]);
    // photos: read first (or handed to a chat model that sees), then the answer
    setTurns([...turns, mine, { role: 'assistant', text: '' }]);
    setPreparing(true);
    try {
      const p = await photoTurn(history, pics);
      const done: Turn = { ...mine, ...(p.seen ? { seen: p.seen } : { seenBy: engine.model?.name }) };
      if (p.seen) resetNext.current = true; // the vision model may have taken the chat model's place
      await ask(p.messages, [...turns, done], p.images);
    } catch (e) {
      setTurns([...turns, mine, { role: 'assistant', text: '', error: explain(e, tx) }]);
    } finally {
      setPreparing(false);
    }
  };
  const addPhotos = async (from: PickFrom) => {
    try {
      const picked = await pickPhotos(from, MAX_PHOTOS - photos.length);
      const kept: string[] = [];
      for (const p of picked) kept.push(await keepChatPhoto(p));
      if (kept.length) setPhotos((xs) => [...xs, ...kept].slice(0, MAX_PHOTOS));
    } catch (e) {
      setTurns((xs) => [...xs, { role: 'assistant', text: '', error: (e as Error).message === 'denied' ? t('task.f.photos.denied') : explain(e, tx) }]);
    }
  };
  // the last answer again: same question, a fresh draw (the kv cache is rebuilt)
  const again = async () => {
    if (!engine.load || engine.generating) return;
    const last = turns[turns.length - 1];
    const prior = last?.role === 'assistant' ? turns.slice(0, -1) : turns;
    if (!prior.length || prior[prior.length - 1].role !== 'user') return;
    tapSelect();
    resetNext.current = true;
    // a photo the chat model saw itself goes to it again; a read one is in the text already
    const u = prior[prior.length - 1];
    const images = u.photos?.length && !u.seen ? { uris: u.photos, maxSide: photoSide(u.photos.length) } : undefined;
    await ask(asMessages(prior), prior, images);
  };
  const copy = async (i: number, body: string) => {
    tapLight();
    await Clipboard.setStringAsync(body).catch(() => {});
    setCopied(i);
  };
  const stop = () => {
    tapLight();
    running.current?.stop();
  };
  const fresh = () => {
    stop();
    setTurns([]);
    setBatch(null);
    setPhotos([]);
    resetNext.current = true;
  };
  const runBatch = async () => {
    if (!engine.load || engine.generating) return;
    setBatch({ n: 0, s: 0, tps: 0, lines: [] });
    const t0 = Date.now();
    const devices = engine.devices;
    let tokens = 0;
    const lines: string[] = [];
    // one queue per device, prompts handed out round-robin: every device busy at once
    const queues = devices.map((_, i) => BATCH.filter((__, j) => j % devices.length === i));
    await Promise.all(queues.map(async (qs, i) => {
      for (const q of qs) {
        let acc = '';
        try {
          const r = await chat([{ role: 'user', content: engine.model?.id.startsWith('qwen3') ? `${q} /no_think` : q }], (p) => (acc += p), { maxTokens: 64, temperature: 0.7, reset: true, device: devices[i].id });
          tokens += r.tokens;
          lines.push(`${devices[i].name.toLowerCase()} · ${r1(r.tps)} tok/s · ${q} → ${shown(acc).trim().slice(0, 60)}`);
        } catch (e) {
          lines.push(`${devices[i].name.toLowerCase()} · ${explain(e, tx)}`);
        }
        setBatch({ n: lines.length, s: (Date.now() - t0) / 1000, tps: Math.round((tokens / ((Date.now() - t0) / 1000)) * 10) / 10, lines: [...lines] });
      }
    }));
    resetNext.current = true;
  };

  const canSend = !!engine.load && !preparing && (!!text.trim() || photos.length > 0);
  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <EdgeBack />
      <KeyboardAvoidingView style={styles.root} behavior="padding">
        <View style={styles.band}>
          <View style={styles.titleRow}>
            <Text style={styles.title}>{t('chat.title')}</Text>
            {/* talk mode (app/talk.tsx): the same model, spoken to, hands-free */}
            <Pressable onPress={() => { tapLight(); running.current?.stop(); router.push('/talk'); }} accessibilityRole="button" accessibilityLabel={t('voice.chat.talk')} accessibilityHint={t('voice.chat.talkHint')} testID="chat-talk" style={({ pressed }) => [styles.talk, pressed && styles.pressed]}>
              <View style={styles.talkDot} />
              <Text style={styles.talkText}>{t('voice.chat.talk')}</Text>
            </Pressable>
          </View>
          <Text style={styles.sub} numberOfLines={1}>{engine.model ? `${engine.model.name.toLowerCase()} · ${engine.mode} · ${engine.split.map((s) => `${s.name.toLowerCase()} ${s.gb} gb`).join(' · ')}` : ''}</Text>
        </View>
        <View style={styles.root}>
        <ScrollView ref={scroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" onScroll={onScroll} scrollEventThrottle={100} onContentSizeChange={() => (atEndRef.current ? scroll.current?.scrollToEnd({ animated: true }) : null)}>
          {!engine.load ? (
            <EmptyState text={`${t('empty.chat.noModel')} ${t('chat.noModel')}`} action={t('empty.chat.go')} onAction={() => router.replace('/models')} testID="empty-chat" />
          ) : turns.length === 0 && !batch ? (
            <EmptyState text={t('empty.chat', { model: engine.model?.name.toLowerCase() ?? '', where: engine.devices.length > 1 ? t('empty.chat.devices', { n: engine.devices.length }) : t('empty.chat.here') })} />
          ) : null}
          {engine.devices.length > 1 ? (
            <Text style={styles.small}>{up(t('chat.devices'))}: {engine.devices.map((d) => `${d.name.toLowerCase()}${d.busy ? ` (${t('chat.busy')})` : ''}`).join(' · ')}</Text>
          ) : null}
          {turns.map((x, i) => {
            const body = shown(x.text);
            const last = i === turns.length - 1;
            const isReply = x.role === 'assistant';
            return (
              <Pressable key={i} onLongPress={() => body && copy(i, body)} delayLongPress={350} accessibilityRole="text" accessibilityLabel={`${isReply ? t('chat.title') : t('word.you')}: ${body || t('chat.thinking')}`} accessibilityHint={t('chat.holdHint')} accessibilityActions={[{ name: 'copy', label: t('chat.copy') }]} onAccessibilityAction={() => body && copy(i, body)} style={[styles.turn, isReply ? styles.them : styles.me]}>
                {x.photos?.length ? (
                  <View style={styles.pics}>
                    {x.photos.map((uri) => <Image key={uri} source={{ uri }} style={styles.pic} contentFit="cover" accessibilityLabel={t('vision.attach')} />)}
                  </View>
                ) : null}
                <Text style={[styles.text, !isReply && styles.textMe]} selectable>{body || (last && reading ? t('vision.reading', { model: reading.by.toLowerCase() }) : t('chat.thinking'))}</Text>
                {x.seen ? <Text style={styles.by}>{t('vision.readBy', { model: x.seen.by.toLowerCase() })}</Text> : x.seenBy ? <Text style={styles.by}>{t('vision.seenBy', { model: x.seenBy.toLowerCase() })}</Text> : null}
                {isReply && last && reading?.swap ? <Text style={styles.small}>{t('vision.swapping', { model: reading.by.toLowerCase() })}</Text> : null}
                {x.error ? <Text style={styles.err}>{x.error}</Text> : null}
                {x.stats || copied === i || (isReply && last && !engine.generating) ? (
                  <View style={styles.statsRow}>
                    {x.stats ? (
                      <Text style={styles.stats} numberOfLines={2}>
                        <Text style={styles.statBig}>{x.stats.tps.toFixed(1)}</Text> {t('chat.stat.tps')}  ·  {x.stats.firstMs} ms {t('chat.stat.first')}  ·  {x.stats.tokens} {t('chat.stat.tokens')}  ·  {x.stats.device.toLowerCase()}{x.stopped ? `  ·  ${t('chat.stopped')}` : ''}
                      </Text>
                    ) : null}
                    {copied === i ? <Text style={styles.copied} accessibilityLiveRegion="polite">{t('chat.copied')}</Text> : null}
                    {isReply && last && !engine.generating && engine.load ? (
                      <Pressable onPress={again} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('chat.again')} style={styles.againBtn}><Text style={styles.again}>↻ {t('chat.again')}</Text></Pressable>
                    ) : null}
                  </View>
                ) : null}
              </Pressable>
            );
          })}
          {batch ? (
            <View style={styles.batch}>
              <Text style={styles.small}>{up(t('chat.batch'))}</Text>
              <Text style={styles.batchBig}>{t('chat.batchResult', { n: batch.n, s: batch.s.toFixed(1), tps: batch.tps })}</Text>
              {batch.lines.map((l, i) => <Text key={i} style={styles.batchLine}>{l}</Text>)}
            </View>
          ) : null}
        </ScrollView>
        {!atEnd && turns.length > 0 ? (
          <Pressable onPress={toEnd} accessibilityRole="button" accessibilityLabel={t('chat.down')} style={({ pressed }) => [styles.down, pressed && styles.pressed]}>
            <Text style={styles.downText}>↓ {t('chat.down')}</Text>
          </Pressable>
        ) : null}
        </View>
        <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>
          {engine.generating ? (
            <Pressable onPress={stop} accessibilityRole="button" accessibilityLabel={t('a11y.stop')} style={({ pressed }) => [styles.stopBar, pressed && styles.pressed]} testID="chat-stop">
              <Text style={styles.stopText}>■  {t('chat.stop')}</Text>
            </Pressable>
          ) : (
            <View style={styles.tools}>
              <Pressable onPress={fresh} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('chat.new')} style={styles.toolHit}><Text style={styles.tool}>{t('chat.new')}</Text></Pressable>
              <Pressable onPress={() => setPicking(true)} disabled={!engine.load || photos.length >= MAX_PHOTOS || preparing} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('vision.attach')} accessibilityState={{ disabled: !engine.load || photos.length >= MAX_PHOTOS }} style={styles.toolHit} testID="chat-photo"><Text style={[styles.tool, (!engine.load || photos.length >= MAX_PHOTOS) && styles.off]}>+ {t('vision.attach')}</Text></Pressable>
              <Pressable onPress={runBatch} disabled={!engine.load} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('chat.batch')} accessibilityHint={t('chat.batchHint')} accessibilityState={{ disabled: !engine.load }} style={styles.toolHit}><Text style={[styles.tool, !engine.load && styles.off]}>{t('chat.batch')}</Text></Pressable>
            </View>
          )}
          {photos.length ? (
            <View style={styles.pics}>
              {photos.map((uri) => (
                <Pressable key={uri} onPress={() => setPhotos((xs) => xs.filter((p) => p !== uri))} accessibilityRole="button" accessibilityLabel={t('vision.remove')} style={styles.picWrap}>
                  <Image source={{ uri }} style={styles.pic} contentFit="cover" />
                  <Text style={styles.picX}>×</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <View style={styles.inputRow}>
            <TextInput value={text} onChangeText={setText} placeholder={t('chat.placeholder')} placeholderTextColor={colors.meta} multiline style={styles.input} editable={!!engine.load} onSubmitEditing={send} blurOnSubmit accessibilityLabel={t('chat.placeholder')} />
            {engine.generating ? (
              <Pressable onPress={stop} accessibilityRole="button" accessibilityLabel={t('a11y.stop')} style={({ pressed }) => [styles.send, styles.stop, pressed && styles.pressed]}><Text style={[styles.sendText, styles.stopGlyph]}>■</Text></Pressable>
            ) : (
              <Pressable onPress={send} disabled={!canSend} accessibilityRole="button" accessibilityLabel={t('a11y.send')} accessibilityState={{ disabled: !canSend }} style={({ pressed }) => [styles.send, !canSend && styles.off, pressed && styles.pressed]}><Text style={styles.sendText}>↑</Text></Pressable>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
      <PickerSheet open={picking} title={t('vision.attach')} options={[{ id: 'camera', label: t('vision.camera') }, { id: 'library', label: t('vision.library') }]} selected={null} onSelect={(id) => { setPicking(false); void addPhotos(id as PickFrom); }} onClose={() => setPicking(false)} note={engine.devices.length > 1 ? t('vision.local') : undefined} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  band: { paddingTop: brand.top - 8, paddingHorizontal: brand.left, paddingBottom: 10, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  talk: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44, paddingHorizontal: 18, borderRadius: radius.pill, backgroundColor: colors.paper },
  talkDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.spot },
  talkText: { fontFamily: fonts.semibold, fontSize: 14, color: colors.ink, letterSpacing: 0.2 },
  title: { fontFamily: fonts.semibold, fontSize: 30, lineHeight: 32, letterSpacing: -0.9, color: colors.paper },
  sub: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.mute },
  body: { paddingHorizontal: brand.left, paddingVertical: 8, gap: 10 },
  small: { fontFamily: fonts.regular, fontSize: 10, letterSpacing: 1.4, color: colors.mute },
  turn: { maxWidth: '88%', padding: 12, borderRadius: radius.md, gap: 6 },
  me: { alignSelf: 'flex-end', backgroundColor: colors.paper },
  them: { alignSelf: 'flex-start', backgroundColor: colors.ink2 },
  text: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 21, color: colors.paper },
  textMe: { color: colors.ink },
  statsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginTop: 2 },
  stats: { fontFamily: fonts.jet, fontSize: 11, lineHeight: 15, color: colors.mute, flexShrink: 1 },
  statBig: { fontFamily: fonts.jet, fontSize: 12, color: colors.spotText },
  copied: { fontFamily: fonts.medium, fontSize: 11.5, color: colors.spotText },
  againBtn: { minHeight: 32, justifyContent: 'center' },
  again: { fontFamily: fonts.medium, fontSize: 12, color: colors.spotText },
  err: { fontFamily: fonts.medium, fontSize: 12.5, lineHeight: 17, color: colors.violet },
  down: { position: 'absolute', right: brand.left, bottom: 12, minHeight: 36, paddingHorizontal: 14, borderRadius: radius.pill, backgroundColor: colors.paper, justifyContent: 'center', shadowColor: '#000', shadowOpacity: 0.15, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 3 },
  downText: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.ink },
  stopBar: { minHeight: 44, borderRadius: radius.md, backgroundColor: colors.violet, alignItems: 'center', justifyContent: 'center' },
  stopText: { fontFamily: fonts.semibold, fontSize: 14, color: '#fff', letterSpacing: 0.3 },
  stopGlyph: { color: '#fff' },
  toolHit: { minHeight: 36, justifyContent: 'center' },
  batch: { marginTop: 6, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.ink3, gap: 4 },
  batchBig: { fontFamily: fonts.semibold, fontSize: 16, color: colors.paper },
  batchLine: { fontFamily: fonts.regular, fontSize: 11.5, lineHeight: 16, color: colors.mute },
  bottom: { paddingHorizontal: brand.left, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.ink3, gap: 8 },
  tools: { flexDirection: 'row', gap: 18 },
  tool: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.spotText },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  input: { flex: 1, minHeight: 44, maxHeight: 120, paddingVertical: 10, fontFamily: fonts.regular, fontSize: 15, color: colors.paper, borderBottomWidth: 1, borderBottomColor: colors.ink3 },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.paper, alignItems: 'center', justifyContent: 'center' },
  stop: { backgroundColor: colors.violet },
  sendText: { fontFamily: fonts.semibold, fontSize: 18, color: colors.ink },
  off: { opacity: 0.35 },
  pics: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  picWrap: { width: 64, height: 64, borderRadius: radius.sm, overflow: 'hidden', backgroundColor: colors.ink2 },
  pic: { width: 64, height: 64, borderRadius: radius.sm },
  picX: { position: 'absolute', top: 2, right: 6, fontFamily: fonts.semibold, fontSize: 16, color: '#fff' },
  by: { fontFamily: fonts.regular, fontSize: 11, color: colors.meta },
  pressed: { opacity: 0.7 },
});
