import { useMemo, useState } from 'react';
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Button from '@/components/Button';
import DownloadCard from '@/components/DownloadCard';
import PickerSheet from '@/components/PickerSheet';
import StaffPage from '@/components/StaffPage';
import { usePassport, useLinked } from '@/data/passport';
import type { Passport } from '@/passport/contract';
import { useLang } from '@/i18n';
import { catalogById } from '@/llm/catalog';
import { explain } from '@/llm/errors';
import { tapSelect } from '@/lib/haptics';
import { describe, downloadOf, startDownload, useDownloads } from '@/llm/store';
import { load, unload, useEngine } from '@/llm/engine';
import { defaultCtx, fitOn, fitTogether } from '@/llm/fit';
import { localById, saveSettings, useLocalModels, usePeers, useSettings, type LocalModel, type Mode } from '@/llm/store';
import { colors, fonts, radius } from '@/theme/tokens';
import { brand } from '@/theme/layout';

// One model: its numbers, the context size, and "start", which asks how it should run,
// every time (the user's wish, 4.11.2026): only this phone · apart (a copy per device, the
// way kula works at night; beyin's rule) · split (one model across the devices).
const gb = (b: number) => `${(b / 1024 ** 3).toFixed(b < 1024 ** 3 ? 2 : 1)} gb`;
const CTX = [512, 1024, 2048, 4096, 8192, 16384];

