import { useEffect, useMemo, useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import DownloadCard from '@/components/DownloadCard';
import EmptyState from '@/components/EmptyState';
import PickerSheet from '@/components/PickerSheet';
import PullDownScroll from '@/components/PullDownScroll';
import StepBar from '@/components/StepBar';
import { useTabBarSpace } from '@/components/TabBar';
import { usePassport, useLinked } from '@/data/passport';
import type { Passport } from '@/passport/contract';
import { useLang } from '@/i18n';
import { CATALOG, type CatalogModel } from '@/llm/catalog';
import { useEngine } from '@/llm/engine';
import { explain } from '@/llm/errors';
import { fitOn, fitTogether, type Fit } from '@/llm/fit';
import { FILE_FILTERS, HfError, SUGGESTED_QUERIES, ggufFiles, hfUrl, isSplit, kvGuess, licenseUrl, paramsOf, quantOf, repoUrl, searchGguf, type HfFile, type HfRepo } from '@/llm/hf';
import { KEEP_FREE, freeDiskBytes } from '@/llm/disk';
import { hasNative, llama } from '@/llm/native';
import { describe, forgetModel, forgetUnused, initStore, rememberQuery, saveSettings, startDownload, unusedModels, useDownloads, useHfHistory, useLocalModels, usePeers, useSettings, useUxFlags, type LocalModel } from '@/llm/store';
import { tapSelect } from '@/lib/haptics';
import { colors, fonts, radius } from '@/theme/tokens';
import { brand } from '@/theme/layout';

// The models tab (4.11.2026): what is on this phone, what
// would fit it (the chosen list, sorted by the passport), and a Hugging Face search. A
// download is verified by sha256 and continues after a kill. "run" opens the model page,
// where the mode (alone · apart · split) is asked every time.
const gb = (b: number) => `${(b / 1024 ** 3).toFixed(b < 1024 ** 3 ? 2 : 1)} gb`;
const gb1 = (b: number) => (b / 1024 ** 3).toFixed(1);

export default function ModelsScreen() {
  const insets = useSafeAreaInsets();
  const tabSpace = useTabBarSpace();
  const { t, tx, up, lang } = useLang();
  const passport = usePassport();
  const linked = useLinked();
  const peers = usePeers();
  const local = useLocalModels();
  const downloads = useDownloads();
  const settings = useSettings();
  const engine = useEngine();
  const ux = useUxFlags();
  const [disk, setDisk] = useState<number | null>(null);
  const [arm, setArm] = useState(true);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [repos, setRepos] = useState<HfRepo[] | null>(null);
  const [pick, setPick] = useState<{ repo: HfRepo; files: HfFile[] } | null>(null);
  const [hfErr, setHfErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const history = useHfHistory();
  const used = local.reduce((a, m) => a + m.size, 0);
  const unused = unusedModels().length;

  useEffect(() => {
    initStore().then((info) => {
      if (!info) return;
      const free = freeDiskBytes();
      setDisk(free !== null ? Math.round(free / 1048576) : info.freeDiskMb);
      setArm(info.available);
    }).catch(() => {});
  }, [downloads.length, local.length]);

  // the passports split mode could pool: this phone plus the connected ones that are peers too
  const pool: Passport[] = useMemo(() => {
    const ids = new Set(peers.map((p) => p.id));
    const theirs = linked.filter((l) => peers.some((p) => p.passport && (p.passport as Passport).device_id === l.data.device_id) || ids.size === 0).map((l) => l.data);
    return [...(passport ? [passport] : []), ...theirs];
  }, [passport, linked, peers]);

  const rows = useMemo(() => {
    const list = CATALOG.map((m) => {
      const f = fitOn(passport, { size: m.size, kv_mb_per_1k: m.kv_mb_per_1k, ctx: 2048 });
      const tog = pool.length > 1 && f.verdict === 'no' ? fitTogether(pool, { size: m.size, kv_mb_per_1k: m.kv_mb_per_1k, ctx: 2048 }) : null;
      return { m, f, tog, rank: f.verdict === 'fits' ? 0 : f.verdict === 'tight' ? 1 : tog && tog.verdict !== 'no' ? 2 : 3 };
    });
    // without a passport nothing fits on paper: small first, so the first download is a sure one
    return list.sort((a, b) => a.rank - b.rank || (passport ? b.m.params_b - a.m.params_b : a.m.params_b - b.m.params_b));
  }, [passport, pool]);

  const hfFail = (e: unknown) => setHfErr(e instanceof HfError ? t(`models.err.${e.code}`) : t('models.err.http'));
  const search = async (text = q) => {
    text = text.trim();
    if (!text) return;
    setQ(text);
    setBusy(true);
    setHfErr(null);
    try {
      setRepos(await searchGguf(text));
      rememberQuery(text);
    } catch (e) {
      setRepos([]);
      hfFail(e);
    } finally {
      setBusy(false);
    }
  };
  const readLicense = (repo: HfRepo) => Linking.openURL(licenseUrl(repo.id, repo.license));
  const openRepo = async (repo: HfRepo) => {
    // a gated repo cannot be fetched without a token: explain, offer the browser, no file list
    if (repo.gated) return Alert.alert(t('models.gated'), t('models.gatedWhy'), [{ text: t('models.cancel'), style: 'cancel' }, { text: t('models.licenseRead'), onPress: () => readLicense(repo) }, { text: t('models.open'), onPress: () => Linking.openURL(repoUrl(repo.id)) }]);
    setBusy(true);
    setHfErr(null);
    try {
      setPick({ repo, files: await ggufFiles(repo.id) });
    } catch (e) {
      hfFail(e);
    } finally {
      setBusy(false);
    }
  };
  /** False when the file would leave less than 200 mb; says how much is missing. */
  const roomFor = (size: number) => {
    const free = freeDiskBytes() ?? (disk !== null ? disk * 1048576 : null);
    if (free === null || free - size >= KEEP_FREE) return true;
    Alert.alert(t('models.noDisk'), t('models.noDiskFor', { need: gb1(size + KEEP_FREE), free: gb1(free) }));
    return false;
  };
  const downloadHf = (repo: HfRepo, f: HfFile) => {
    if (repo.gated) return;
    const params = paramsOf(f.file) || paramsOf(repo.id);
    const id = `hf:${repo.id}/${f.file}`;
    if (!roomFor(f.size)) return;
    startDownload({ id, name: `${repo.id.split('/')[1] ?? repo.id} ${quantOf(f.file)}`.trim(), file: f.file, size: f.size, sha256: f.sha256, parts: isSplit(f) ? f.parts : undefined, params_b: params, quant: quantOf(f.file), kv_mb_per_1k: kvGuess(params), ctx_max: 8192, license: repo.license, source: 'hf', url: hfUrl(repo.id, f.file) }).catch((e) => Alert.alert(explain(e, tx)));
  };
  const download = (m: CatalogModel) => {
    if (!roomFor(m.size)) return;
    tapSelect();
    startDownload(describe(m)).catch((e) => Alert.alert(explain(e, tx)));
  };
  const prune = () => {
    const list = unusedModels();
    if (!list.length) return;
    Alert.alert(t('models.pruneQ', { n: list.length, gb: gb1(list.reduce((a, m) => a + m.size, 0)) }), '', [{ text: t('models.cancel'), style: 'cancel' }, { text: t('models.delete'), style: 'destructive', onPress: () => forgetUnused() }]);
  };
  const pickFilter = FILE_FILTERS.find((f) => f.id === filter) ?? null;
  const pickFiles = (pick?.files ?? []).filter((f) => !pickFilter || pickFilter.test(f));
  const remove = (m: LocalModel) => Alert.alert(t('models.deleteQ', { name: m.name }), '', [{ text: t('models.cancel'), style: 'cancel' }, { text: t('models.delete'), style: 'destructive', onPress: () => forgetModel(m.id) }]);
  const choose = (m: LocalModel) => {
    tapSelect();
    saveSettings({ modelId: m.id });
    router.push(`/model/${encodeURIComponent(m.id)}`);
  };
  const dl = (id: string) => downloads.find((d) => d.id === id) ?? null;
  const have = (id: string) => local.find((m) => m.id === id) ?? null;

  const banner = !hasNative() ? t('models.noNative') : !arm ? t('models.notArm') : !passport ? t('models.noPassport') : null;
  // the ladder shows until every rung is done (or it is hidden); only where models can run at all
  const showSteps = hasNative() && arm && !ux.stepsDone;
  const smallest = rows.find(({ m }) => !have(m.id) && !dl(m.id))?.m ?? null;

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <PullDownScroll
        closable={false}
        header={<View style={styles.band}><Text style={styles.title}>{t('models.title')}</Text></View>}
        contentContainerStyle={[styles.body, { paddingBottom: tabSpace + insets.bottom + 28 }]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.lede}>{t('models.lede')}</Text>
        {showSteps ? (
          <StepBar facts={{ passport: !!passport, models: local.length, downloading: downloads.length > 0, ran: ux.ran || !!engine.load, peers: peers.length }} firstModelId={local[0]?.id ?? null} />
        ) : banner ? (
          <Pressable onPress={() => (!passport && hasNative() && arm ? router.push('/passport') : null)} accessibilityRole={!passport && hasNative() && arm ? 'button' : 'text'} accessibilityLabel={banner} style={styles.banner}>
            <Text style={styles.bannerText}>{banner}{!passport && hasNative() && arm ? ` · ${t('models.measure')} ›` : ''}</Text>
          </Pressable>
        ) : null}
        {disk !== null ? (
          <View style={styles.storage}>
            <Text style={styles.small}>{up(used > 0 ? t('models.storage', { used: gb1(used), free: (disk / 1024).toFixed(1) }) : t('models.disk', { gb: (disk / 1024).toFixed(1) }))}</Text>
            {unused > 0 ? <Pressable onPress={prune} hitSlop={8}><Text style={styles.link}>{t('models.prune')} ({unused}) ›</Text></Pressable> : null}
          </View>
        ) : null}

        {/* on this phone */}
        <Text style={styles.section}>{up(t('models.onPhone'))}</Text>
        {local.length === 0 && downloads.length === 0 ? (
          <EmptyState text={t('empty.models')} action={hasNative() && arm && smallest ? t('empty.models.go') : undefined} onAction={() => smallest && download(smallest)} testID="empty-models" />
        ) : null}
        {downloads.map((d) => <DownloadCard key={d.id} d={d} />)}
        {local.map((m) => {
          const running = engine.model?.id === m.id && !!engine.load;
          const chosen = settings.modelId === m.id;
          return (
            <Pressable key={m.id} onPress={() => choose(m)} onLongPress={() => remove(m)} accessibilityRole="button" accessibilityLabel={t('a11y.open', { name: m.name })} accessibilityHint={t('models.delete')} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
              <View style={styles.rowText}>
                <Text style={styles.name} numberOfLines={1}>{m.name.toLowerCase()}{running ? <Text style={styles.live}>  ● {t('models.running')}</Text> : chosen ? <Text style={styles.chosen}>  · {t('models.chosen')}</Text> : null}</Text>
                <Text style={styles.meta}>{[`${m.params_b}B`, m.quant, gb(m.size), m.parts && m.parts.length > 1 ? t('models.parts', { n: m.parts.length }) : '', m.license].filter(Boolean).join(' · ').toLowerCase()}</Text>
              </View>
              <Text style={styles.action}>{running ? t('model.openChat') : t('models.run')} ›</Text>
            </Pressable>
          );
        })}

        {/* the chosen list, by fit */}
        <Text style={styles.section}>{up(t('models.suggested'))}</Text>
        {rows.map(({ m, f, tog }) => {
          const got = have(m.id);
          const d = dl(m.id);
          if (got || d) return null;
          return (
            <Pressable key={m.id} onPress={() => router.push(`/model/${encodeURIComponent(m.id)}`)} accessibilityRole="button" accessibilityLabel={t('a11y.open', { name: m.name })} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
              <View style={styles.rowText}>
                <Text style={styles.name} numberOfLines={1}>{m.name.toLowerCase()} <Text style={styles.chosen}>›</Text></Text>
                <Text style={styles.meta}>{[`${m.params_b}B`, m.quant, gb(m.size), m.license].join(' · ').toLowerCase()}</Text>
                <Text style={styles.blurb}>{m.blurb[lang as 'en' | 'de' | 'tr'] ?? m.blurb.en}</Text>
                <View style={styles.badges}>
                  <Badge fit={f} together={tog} />
                  {f.tps ? <Text style={styles.tps}>{f.tps.low}–{f.tps.high} tok/s</Text> : null}
                  <Pressable onPress={() => Linking.openURL(m.license_url)} hitSlop={12} accessibilityRole="link" accessibilityLabel={t('a11y.license')} style={styles.linkHit}><Text style={styles.link}>{t('models.license')} ↗</Text></Pressable>
                </View>
              </View>
              {hasNative() && arm ? (
                <Pressable onPress={() => download(m)} accessibilityRole="button" accessibilityLabel={t('a11y.download', { name: m.name })} style={({ pressed }) => [styles.btn, pressed && styles.pressed]}>
                  <Text style={styles.btnText}>{t('models.download')}</Text>
                </Pressable>
              ) : null}
            </Pressable>
          );
        })}

        {/* hugging face */}
        <Text style={styles.section}>{up(t('models.search'))}</Text>
        <View style={styles.searchRow}>
          <TextInput value={q} onChangeText={setQ} onSubmitEditing={() => search()} placeholder={t('models.searchHint')} placeholderTextColor={colors.meta} returnKeyType="search" autoCapitalize="none" autoCorrect={false} accessibilityLabel={t('models.search')} style={styles.input} />
          <Pressable onPress={() => search()} accessibilityRole="button" accessibilityLabel={t('models.search')} accessibilityState={{ busy }} style={({ pressed }) => [styles.btn, pressed && styles.pressed]}><Text style={styles.btnText}>{busy ? '…' : t('models.search').split(' ')[0]}</Text></Pressable>
        </View>
        {/* the last searches, then a few that are worth trying */}
        <View style={styles.chips}>
          {history.map((h) => <Chip key={`h:${h}`} label={h} onPress={() => search(h)} />)}
          {SUGGESTED_QUERIES.filter((x) => !history.includes(x)).slice(0, Math.max(2, 5 - history.length)).map((x) => <Chip key={`s:${x}`} label={x} dim onPress={() => search(x)} />)}
        </View>
        <View style={styles.chips}>
          <Text style={styles.chipLabel}>{t('models.filter')}</Text>
          {FILE_FILTERS.map((f) => <Chip key={f.id} label={f.label.toLowerCase()} on={filter === f.id} onPress={() => setFilter(filter === f.id ? null : f.id)} />)}
        </View>
        {busy && repos === null ? <Text style={styles.note} accessibilityLiveRegion="polite">{t('models.searching')}</Text> : null}
        {repos === null && !busy && !hfErr ? <Text style={styles.note}>{t('empty.search')}</Text> : null}
        {hfErr ? <Text style={styles.err}>{hfErr}</Text> : null}
        {repos && repos.length === 0 && !hfErr ? <Text style={styles.note}>{t('models.noResults')}</Text> : null}
        {(repos ?? []).map((r) => (
          <Pressable key={r.id} onPress={() => openRepo(r)} accessibilityRole="button" accessibilityLabel={t('a11y.open', { name: r.id })} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
            <View style={styles.rowText}>
              <Text style={styles.name} numberOfLines={1}>{r.gated ? '🔒 ' : ''}{r.id.toLowerCase()}</Text>
              <Text style={styles.meta}>{[`${(r.downloads / 1000).toFixed(r.downloads > 1e5 ? 0 : 1)}k ↓`, r.license ?? t('models.licenseUnknown'), r.gated ? t('models.gated') : ''].filter(Boolean).join(' · ').toLowerCase()}</Text>
              <Pressable onPress={() => readLicense(r)} hitSlop={8}><Text style={styles.link}>{t('models.licenseRead')} ↗</Text></Pressable>
            </View>
            <Text style={styles.action}>{r.gated ? '' : '›'}</Text>
          </Pressable>
        ))}
        <PickerSheet
          open={!!pick}
          title={pick ? `${t('models.files')} · ${pick.repo.id}${pickFilter ? ` · ${pickFilter.label.toLowerCase()}` : ''}` : ''}
          options={pickFiles.map((f) => ({ id: f.file, label: f.file.replace(/-\d{5}-of-\d{5}\.gguf$/i, '').replace(/\.gguf$/i, '').toLowerCase(), extra: `${gb(f.size)}${isSplit(f) ? ` · ${t('models.parts', { n: f.parts.length })}` : ''}` }))}
          selected={null}
          onSelect={(id) => {
            const f = pick?.files.find((x) => x.file === id);
            if (pick && f) downloadHf(pick.repo, f);
          }}
          onClose={() => setPick(null)}
          note={pick && pickFiles.length === 0 ? t('models.noResults') : undefined}
        />
      </PullDownScroll>
    </View>
  );
}

function Chip({ label, on, dim, onPress }: { label: string; on?: boolean; dim?: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && styles.pressed]}>
      <Text style={[styles.chipText, on && styles.chipTextOn, dim && styles.chipDim]}>{label}</Text>
    </Pressable>
  );
}

