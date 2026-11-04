import { useMemo, useState } from 'react';
import { Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Button from '@/components/Button';
import PickerSheet from '@/components/PickerSheet';
import StaffPage from '@/components/StaffPage';
import { usePassport, useLinked } from '@/data/passport';
import type { Passport } from '@/passport/contract';
import { useLang } from '@/i18n';
import { catalogById } from '@/llm/catalog';
import { load, unload, useEngine } from '@/llm/engine';
import { defaultCtx, fitOn, fitTogether } from '@/llm/fit';
import { localById, saveSettings, useLocalModels, usePeers, useSettings, type Mode } from '@/llm/store';
import { colors, fonts, radius } from '@/theme/tokens';
import { brand } from '@/theme/layout';

// One model: its numbers, the context size, and "start", which asks how it should run,
// every time (the user's wish, 4.11.2026): only this phone · apart (a copy per device, the
// way kula works at night; beyin's rule) · split (one model across the devices).
const gb = (b: number) => `${(b / 1024 ** 3).toFixed(b < 1024 ** 3 ? 2 : 1)} gb`;
const CTX = [512, 1024, 2048, 4096, 8192, 16384];

export default function ModelScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, tx, up } = useLang();
  const insets = useSafeAreaInsets();
  useLocalModels();
  const settings = useSettings();
  const passport = usePassport();
  const linked = useLinked();
  const peers = usePeers();
  const engine = useEngine();
  const model = localById(decodeURIComponent(id ?? ''));
  const cat = model ? catalogById(model.id) : null;
  const [ctxOpen, setCtxOpen] = useState(false);
  const [ask, setAsk] = useState(false);
  const [shareQ, setShareQ] = useState<Mode | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ctx = settings.ctx;

  const pool: Passport[] = useMemo(() => [...(passport ? [passport] : []), ...linked.map((l) => l.data)], [passport, linked]);
  const fit = model ? fitOn(passport, { size: model.size, kv_mb_per_1k: model.kv_mb_per_1k, ctx }) : null;
  const together = model && pool.length > 1 ? fitTogether(pool, { size: model.size, kv_mb_per_1k: model.kv_mb_per_1k, ctx }) : null;
  const running = !!model && engine.model?.id === model.id && !!engine.load;

  if (!model) {
    return (
      <StaffPage title={t('models.title')}>
        <Text style={styles.note}>{t('models.empty')}</Text>
      </StaffPage>
    );
  }

  const start = async (mode: Mode, share = false) => {
    setAsk(false);
    setShareQ(null);
    setErr(null);
    if (mode !== 'alone' && peers.length === 0) return setErr(t('model.err.nopeers'));
    try {
      await load(model, mode, ctx, mode === 'alone' ? [] : peers, share);
      router.push('/chat');
    } catch (e) {
      const code = (e as Error).message;
      setErr(tx(`model.err.${code}`, code));
    }
  };
  const pick = (mode: Mode) => {
    // split on a model that fits alone: ask whether to keep it here
    if (mode === 'split' && fit && fit.verdict !== 'no') return setShareQ(mode);
    start(mode);
  };

  const rows: [string, string][] = [
    [t('model.size'), `${gb(model.size)} · ${model.params_b}B · ${model.quant}`],
    [t('models.license'), model.license ?? '—'],
    [t('model.ctx'), `${ctx} · ${t('models.fits').toLowerCase()} ≤ ${fit?.maxCtx || '—'}`],
    [t('model.speed'), fit?.tps ? `${fit.tps.low}–${fit.tps.high} tok/s` : '—'],
  ];

  return (
    <StaffPage title={model.name.toLowerCase()}>
      {cat ? <Text style={styles.lede}>{cat.blurb.en}</Text> : null}
      <View style={styles.card}>
        {rows.map(([k, v]) => (
          <View key={k} style={styles.row}><Text style={styles.k}>{k}</Text><Text style={styles.v}>{v}</Text></View>
        ))}
        {fit ? <Text style={[styles.fit, fit.verdict === 'no' && styles.fitNo]}>{fit.verdict === 'fits' ? t('models.fits') : fit.verdict === 'tight' ? t('models.tight') : together && together.verdict !== 'no' ? t('models.together') : t('models.no')} · {t('models.needs', { need: fit.needMb, have: fit.haveMb })}</Text> : null}
        {cat ? <Pressable onPress={() => Linking.openURL(cat.license_url)} hitSlop={8}><Text style={styles.link}>{t('models.license')} ↗</Text></Pressable> : null}
      </View>

      <Pressable onPress={() => setCtxOpen(true)} style={({ pressed }) => [styles.ctxRow, pressed && styles.pressed]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.k}>{t('model.ctx')}</Text>
          <Text style={styles.hint}>{t('model.ctxHint')}</Text>
        </View>
        <Text style={styles.ctxValue}>{ctx} ›</Text>
      </Pressable>
      <PickerSheet open={ctxOpen} title={t('model.ctx')} options={CTX.filter((c) => c <= Math.max(model.ctx_max, 4096)).map((c) => ({ id: String(c), label: String(c), extra: fit && c <= fit.maxCtx ? t('models.fits') : fit && c > fit.maxCtx ? t('models.no') : '' }))} selected={String(ctx)} onSelect={(v) => saveSettings({ ctx: Number(v) })} onClose={() => setCtxOpen(false)} />

      {engine.loading && engine.model?.id === model.id ? <Text style={styles.loading}>{tx(`model.loading.${engine.loading}`, engine.loading)}</Text> : null}
      {err ? <Text style={styles.err}>{err}</Text> : null}
      {running && engine.load ? (
        <View style={styles.card}>
          <Text style={styles.k}>{up(t('model.split'))}</Text>
          <Text style={styles.v}>{t('model.loaded', { s: (engine.load.loadMs / 1000).toFixed(1), layers: engine.load.layers, ctx: engine.load.ctx })}</Text>
          {engine.split.map((s) => <Text key={s.name} style={styles.v}>{s.name.toLowerCase()} · {s.gb} gb</Text>)}
          {engine.plan?.skipped.length ? <Text style={styles.hint}>{t('model.skipped', { list: engine.plan.skipped.map((s) => `${s.peer.name} (${s.why})`).join(', ') })}</Text> : null}
        </View>
      ) : null}

      <View style={styles.actions}>
        {running ? (
          <>
            <Button label={t('model.openChat')} onPress={() => router.push('/chat')} kind="red" />
            <Button label={t('model.stop')} onPress={() => unload()} kind="line" />
          </>
        ) : (
          <Button label={t('model.start')} onPress={() => (fit && fit.maxCtx > 0 && ctx > fit.maxCtx ? saveSettings({ ctx: defaultCtx(fit) }) : null, setAsk(true))} kind="red" />
        )}
      </View>

      {/* the mode question, asked every time */}
      <Modal visible={ask} transparent animationType="fade" onRequestClose={() => setAsk(false)}>
        <Pressable style={styles.dim} onPress={() => setAsk(false)} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 24 }]}>
          <Text style={styles.head}>{up(t('mode.title'))}</Text>
          <Option title={t('mode.alone')} why={t('mode.alone.why')} meta={fit?.tps ? `${fit.tps.low}–${fit.tps.high} tok/s` : ''} off={fit?.verdict === 'no'} onPress={() => pick('alone')} />
          <Option title={t('mode.apart')} why={`${t('mode.apart.why')} ${t('mode.beyin')}`} meta={peers.length ? `${peers.length + 1} × ${fit?.tps ? `${fit.tps.low}–${fit.tps.high}` : '?'} tok/s` : t('mode.needPeers')} off={!peers.length || fit?.verdict === 'no'} onPress={() => pick('apart')} />
          <Option title={t('mode.split')} why={t('mode.split.why')} meta={together?.tps ? `${together.tps.low}–${together.tps.high} tok/s · ${together.shares.map((s) => `${s.name.toLowerCase()} ${(s.mb / 1024).toFixed(1)} gb`).join(' · ')}` : peers.length ? '' : t('mode.needPeers')} off={!peers.length || (!!together && together.verdict === 'no')} onPress={() => pick('split')} />
          {!peers.length ? (
            <Pressable onPress={() => { setAsk(false); router.push('/peers'); }} style={({ pressed }) => [styles.addPeer, pressed && styles.pressed]}>
              <Text style={styles.addPeerText}>{t('mode.addPeer')} ›</Text>
            </Pressable>
          ) : null}
        </View>
      </Modal>
      <Modal visible={!!shareQ} transparent animationType="fade" onRequestClose={() => setShareQ(null)}>
        <Pressable style={styles.dim} onPress={() => setShareQ(null)} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 24 }]}>
          <Text style={styles.head}>{up(t('mode.share'))}</Text>
          <Option title={t('mode.keep')} why={t('mode.alone.why')} onPress={() => start('alone')} />
          <Option title={t('mode.shareAnyway', { n: peers.length })} why={t('mode.split.why')} onPress={() => start('split', true)} />
        </View>
      </Modal>
    </StaffPage>
  );
}