export default function ModelScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, tx, up, lang } = useLang();
  const insets = useSafeAreaInsets();
  useLocalModels();
  const settings = useSettings();
  const passport = usePassport();
  const linked = useLinked();
  const peers = usePeers();
  const engine = useEngine();
  useDownloads();
  const wanted = decodeURIComponent(id ?? '');
  const local = localById(wanted);
  const cat = catalogById(local?.id ?? wanted);
  // a catalog model not on the phone yet: the same page, with a download button in place of start
  const model: LocalModel | null = local ?? (cat ? { ...describe(cat), path: '', added_at: '' } : null);
  const onPhone = !!local;
  const dl = downloadOf(wanted);
  const L = (lang === 'tr' || lang === 'de' ? lang : 'en') as 'en' | 'de' | 'tr';
  const [ctxOpen, setCtxOpen] = useState(false);
  const [ask, setAsk] = useState(false);
  const [shareQ, setShareQ] = useState<Mode | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picked, setPicked] = useState<Mode>(settings.lastMode);
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
    if (!onPhone) return;
    setShareQ(null);
    setErr(null);
    if (mode !== 'alone' && peers.length === 0) return setErr(t('err.nopeers'));
    try {
      await load(model, mode, ctx, mode === 'alone' ? [] : peers, share);
      router.push('/chat');
    } catch (e) {
      setErr(explain(e, tx));
    }
  };
  const pick = (mode: Mode) => {
    tapSelect();
    setPicked(mode);
  };
  const go = () => {
    const mode = picked;
    // split on a model that fits alone: ask whether to keep it here
    if (mode === 'split' && fit && fit.verdict !== 'no') return setShareQ(mode);
    // choosing split is choosing to share: the planner's live free-RAM figure can say "fits
    // alone" where the passport said no, and must not quietly keep every layer here
    start(mode, mode === 'split');
  };
  // what each card says (5.11.2026): an estimate, a fit, one line of why, and, when it is
  // off, the reason
  const est = (f: { tps?: { low: number; high: number } | null } | null) => (f?.tps ? t('mode.est', { low: f.tps.low, high: f.tps.high }) : t('mode.estUnknown'));
  const fitWord = (v: 'fits' | 'tight' | 'no' | undefined) => (v === 'fits' ? t('mode.fit.fits') : v === 'tight' ? t('mode.fit.tight') : v === 'no' ? t('mode.fit.no') : '');
  const splitOff = !peers.length ? t('mode.off.noPeers') : together && together.verdict === 'no' ? t('mode.off.toobig') : null;
  const apartOff = !peers.length ? t('mode.off.noPeers') : null;
  const cards: { mode: Mode; title: string; why: string; est: string; fit: string; off: string | null }[] = [
    { mode: 'alone', title: t('mode.alone'), why: fit?.verdict === 'no' ? t('mode.tryAnyway') : t('mode.alone.why'), est: est(fit), fit: fitWord(fit?.verdict), off: null },
    { mode: 'apart', title: t('mode.apart'), why: t('mode.apart.why'), est: peers.length ? `${t('mode.devices', { n: peers.length + 1 })} × ${est(fit)}` : est(fit), fit: fitWord(fit?.verdict), off: apartOff },
    { mode: 'split', title: t('mode.split'), why: t('mode.split.why'), est: together ? `${est(together)} · ${together.shares.map((s) => `${s.name.toLowerCase()} ${(s.mb / 1024).toFixed(1)} gb`).join(' · ')}` : est(null), fit: together ? (together.verdict === 'no' ? t('mode.fit.no') : t('mode.fit.together')) : '', off: splitOff },
  ];
  const pickedOff = cards.find((c) => c.mode === picked)?.off ?? null;

  const rows: [string, string][] = [
    [t('model.size'), `${gb(model.size)} · ${model.params_b}B · ${model.quant}`],
    [t('models.license'), model.license ?? '—'],
    [t('model.ctx'), `${ctx} · ${t('models.fits').toLowerCase()} ≤ ${fit?.maxCtx || '—'}`],
    [t('model.speed'), fit?.tps ? `${fit.tps.low}–${fit.tps.high} tok/s` : '—'],
  ];

  return (
    <StaffPage title={model.name.toLowerCase()}>
      {cat ? <Text style={styles.lede}>{cat.blurb[L]}</Text> : null}
      {cat ? (
        <View style={styles.about}>
          <Text style={styles.aboutK}>{up(t('model.good'))}</Text>
          <Text style={styles.aboutV}>{cat.good[L]}</Text>
          <Text style={styles.aboutK}>{up(t('model.use'))}</Text>
          <Text style={styles.aboutV}>{cat.use[L]}</Text>
        </View>
      ) : null}
      <View style={styles.card}>
        {rows.map(([k, v]) => (
          <View key={k} style={styles.row}><Text style={styles.k}>{k}</Text><Text style={styles.v}>{v}</Text></View>
        ))}
        {fit ? <Text style={[styles.fit, fit.verdict === 'no' && styles.fitNo]}>{fit.verdict === 'fits' ? t('models.fits') : fit.verdict === 'tight' ? t('models.tight') : together && together.verdict !== 'no' ? t('models.together') : t('models.no')} · {t('models.needs', { need: fit.needMb, have: fit.haveMb })}</Text> : null}
        {cat ? <Pressable onPress={() => Linking.openURL(cat.license_url)} hitSlop={12} accessibilityRole="link" accessibilityLabel={t('a11y.license')} style={styles.linkHit}><Text style={styles.link}>{t('models.license')} ↗</Text></Pressable> : null}
      </View>

      <Pressable onPress={() => setCtxOpen(true)} accessibilityRole="button" accessibilityLabel={`${t('model.ctx')}: ${ctx}`} accessibilityHint={t('model.ctxHint')} style={({ pressed }) => [styles.ctxRow, pressed && styles.pressed]}>
        <View style={{ flex: 1 }}>
          <Text style={styles.k}>{t('model.ctx')}</Text>
          <Text style={styles.hint}>{t('model.ctxHint')}</Text>
        </View>
        <Text style={styles.ctxValue}>{ctx} ›</Text>
      </Pressable>
      <PickerSheet open={ctxOpen} title={t('model.ctx')} options={CTX.filter((c) => c <= Math.max(model.ctx_max, 4096)).map((c) => ({ id: String(c), label: String(c), extra: fit && c <= fit.maxCtx ? t('models.fits') : fit && c > fit.maxCtx ? t('models.no') : '' }))} selected={String(ctx)} onSelect={(v) => saveSettings({ ctx: Number(v) })} onClose={() => setCtxOpen(false)} />

      {engine.loading && engine.model?.id === model.id ? <Text style={styles.loading} accessibilityLiveRegion="polite">{tx(`model.loading.${engine.loading}`, engine.loading)}</Text> : null}
      {err ? <Text style={styles.err} accessibilityLiveRegion="assertive" accessibilityRole="alert">{err}</Text> : null}
      {running && engine.load ? (
        <View style={styles.card}>
          <Text style={styles.k}>{up(t('model.split'))}</Text>
          <Text style={styles.v}>{t('model.loaded', { s: (engine.load.loadMs / 1000).toFixed(1), layers: engine.load.layers, ctx: engine.load.ctx })}</Text>
          {engine.split.map((s) => <Text key={s.name} style={styles.v}>{s.name.toLowerCase()} · {s.gb} gb</Text>)}
          {engine.plan?.skipped.length ? <Text style={styles.hint}>{t('model.skipped', { list: engine.plan.skipped.map((s) => `${s.peer.name} (${s.why})`).join(', ') })}</Text> : null}
        </View>
      ) : null}

      <View style={styles.actions}>
        {!onPhone ? (
          dl ? (
            <DownloadCard d={dl} />
          ) : (
            <Button label={`${t('models.download')} · ${gb(model.size)}`} onPress={() => { tapSelect(); startDownload(describe(cat!)).catch((e) => setErr(explain(e, tx))); }} kind="red" />
          )
        ) : running ? (
          <>
            <Button label={t('model.openChat')} onPress={() => router.push('/chat')} kind="red" />
            <Button label={t('model.stop')} onPress={() => unload()} kind="line" />
          </>
        ) : (
          <Button label={t('model.start')} onPress={() => (fit && ctx > Math.max(fit.maxCtx, 1024) ? saveSettings({ ctx: fit.maxCtx > 0 ? defaultCtx(fit) : 1024 }) : null, setAsk(true))} kind="red" />
        )}
      </View>

      {/* the mode question, asked every time: three cards, the chosen one lit, one start */}
      <Modal visible={ask} transparent animationType="fade" onRequestClose={() => setAsk(false)}>
        <Pressable style={styles.dim} onPress={() => setAsk(false)} accessibilityRole="button" accessibilityLabel={t('a11y.close')} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 24 }]} accessibilityViewIsModal>
          <Text style={styles.head}>{up(t('mode.title'))}</Text>
          <ScrollView style={styles.cards} contentContainerStyle={styles.cardsIn} showsVerticalScrollIndicator={false} accessibilityRole="radiogroup">
            {cards.map((c) => <ModeCard key={c.mode} {...c} on={picked === c.mode} onPress={() => pick(c.mode)} />)}
          </ScrollView>
          {!peers.length ? (
            <Pressable onPress={() => { setAsk(false); router.push('/peers'); }} accessibilityRole="button" accessibilityLabel={t('mode.addPeer')} style={({ pressed }) => [styles.addPeer, pressed && styles.pressed]}>
              <Text style={styles.addPeerText}>{t('mode.addPeer')} ›</Text>
            </Pressable>
          ) : null}
          <View style={styles.sheetActions}>
            <Button label={`${t('mode.go')} · ${cards.find((c) => c.mode === picked)?.title ?? ''}`} onPress={pickedOff ? undefined : go} kind="red" disabled={!!pickedOff} accessibilityHint={pickedOff ?? undefined} />
          </View>
        </View>
      </Modal>
      <Modal visible={!!shareQ} transparent animationType="fade" onRequestClose={() => setShareQ(null)}>
        <Pressable style={styles.dim} onPress={() => setShareQ(null)} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + 24 }]}>
          <Text style={styles.head}>{up(t('mode.share'))}</Text>
          <ModeCard mode="alone" title={t('mode.keep')} why={t('mode.alone.why')} est={est(fit)} fit={fitWord(fit?.verdict)} off={null} on onPress={() => start('alone')} />
          <ModeCard mode="split" title={t('mode.shareAnyway', { n: peers.length })} why={t('mode.split.why')} est={est(together)} fit={together ? t('mode.fit.together') : ''} off={null} on={false} onPress={() => start('split', true)} />
        </View>
      </Modal>
    </StaffPage>
  );
}

