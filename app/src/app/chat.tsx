import { useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EdgeBack } from '@/components/BackButton';
import { useLang } from '@/i18n';
import { chat, useEngine, type Reply } from '@/llm/engine';
import type { Message } from '@/llm/native';
import { useSettings } from '@/llm/store';
import { colors, fonts, radius } from '@/theme/tokens';
import { brand } from '@/theme/layout';

// The chat: a streaming reply, stop, new chat; under every reply its numbers (tok/s, first
// token, which device). "batch test" sends eight short prompts to every device at once:
// the small rehearsal of what a kula night does (apart mode). Nothing is kept.
type Turn = { role: 'user' | 'assistant'; text: string; stats?: Reply };
// qwen3 reasons inside <think>…</think>; shown as a dot until the answer starts, then dropped
const shown = (t: string) => (t.includes('<think>') ? (t.includes('</think>') ? t.slice(t.indexOf('</think>') + 8).trim() : '…') : t);
const r1 = (x: number) => Math.round(x * 10) / 10;
const BATCH = ['name three fruits.', 'what is 17 × 6?', 'one sentence about the sea.', 'translate "good night" to german.', 'a haiku about phones.', 'what colour is the sky at noon?', 'count from one to five.', 'why do cats purr? one line.'];

export default function ChatScreen() {
  const { t, up } = useLang();
  const insets = useSafeAreaInsets();
  const engine = useEngine();
  const settings = useSettings();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [batch, setBatch] = useState<{ n: number; s: number; tps: number; lines: string[] } | null>(null);
  const running = useRef<ReturnType<typeof chat> | null>(null);
  const scroll = useRef<ScrollView>(null);
  const resetNext = useRef(true);

  const send = async () => {
    const q = text.trim();
    if (!q || !engine.load || engine.generating) return;
    setText('');
    const history: Message[] = [...turns.map((x) => ({ role: x.role, content: x.text })), { role: 'user', content: q }];
    setTurns((xs) => [...xs, { role: 'user', text: q }, { role: 'assistant', text: '' }]);
    let acc = '';
    try {
      const run = chat(history, (piece) => {
        acc += piece;
        setTurns((xs) => xs.map((x, i) => (i === xs.length - 1 ? { ...x, text: acc } : x)));
        scroll.current?.scrollToEnd({ animated: false });
      }, { maxTokens: settings.maxTokens, temperature: settings.temperature, reset: resetNext.current });
      resetNext.current = false;
      running.current = run;
      const stats = await run;
      setTurns((xs) => xs.map((x, i) => (i === xs.length - 1 ? { ...x, text: acc, stats } : x)));
    } catch (e) {
      setTurns((xs) => xs.map((x, i) => (i === xs.length - 1 ? { ...x, text: `${acc}\n— ${(e as Error).message}` } : x)));
    } finally {
      running.current = null;
    }
  };
  const stop = () => running.current?.stop();
  const fresh = () => {
    stop();
    setTurns([]);
    setBatch(null);
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
          lines.push(`${devices[i].name.toLowerCase()} · ${(e as Error).message}`);
        }
        setBatch({ n: lines.length, s: (Date.now() - t0) / 1000, tps: Math.round((tokens / ((Date.now() - t0) / 1000)) * 10) / 10, lines: [...lines] });
      }
    }));
    resetNext.current = true;
  };

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <EdgeBack />
      <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.band}>
          <Text style={styles.title}>{t('chat.title')}</Text>
          <Text style={styles.sub} numberOfLines={1}>{engine.model ? `${engine.model.name.toLowerCase()} · ${engine.mode} · ${engine.split.map((s) => `${s.name.toLowerCase()} ${s.gb} gb`).join(' · ')}` : ''}</Text>
        </View>
        <ScrollView ref={scroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
          {!engine.load ? (
            <Pressable onPress={() => router.replace('/models')}><Text style={styles.note}>{t('chat.noModel')} ›</Text></Pressable>
          ) : null}
          {engine.devices.length > 1 ? (
            <Text style={styles.small}>{up(t('chat.devices'))}: {engine.devices.map((d) => `${d.name.toLowerCase()}${d.busy ? ` (${t('chat.busy')})` : ''}`).join(' · ')}</Text>
          ) : null}
          {turns.map((x, i) => (
            <View key={i} style={[styles.turn, x.role === 'user' ? styles.me : styles.them]}>
              <Text style={[styles.text, x.role === 'user' && styles.textMe]}>{shown(x.text) || t('chat.thinking')}</Text>
              {x.stats ? <Text style={styles.stats}>{t('chat.stats', { tps: x.stats.tps.toFixed(1), first: x.stats.firstMs, n: x.stats.tokens, device: x.stats.device.toLowerCase() })}</Text> : null}
            </View>
          ))}
          {batch ? (
            <View style={styles.batch}>
              <Text style={styles.small}>{up(t('chat.batch'))}</Text>
              <Text style={styles.batchBig}>{t('chat.batchResult', { n: batch.n, s: batch.s.toFixed(1), tps: batch.tps })}</Text>
              {batch.lines.map((l, i) => <Text key={i} style={styles.batchLine}>{l}</Text>)}
            </View>
          ) : null}
        </ScrollView>
        <View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }]}>
          <View style={styles.tools}>
            <Pressable onPress={fresh} hitSlop={8}><Text style={styles.tool}>{t('chat.new')}</Text></Pressable>
            <Pressable onPress={runBatch} disabled={!engine.load || engine.generating} hitSlop={8}><Text style={[styles.tool, (!engine.load || engine.generating) && styles.off]}>{t('chat.batch')}</Text></Pressable>
          </View>
          <View style={styles.inputRow}>
            <TextInput value={text} onChangeText={setText} placeholder={t('chat.placeholder')} placeholderTextColor={colors.meta} multiline style={styles.input} editable={!!engine.load} onSubmitEditing={send} blurOnSubmit />
            {engine.generating ? (
              <Pressable onPress={stop} style={({ pressed }) => [styles.send, styles.stop, pressed && styles.pressed]}><Text style={styles.sendText}>■</Text></Pressable>
            ) : (
              <Pressable onPress={send} disabled={!engine.load || !text.trim()} style={({ pressed }) => [styles.send, (!engine.load || !text.trim()) && styles.off, pressed && styles.pressed]}><Text style={styles.sendText}>↑</Text></Pressable>
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  band: { paddingTop: brand.top - 8, paddingHorizontal: brand.left, paddingBottom: 10, gap: 2 },
  title: { fontFamily: fonts.semibold, fontSize: 30, lineHeight: 32, letterSpacing: -0.9, color: colors.paper },
  sub: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.meta },
  body: { paddingHorizontal: brand.left, paddingVertical: 8, gap: 10 },
  note: { fontFamily: fonts.medium, fontSize: 14, color: colors.spotText },
  small: { fontFamily: fonts.regular, fontSize: 10, letterSpacing: 1.4, color: colors.meta },
  turn: { maxWidth: '88%', padding: 12, borderRadius: radius.md, gap: 6 },
  me: { alignSelf: 'flex-end', backgroundColor: colors.paper },
  them: { alignSelf: 'flex-start', backgroundColor: colors.ink2 },
  text: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 21, color: colors.paper },
  textMe: { color: colors.ink },
  stats: { fontFamily: fonts.jet, fontSize: 10, color: colors.spotText },
  batch: { marginTop: 6, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.ink3, gap: 4 },
  batchBig: { fontFamily: fonts.semibold, fontSize: 16, color: colors.paper },
  batchLine: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.mute },
  bottom: { paddingHorizontal: brand.left, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.ink3, gap: 8 },
  tools: { flexDirection: 'row', gap: 18 },
  tool: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.spotText },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 10 },
  input: { flex: 1, minHeight: 44, maxHeight: 120, paddingVertical: 10, fontFamily: fonts.regular, fontSize: 15, color: colors.paper, borderBottomWidth: 1, borderBottomColor: colors.ink3 },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.paper, alignItems: 'center', justifyContent: 'center' },
  stop: { backgroundColor: colors.violet },
  sendText: { fontFamily: fonts.semibold, fontSize: 18, color: colors.ink },
  off: { opacity: 0.35 },
  pressed: { opacity: 0.7 },
});