function Option({ title, why, meta, off, onPress }: { title: string; why: string; meta?: string; off?: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} disabled={off} style={({ pressed }) => [styles.opt, off && styles.off, pressed && styles.pressed]}>
      <Text style={styles.optTitle}>{title}</Text>
      <Text style={styles.optWhy}>{why}</Text>
      {meta ? <Text style={styles.optMeta}>{meta}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  lede: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.mute, marginBottom: 8 },
  card: { marginTop: 12, padding: 14, borderRadius: radius.md, backgroundColor: colors.ink2, gap: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  k: { fontFamily: fonts.regular, fontSize: 12, color: colors.mute },
  v: { fontFamily: fonts.medium, fontSize: 13, color: colors.paper, flexShrink: 1, textAlign: 'right' },
  fit: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.spotText, marginTop: 6 },
  fitNo: { color: colors.violet },
  link: { fontFamily: fonts.regular, fontSize: 11, color: colors.meta, marginTop: 4 },
  ctxRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.ink3, marginTop: 8 },
  hint: { fontFamily: fonts.regular, fontSize: 11.5, color: colors.meta, marginTop: 2 },
  ctxValue: { fontFamily: fonts.jet, fontSize: 14, color: colors.paper },
  loading: { fontFamily: fonts.medium, fontSize: 13, color: colors.spotText, marginTop: 14 },
  err: { fontFamily: fonts.medium, fontSize: 13, color: colors.violet, marginTop: 14 },
  note: { fontFamily: fonts.regular, fontSize: 14, color: colors.mute },
  actions: { marginTop: 24, gap: 10 },
  dim: { flex: 1, backgroundColor: 'rgba(255,255,255,0.6)' },
  sheet: { backgroundColor: colors.ink, borderWidth: 1, borderBottomWidth: 0, borderColor: colors.ink3, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, paddingHorizontal: brand.left, paddingTop: 12 },
  head: { fontFamily: fonts.regular, fontSize: 11, letterSpacing: 1.4, color: colors.mute, marginBottom: 6 },
  opt: { paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.ink3, gap: 3 },
  off: { opacity: 0.4 },
  optTitle: { fontFamily: fonts.semibold, fontSize: 16, color: colors.paper },
  optWhy: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.mute, lineHeight: 17 },
  optMeta: { fontFamily: fonts.jet, fontSize: 11, color: colors.spotText, marginTop: 2 },
  addPeer: { paddingVertical: 14 },
  addPeerText: { fontFamily: fonts.medium, fontSize: 14, color: colors.spotText },
  pressed: { opacity: 0.6 },
});