function ModeCard({ title, why, est, fit, off, on, onPress }: { mode: Mode; title: string; why: string; est: string; fit: string; off: string | null; on: boolean; onPress: () => void }) {
  const { t } = useLang();
  const label = [title, fit, est, off ?? ''].filter(Boolean).join(', ');
  return (
    <Pressable onPress={onPress} disabled={!!off} accessibilityRole="radio" accessibilityState={{ selected: on, checked: on, disabled: !!off }} accessibilityLabel={label} style={({ pressed }) => [styles.card2, on && styles.card2On, off && styles.off, pressed && styles.pressed]}>
      <View style={styles.cardTop}>
        <View style={[styles.radio, on && styles.radioOn]}>{on ? <View style={styles.radioDot} /> : null}</View>
        <Text style={[styles.optTitle, on && styles.optTitleOn]} numberOfLines={2}>{title}</Text>
      </View>
      <View style={styles.cardMeta}>
        {fit ? <Text style={[styles.pill, fit === t('mode.fit.no') ? styles.pillNo : styles.pillOk]}>{fit}</Text> : null}
        <Text style={styles.optMeta} numberOfLines={2}>{est}</Text>
      </View>
      <Text style={styles.optWhy}>{off ?? why}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  lede: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.mute, marginBottom: 8 },
  about: { gap: 4, marginTop: 4 },
  aboutK: { fontFamily: fonts.regular, fontSize: 10, letterSpacing: 1.4, color: colors.spotText, marginTop: 10 },
  aboutV: { fontFamily: fonts.regular, fontSize: 14.5, lineHeight: 21, color: colors.paper },
  card: { marginTop: 12, padding: 14, borderRadius: radius.md, backgroundColor: colors.ink2, gap: 6 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  k: { fontFamily: fonts.regular, fontSize: 12, color: colors.mute },
  v: { fontFamily: fonts.medium, fontSize: 13, color: colors.paper, flexShrink: 1, textAlign: 'right' },
  fit: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.spotText, marginTop: 6 },
  fitNo: { color: colors.violet },
  link: { fontFamily: fonts.regular, fontSize: 11, color: colors.mute, marginTop: 4 },
  ctxRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14, minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.ink3, marginTop: 8 },
  hint: { fontFamily: fonts.regular, fontSize: 11.5, lineHeight: 15, color: colors.mute, marginTop: 2 },
  ctxValue: { fontFamily: fonts.jet, fontSize: 14, color: colors.paper },
  loading: { fontFamily: fonts.medium, fontSize: 13, color: colors.spotText, marginTop: 14 },
  err: { fontFamily: fonts.medium, fontSize: 13, color: colors.violet, marginTop: 14 },
  note: { fontFamily: fonts.regular, fontSize: 14, color: colors.mute },
  actions: { marginTop: 24, gap: 10 },
  dim: { flex: 1, backgroundColor: 'rgba(255,255,255,0.6)' },
  sheet: { backgroundColor: colors.ink, borderWidth: 1, borderBottomWidth: 0, borderColor: colors.ink3, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, paddingHorizontal: brand.left, paddingTop: 12 },
  head: { fontFamily: fonts.regular, fontSize: 11, letterSpacing: 1.4, color: colors.mute, marginBottom: 6 },
  cards: { maxHeight: 420 },
  cardsIn: { gap: 8, paddingTop: 4 },
  card2: { padding: 14, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.ink3, backgroundColor: colors.ink2, gap: 8, minHeight: 44 },
  card2On: { borderColor: colors.spot, backgroundColor: colors.ink },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: colors.mute, alignItems: 'center', justifyContent: 'center' },
  radioOn: { borderColor: colors.spot },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.spot },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  pill: { fontFamily: fonts.medium, fontSize: 10.5, letterSpacing: 0.4, color: colors.ink, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, overflow: 'hidden' },
  pillOk: { backgroundColor: colors.green },
  pillNo: { backgroundColor: colors.mute },
  off: { opacity: 0.45 },
  optTitle: { fontFamily: fonts.semibold, fontSize: 16, color: colors.paper, flexShrink: 1 },
  optTitleOn: { color: colors.paper },
  optWhy: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.paper2, lineHeight: 17 },
  optMeta: { fontFamily: fonts.jet, fontSize: 11, lineHeight: 15, color: colors.spotText, flexShrink: 1 },
  sheetActions: { marginTop: 12 },
  linkHit: { minHeight: 32, justifyContent: 'center' },
  addPeer: { paddingVertical: 14, minHeight: 44, justifyContent: 'center' },
  addPeerText: { fontFamily: fonts.medium, fontSize: 14, color: colors.spotText },
  pressed: { opacity: 0.6 },
});