function Badge({ fit, together }: { fit: Fit; together: (Fit & { shares: unknown[] }) | null }) {
  const { t } = useLang();
  const text = fit.verdict === 'fits' ? t('models.fits') : fit.verdict === 'tight' ? t('models.tight') : together && together.verdict !== 'no' ? t('models.together') : t('models.no');
  const tone = fit.verdict === 'fits' ? styles.badgeOk : fit.verdict === 'tight' || (together && together.verdict !== 'no') ? styles.badgeMid : styles.badgeNo;
  return (
    <View style={[styles.badge, tone]}>
      <Text style={styles.badgeText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  band: { position: 'absolute', top: 0, left: 0, right: 0, height: brand.top + 44, backgroundColor: colors.ink, zIndex: 2 },
  title: { position: 'absolute', top: brand.top - 8, left: brand.left, fontFamily: fonts.semibold, fontSize: 30, lineHeight: 32, letterSpacing: -0.9, color: colors.paper },
  body: { paddingTop: brand.top + 48, paddingHorizontal: brand.left },
  lede: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.paper2 },
  banner: { marginTop: 12, padding: 12, borderRadius: radius.md, backgroundColor: colors.ink2 },
  bannerText: { fontFamily: fonts.medium, fontSize: 13, color: colors.paper },
  small: { fontFamily: fonts.regular, fontSize: 10, letterSpacing: 1.4, color: colors.mute, marginTop: 10 },
  storage: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  err: { fontFamily: fonts.regular, fontSize: 13, color: colors.gold, marginTop: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 10 },
  chipLabel: { fontFamily: fonts.regular, fontSize: 10, letterSpacing: 1.2, color: colors.meta, marginRight: 4 },
  chip: { paddingHorizontal: 10, height: 26, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.ink3, justifyContent: 'center' },
  chipOn: { backgroundColor: colors.paper, borderColor: colors.paper },
  chipText: { fontFamily: fonts.regular, fontSize: 12, color: colors.paper2 },
  chipTextOn: { color: colors.ink },
  chipDim: { color: colors.meta },
  section: { fontFamily: fonts.regular, fontSize: 10, letterSpacing: 1.6, color: colors.spotText, marginTop: 28, marginBottom: 4 },
  note: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.mute, marginTop: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.ink3 },
  rowText: { flex: 1, gap: 3 },
  name: { fontFamily: fonts.semibold, fontSize: 16, color: colors.paper },
  live: { fontFamily: fonts.medium, fontSize: 12, color: colors.spotText },
  chosen: { fontFamily: fonts.regular, fontSize: 12, color: colors.meta },
  meta: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 16, color: colors.mute },
  blurb: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.paper2, marginTop: 2 },
  badges: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6, flexWrap: 'wrap' },
  badge: { paddingHorizontal: 8, height: 20, borderRadius: radius.pill, justifyContent: 'center' },
  badgeOk: { backgroundColor: colors.green },
  badgeMid: { backgroundColor: colors.gold },
  badgeNo: { backgroundColor: colors.ink3 },
  badgeText: { fontFamily: fonts.medium, fontSize: 10.5, color: colors.ink, letterSpacing: 0.4 },
  tps: { fontFamily: fonts.jet, fontSize: 11, color: colors.spotText },
  link: { fontFamily: fonts.regular, fontSize: 11, color: colors.mute },
  action: { fontFamily: fonts.medium, fontSize: 13, color: colors.spotText },
  btn: { paddingHorizontal: 14, minHeight: 44, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.paper, justifyContent: 'center' },
  linkHit: { minHeight: 32, justifyContent: 'center' },
  btnText: { fontFamily: fonts.medium, fontSize: 13, color: colors.paper },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 },
  input: { flex: 1, height: 44, borderBottomWidth: 1, borderBottomColor: colors.ink3, fontFamily: fonts.regular, fontSize: 15, color: colors.paper },
  pressed: { opacity: 0.6 },
});

export { llama as _nativeForTests };
