import { useEffect, useMemo, useState } from 'react';
import { Alert, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import PickerSheet from '@/components/PickerSheet';
import PullDownScroll from '@/components/PullDownScroll';
import { useTabBarSpace } from '@/components/TabBar';
import { usePassport, useLinked } from '@/data/passport';
import type { Passport } from '@/passport/contract';
import { useLang } from '@/i18n';
import { CATALOG, type CatalogModel } from '@/llm/catalog';
import { useEngine } from '@/llm/engine';
import { fitOn, fitTogether, type Fit } from '@/llm/fit';
import { ggufFiles, hfUrl, kvGuess, paramsOf, quantOf, searchGguf, type HfFile, type HfRepo } from '@/llm/hf';
import { hasNative, llama } from '@/llm/native';
import { cancelDownload, describe, forgetModel, initStore, retryDownload, saveSettings, startDownload, useDownloads, useLocalModels, usePeers, useSettings, type Download, type LocalModel } from '@/llm/store';
import { colors, fonts, radius } from '@/theme/tokens';
import { brand } from '@/theme/layout';

// The models tab (4.11.2026; it took the swipe deck's place): what is on this phone, what
// would fit it (the chosen list, sorted by the passport), and a Hugging Face search. A
// download is verified by sha256 and continues after a kill. "run" opens the model page,
// where the mode (alone · apart · split) is asked every time.
const gb = (b: number) => `${(b / 1024 ** 3).toFixed(b < 1024 ** 3 ? 2 : 1)} gb`;

export default function ModelsScreen() {
  const insets = useSafeAreaInsets();
  const tabSpace = useTabBarSpace();
  const { t, up, lang } = useLang();
  const passport = usePassport();
  const linked = useLinked();
  const peers = usePeers();
  const local = useLocalModels();
  const downloads = useDownloads();
  const settings = useSettings();
  const engine = useEngine();
  const [disk, setDisk] = useState<number | null>(null);
  const [arm, setArm] = useState(true);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [repos, setRepos] = useState<HfRepo[] | null>(null);
  const [pick, setPick] = useState<{ repo: HfRepo; files: HfFile[] } | null>(null);

  useEffect(() => {
    initStore().then((info) => {
      if (!info) return;
      setDisk(info.freeDiskMb);
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
      const f = fitOn(passport, { size: m.size, kv_mb_per_1k: m.kv_mb_per_1k, ctx: 2048, file: m.file });
      const tog = pool.length > 1 && f.verdict === 'no' ? fitTogether(pool, { size: m.size, kv_mb_per_1k: m.kv_mb_per_1k, ctx: 2048, file: m.file }) : null;
      return { m, f, tog, rank: f.verdict === 'fits' ? 0 : f.verdict === 'tight' ? 1 : tog && tog.verdict !== 'no' ? 2 : 3 };
    });
    // without a passport nothing fits on paper: small first, so the first download is a sure one
    return list.sort((a, b) => a.rank - b.rank || (passport ? b.m.params_b - a.m.params_b : a.m.params_b - b.m.params_b));
  }, [passport, pool]);

  const search = async () => {
    const text = q.trim();
    if (!text) return;
    setBusy(true);
    try {
      setRepos(await searchGguf(text));
    } catch {
      setRepos([]);
    } finally {
      setBusy(false);
    }
  };
  const openRepo = async (repo: HfRepo) => {
    setBusy(true);
    try {
      setPick({ repo, files: await ggufFiles(repo.id) });
    } catch {
      setPick({ repo, files: [] });
    } finally {
      setBusy(false);
    }
  };
  const downloadHf = (repo: HfRepo, f: HfFile) => {
    const params = paramsOf(f.file) || paramsOf(repo.id);
    const id = `hf:${repo.id}/${f.file}`;
    if (disk !== null && f.size / 1048576 > disk - 200) return Alert.alert(t('models.noDisk'));
    startDownload({ id, name: `${repo.id.split('/')[1] ?? repo.id} ${quantOf(f.file)}`.trim(), file: f.file, size: f.size, sha256: f.sha256, params_b: params, quant: quantOf(f.file), kv_mb_per_1k: kvGuess(params), ctx_max: 8192, license: repo.license, source: 'hf', url: hfUrl(repo.id, f.file) }).catch((e) => Alert.alert(String(e.message)));
  };
  const download = (m: CatalogModel) => {
    if (disk !== null && m.size / 1048576 > disk - 200) return Alert.alert(t('models.noDisk'));
    startDownload(describe(m)).catch((e) => Alert.alert(String(e.message)));
  };
  const remove = (m: LocalModel) => Alert.alert(t('models.deleteQ', { name: m.name }), '', [{ text: t('models.cancel'), style: 'cancel' }, { text: t('models.delete'), style: 'destructive', onPress: () => forgetModel(m.id) }]);
  const choose = (m: LocalModel) => {
    saveSettings({ modelId: m.id });
    router.push(`/model/${encodeURIComponent(m.id)}`);
  };
  const dl = (id: string) => downloads.find((d) => d.id === id) ?? null;
  const have = (id: string) => local.find((m) => m.id === id) ?? null;

  const banner = !hasNative() ? t('models.noNative') : !arm ? t('models.notArm') : !passport ? t('models.noPassport') : null;

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
        {banner ? (
          <Pressable onPress={() => (!passport && hasNative() && arm ? router.push('/passport') : null)} style={styles.banner}>
            <Text style={styles.bannerText}>{banner}{!passport && hasNative() && arm ? ` · ${t('models.measure')} ›` : ''}</Text>
          </Pressable>
        ) : null}
        {disk !== null ? <Text style={styles.small}>{up(t('models.disk', { gb: (disk / 1024).toFixed(1) }))}</Text> : null}

        {/* on this phone */}
        <Text style={styles.section}>{up(t('models.onPhone'))}</Text>
        {local.length === 0 && downloads.length === 0 ? <Text style={styles.note}>{t('models.empty')}</Text> : null}
        {downloads.map((d) => <DownloadRow key={d.id} d={d} />)}
        {local.map((m) => {
          const running = engine.model?.id === m.id && !!engine.load;
          const chosen = settings.modelId === m.id;
          return (
            <Pressable key={m.id} onPress={() => choose(m)} onLongPress={() => remove(m)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
              <View style={styles.rowText}>
                <Text style={styles.name} numberOfLines={1}>{m.name.toLowerCase()}{running ? <Text style={styles.live}>  ● {t('models.running')}</Text> : chosen ? <Text style={styles.chosen}>  · {t('models.chosen')}</Text> : null}</Text>
                <Text style={styles.meta}>{[`${m.params_b}B`, m.quant, gb(m.size), m.license].filter(Boolean).join(' · ').toLowerCase()}</Text>
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
            <Pressable key={m.id} onPress={() => router.push(`/model/${encodeURIComponent(m.id)}`)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
              <View style={styles.rowText}>
                <Text style={styles.name} numberOfLines={1}>{m.name.toLowerCase()} <Text style={styles.chosen}>›</Text></Text>
                <Text style={styles.meta}>{[`${m.params_b}B`, m.quant, gb(m.size), m.license].join(' · ').toLowerCase()}</Text>
                <Text style={styles.blurb}>{m.blurb[lang as 'en' | 'de' | 'tr'] ?? m.blurb.en}</Text>
                <View style={styles.badges}>
                  <Badge fit={f} together={tog} />
                  {f.tps ? <Text style={styles.tps}>{f.tps.low}–{f.tps.high} tok/s{f.measured ? ' ✓' : ''}</Text> : null}
                  <Pressable onPress={() => Linking.openURL(m.license_url)} hitSlop={8}><Text style={styles.link}>{t('models.license')} ↗</Text></Pressable>
                </View>
              </View>
              {hasNative() && arm ? (
                <Pressable onPress={() => download(m)} style={({ pressed }) => [styles.btn, pressed && styles.pressed]}>
                  <Text style={styles.btnText}>{t('models.download')}</Text>
                </Pressable>
              ) : null}
            </Pressable>
          );
        })}

        {/* hugging face */}
        <Text style={styles.section}>{up(t('models.search'))}</Text>
        <View style={styles.searchRow}>
          <TextInput value={q} onChangeText={setQ} onSubmitEditing={search} placeholder={t('models.searchHint')} placeholderTextColor={colors.meta} returnKeyType="search" autoCapitalize="none" autoCorrect={false} style={styles.input} />
          <Pressable onPress={search} style={({ pressed }) => [styles.btn, pressed && styles.pressed]}><Text style={styles.btnText}>{busy ? '…' : t('models.search').split(' ')[0]}</Text></Pressable>
        </View>
        {busy && repos === null ? <Text style={styles.note}>{t('models.searching')}</Text> : null}
        {repos && repos.length === 0 ? <Text style={styles.note}>{t('models.noResults')}</Text> : null}
        {(repos ?? []).map((r) => (
          <Pressable key={r.id} onPress={() => openRepo(r)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
            <View style={styles.rowText}>
              <Text style={styles.name} numberOfLines={1}>{r.id.toLowerCase()}</Text>
              <Text style={styles.meta}>{[`${(r.downloads / 1000).toFixed(r.downloads > 1e5 ? 0 : 1)}k ↓`, r.license ?? t('models.licenseUnknown'), r.gated ? t('models.gated') : ''].filter(Boolean).join(' · ').toLowerCase()}</Text>
            </View>
            <Text style={styles.action}>›</Text>
          </Pressable>
        ))}
        <PickerSheet
          open={!!pick}
          title={pick ? `${t('models.files')} · ${pick.repo.id}` : ''}
          options={(pick?.files ?? []).map((f) => ({ id: f.file, label: f.file.replace(/\.gguf$/i, '').toLowerCase(), extra: gb(f.size) }))}
          selected={null}
          onSelect={(id) => {
            const f = pick?.files.find((x) => x.file === id);
            if (pick && f) downloadHf(pick.repo, f);
          }}
          onClose={() => setPick(null)}
          note={pick && pick.files.length === 0 ? t('models.noResults') : undefined}
        />
      </PullDownScroll>
    </View>
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

function DownloadRow({ d }: { d: Download }) {
  const { t } = useLang();
  const pct = d.total > 0 ? Math.min(100, Math.round((d.got / d.total) * 100)) : 0;
  const failed = d.state === 'error';
  return (
    <View style={styles.row}>
      <View style={styles.rowText}>
        <Text style={styles.name} numberOfLines={1}>{d.model.name.toLowerCase()}</Text>
        <Text style={styles.meta}>{failed ? `${t('models.state.error')}: ${d.error ?? ''}` : `${t(`models.state.${d.state === 'cancelled' || d.state === 'done' ? 'running' : d.state}`)} · ${gb(d.got)} / ${gb(d.total)}`}</Text>
        <View style={styles.bar}><View style={[styles.barIn, { width: `${pct}%` }]} /></View>
      </View>
      <Pressable onPress={() => (failed ? retryDownload(d.id) : cancelDownload(d.id))} style={({ pressed }) => [styles.btn, pressed && styles.pressed]}>
        <Text style={styles.btnText}>{failed ? t('models.retry') : t('models.cancel')}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  band: { position: 'absolute', top: 0, left: 0, right: 0, height: brand.top + 44, backgroundColor: colors.ink, zIndex: 2 },
  title: { position: 'absolute', top: brand.top - 8, left: brand.left, fontFamily: fonts.semibold, fontSize: 30, lineHeight: 32, letterSpacing: -0.9, color: colors.paper },
  body: { paddingTop: brand.top + 48, paddingHorizontal: brand.left },
  lede: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.mute },
  banner: { marginTop: 12, padding: 12, borderRadius: radius.md, backgroundColor: colors.ink2 },
  bannerText: { fontFamily: fonts.medium, fontSize: 13, color: colors.paper },
  small: { fontFamily: fonts.regular, fontSize: 10, letterSpacing: 1.4, color: colors.meta, marginTop: 10 },
  section: { fontFamily: fonts.regular, fontSize: 10, letterSpacing: 1.6, color: colors.spotText, marginTop: 28, marginBottom: 4 },
  note: { fontFamily: fonts.regular, fontSize: 14, color: colors.mute, marginTop: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.ink3 },
  rowText: { flex: 1, gap: 3 },
  name: { fontFamily: fonts.semibold, fontSize: 16, color: colors.paper },
  live: { fontFamily: fonts.medium, fontSize: 12, color: colors.spotText },
  chosen: { fontFamily: fonts.regular, fontSize: 12, color: colors.meta },
  meta: { fontFamily: fonts.regular, fontSize: 12, color: colors.mute },
  blurb: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.paper2, marginTop: 2 },
  badges: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6, flexWrap: 'wrap' },
  badge: { paddingHorizontal: 8, height: 20, borderRadius: radius.pill, justifyContent: 'center' },
  badgeOk: { backgroundColor: colors.green },
  badgeMid: { backgroundColor: colors.gold },
  badgeNo: { backgroundColor: colors.ink3 },
  badgeText: { fontFamily: fonts.medium, fontSize: 10.5, color: colors.ink, letterSpacing: 0.4 },
  tps: { fontFamily: fonts.jet, fontSize: 11, color: colors.spotText },
  link: { fontFamily: fonts.regular, fontSize: 11, color: colors.meta },
  action: { fontFamily: fonts.medium, fontSize: 13, color: colors.spotText },
  btn: { paddingHorizontal: 14, height: 36, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.paper, justifyContent: 'center' },
  btnText: { fontFamily: fonts.medium, fontSize: 13, color: colors.paper },
  bar: { height: 3, backgroundColor: colors.ink3, borderRadius: 2, marginTop: 6, overflow: 'hidden' },
  barIn: { height: 3, backgroundColor: colors.spot },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 6 },
  input: { flex: 1, height: 44, borderBottomWidth: 1, borderBottomColor: colors.ink3, fontFamily: fonts.regular, fontSize: 15, color: colors.paper },
  pressed: { opacity: 0.6 },
});

export { llama as _nativeForTests };
