import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import PullDownScroll from '@/components/PullDownScroll';
import Tips from '@/components/Tips';
import { useTabBarSpace } from '@/components/TabBar';
import BrainFigure, { type FigureNode } from '@/components/brain/BrainFigure';
import Empty from '@/components/brain/Empty';
import Ledger, { type Tile } from '@/components/brain/Ledger';
import Night from '@/components/brain/Night';
import Now from '@/components/brain/Now';
import Timeline from '@/components/brain/Timeline';
import { STATE_COLOR } from '@/components/brain/colors';
import { nodeShare } from '@/components/brain/geometry';
import { big, buckets, nodeState, speedOf, windowProgress, type NodeState } from '@/components/brain/stats';
import { group } from '@/components/brain/grouping';
import { networkEstimate, type NetworkEstimate } from '@/data/network';
import { useRefreshOnFocus } from '@/hooks/useRefresh';
import { useLang } from '@/i18n';
import { parseLedger, peerBadge, summarize, verdictOf, verifyChain, type AuditEntry } from '@/llm/audit';
import { clearBrainLog, latest, useBrainLog } from '@/llm/brainlog';
import { useEngine, type Device } from '@/llm/engine';
import { hasNative, llama } from '@/llm/native';
import { usePeers } from '@/llm/store';
import { nightRules } from '@/data/settings';
import { accuracy, useReports } from '@/night/report';
import { useNight } from '@/night/useNight';
import { VERDICT_COLOR } from '@/theme/audit';
import { colors, fonts } from '@/theme/tokens';
import { brand } from '@/theme/layout';

// The brain (5.11.2026; the network tab's place, in the middle of the bar): beyin at work on
// this phone, live, to be seen more than read ("the brain has a lot of text; make it more
// visual", 5.11.2026). On top the cluster drawn: this phone in the middle, every paired device
// around it, rings filled by the share of the model, coloured by state, the checker's badge
// on each; one line under it. Right now: the speed big and the model's parts as one bar. What
// it decided: a timeline of marks and a few words (llm/brainlog.ts), the sentence on a tap.
// The ledger: three counts with the last day's sparkline and the chain's lock; the lines are
// behind "the full ledger". The night: a ring for tonight's window and last night's numbers.
// The wider network: what every phone could make tonight. Every picture says its sentence
// to a screen reader (accessibilityLabel). The pure parts are in components/brain/*.ts.
const LEDGER = 200; // lines read from the native ledger
const SHOWN = 8;    // rows of decisions before "show all"
const ALL = 50;     // decisions read for "show all"

const KIND = (k: string | undefined): FigureNode['kind'] => (k === 'tablet' || k === 'pc' ? k : 'phone');

export default function BrainScreen() {
  const insets = useSafeAreaInsets();
  const tabSpace = useTabBarSpace();
  const { t, tn, tx, up } = useLang();
  const tick = useRefreshOnFocus('networkEstimate');
  const engine = useEngine();
  const peers = usePeers();
  const log = useBrainLog();
  const night = useNight();
  const reports = useReports();
  const [raw, setRaw] = useState<string[] | null>(null);
  const [readAt, setReadAt] = useState(0); // when the ledger was read: its sparklines end there
  const [all, setAll] = useState(false);
  const [wider, setWider] = useState<NetworkEstimate | null>(null);

  // the ledger: on focus, and every 15 s while the tab is open (the worker writes as it goes)
  const readLedger = useCallback(() => {
    if (!hasNative()) return setRaw([]);
    llama!.auditLedger(LEDGER).catch(() => llama!.gateLedger(LEDGER)).catch(() => [] as string[]).then((lines) => {
      setRaw(lines);
      setReadAt(Date.now());
    });
  }, []);
  useFocusEffect(
    useCallback(() => {
      const first = setTimeout(readLedger, 0); // after the render, not inside it
      const every = setInterval(readLedger, 15_000);
      return () => {
        clearTimeout(first);
        clearInterval(every);
      };
    }, [readLedger]),
  );
  useEffect(() => {
    networkEstimate().then(setWider, () => setWider(null));
  }, [tick]);

  const entries: AuditEntry[] = useMemo(() => parseLedger(raw ?? []), [raw]);
  const chain = useMemo(() => verifyChain(raw ?? []), [raw]);

  // ---- the figure: this phone and every paired device ----
  const loaded = !!engine.model && !engine.loading;
  const mode = engine.mode;
  const me = engine.devices.find((d) => d.local);
  const working = engine.generating && mode !== 'apart'; // alone and split: everyone in the model works on each token
  const stateWord = (s: NodeState) => (s === 'refused' ? t('brain.device.refused') : t(`brain.device.${s}`));
  const describe = (n: FigureNode) =>
    n.share > 0
      ? t('brain.a11y.node', { name: n.name, state: stateWord(n.state), pct: Math.round(n.share * 100), verdict: t(`audit.verdict.${n.badge}`) })
      : t('brain.a11y.nodeOff', { name: n.name, state: stateWord(n.state), verdict: t(`audit.verdict.${n.badge}`) });

  const center: FigureNode = {
    id: 'me',
    name: t('brain.this'),
    share: loaded ? nodeShare(mode, engine.split, me?.name ?? '', true) : 0,
    state: loaded ? nodeState(me ?? { busy: false }, 'none', working) : 'saved',
    badge: 'none',
  };
  const nodes: FigureNode[] = peers.map((p) => {
    const badge = peerBadge(entries, p.host);
    // apart: a device of its own · split: in the model when the plan used it, working with this phone
    let d: Pick<Device, 'busy' | 'out'> | undefined = loaded ? engine.devices.find((x) => x.id === p.id) : undefined;
    if (loaded && !d && mode === 'split' && engine.plan?.used.some((u) => u.id === p.id)) d = { busy: false };
    return { id: p.id, name: p.name.toLowerCase(), share: nodeShare(mode, engine.split, p.name, !!d), state: nodeState(d, badge, !!d && working), badge, kind: KIND(p.kind) };
  });
  const inModel = loaded ? (mode === 'split' ? Math.max(1, engine.split.length) : mode === 'apart' ? engine.devices.length : 1) : 0;
  const modelName = (engine.model?.name ?? '').toLowerCase();
  const summary = engine.loading
    ? `${modelName} · ${tx(`model.loading.${engine.loading}`, engine.loading).replace(/…$/, '')}`
    : loaded
      ? `${modelName} · ${t(`brain.mode.${mode}`)} · ${tn('brain.devices.n', inModel)}`
      : `${t('brain.empty.model')} · ${tn('brain.devices.n', peers.length + 1)}`;
  const heroLabel = [summary, describe(center), ...nodes.map(describe), peers.length ? '' : t('brain.devices.none'), engine.generating ? t('brain.generating') : ''].filter(Boolean).join('. ');

  // ---- what it decided ----
  const groups = useMemo(() => group(latest(log, all ? ALL : 4 * SHOWN)), [log, all]);
  const rows = all ? groups : groups.slice(0, SHOWN);

  // ---- the ledger ----
  const tiles: Tile[] = useMemo(() => {
    const now = readAt;
    const sum = summarize(entries);
    const lines = entries.flatMap((e) => (e.line ? [e.line] : []));
    const times = (v?: string) => lines.filter((l) => !v || verdictOf(l) === v).map((l) => l.t);
    return [
      { n: sum.rejects, label: t('audit.rejects'), color: VERDICT_COLOR.rejected, spark: buckets(times('rejected'), now) },
      { n: sum.warns, label: t('audit.warns'), color: VERDICT_COLOR.warn, spark: buckets(times('warn'), now) },
      { n: sum.total, label: t('audit.lines'), color: colors.paper2, spark: buckets(times(), now) },
    ];
  }, [entries, readAt, t]);
  const chainView = raw && raw.length
    ? {
        ok: chain.ok,
        text: chain.ok ? t('brain.chain.ok') : t('brain.chain.broken'),
        a11y: chain.ok ? (chain.fromGenesis ? t('audit.chain.ok') : t('audit.chain.partial')) : t('audit.chain.broken', { n: (chain.broken ?? 0) + 1 }),
      }
    : null;

  // ---- the night ----
  const rules = nightRules();
  const win = windowProgress(rules.from, rules.to, new Date());
  const last = reports.at(-1) ?? null;
  const nightStatus =
    night.state === 'running'
      ? [t('night.running'), (night.slug ?? '').replace(/-/g, ' ')].filter(Boolean).join(' · ')
      : night.state === 'waiting' && night.reason
        ? t(`night.waiting.${night.reason}`, { n: rules.minBattery })
        : night.state === 'done' ? t('night.done') : t('brain.night.idle');
  const nightColor = night.state === 'running' ? STATE_COLOR.busy : night.state === 'waiting' ? colors.gold : night.state === 'done' ? colors.paper2 : colors.meta;
  const nightCenter = night.real && (night.units ?? 0) > 0 ? String(night.units) : night.tokens > 0 ? big(night.tokens) : null;
  const pct = last ? accuracy(last) : null;
  const chips = last ? [t('night.units', { n: last.units }), `${last.tps} tok/s`, `${last.wh} wh`, pct != null ? t('brain.night.right', { pct: Math.round(pct * 100) }) : ''].filter(Boolean) : [];
  const nightA11y = [
    nightStatus,
    t('brain.night.window', { from: rules.from, to: rules.to }),
    night.state === 'running' || night.tokens ? [`${big(night.tokens)} ${t('night.tokens')}`, `${night.tps} tok/s`, night.real ? t('night.units', { n: night.units ?? 0 }) : t('night.sim'), night.checked ? t('night.checked', { ok: (night.checked ?? 0) - (night.wrong ?? 0), n: night.checked }) : ''].filter(Boolean).join(', ') : '',
    night.real && night.devices?.length ? night.devices.map((d) => `${d.name.toLowerCase()} ${t('night.units', { n: d.units })}${d.out ? `, ${t('brain.device.out')}` : ''}`).join(', ') : '',
    last ? t('night.report.last', { units: last.units, tps: last.tps, wh: last.wh }) : t('brain.night.noReport'),
  ].filter(Boolean).join('. ');

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <PullDownScroll
        closable={false}
        header={<View style={styles.band}><Text style={styles.title}>{t('brain.title')}</Text></View>}
        contentContainerStyle={[styles.body, { paddingBottom: tabSpace + insets.bottom + 28 }]}
        showsVerticalScrollIndicator={false}
      >
        {/* the brain, drawn: tap it for the devices */}
        <BrainFigure center={center} peers={nodes} label={heroLabel} onPress={() => router.push('/peers')} hint={t('brain.devices.add')} />
        <Text style={[styles.summary, !!engine.loading && styles.live]} numberOfLines={1} importantForAccessibility="no" accessibilityElementsHidden>{summary}</Text>

        {/* right now */}
        <Head text={up(t('brain.now'))} action={t('brain.devices.add')} onAction={() => router.push('/peers')} />
        {engine.model || engine.loading ? (
          <Now
            speed={loaded ? speedOf(mode, engine.devices, engine.plan?.est?.tps) : null}
            together={mode === 'apart' && engine.devices.length > 1}
            split={engine.split}
            devices={mode === 'split' ? engine.split.map((s) => ({ id: s.name, busy: engine.generating })) : engine.devices}
            loading={engine.loading ? t('brain.loading', { what: tx(`model.loading.${engine.loading}`, engine.loading).replace(/…$/, '') }) : null}
            aloneFaster={!!engine.plan?.aloneFaster}
            generating={engine.generating}
            onChat={loaded ? () => router.push('/chat') : undefined}
          />
        ) : engine.error ? (
          <Empty kind="error" text={t('brain.lastError', { why: engine.error })} action={t('brain.empty.load')} onAction={() => router.push('/models')} />
        ) : (
          <Empty kind="model" text={t('brain.empty.model')} a11y={t('brain.idle')} action={t('brain.empty.load')} onAction={() => router.push('/models')} />
        )}

        {/* what it decided */}
        <Head text={up(t('brain.decisions'))} action={log.length ? t('brain.log.clear') : undefined} onAction={clearBrainLog} />
        {log.length ? <Timeline groups={rows} /> : <Empty kind="decisions" text={t('brain.empty.decisions')} a11y={t('brain.log.empty')} />}
        {groups.length > SHOWN || all ? (
          <Pressable onPress={() => setAll(!all)} hitSlop={8} style={styles.more} accessibilityRole="button">
            <Text style={styles.link}>{all ? t('brain.log.less') : t('brain.log.more', { n: Math.min(log.length, ALL) })}</Text>
          </Pressable>
        ) : null}

        {/* the ledger */}
        <Head text={up(t('brain.ledger'))} hint={t('brain.ledger.lede')} action={t('brain.ledger.full')} onAction={() => router.push('/audit')} />
        {!hasNative() ? (
          <Empty kind="ledger" text={t('brain.empty.noNative')} a11y={t('brain.ledger.noNative')} />
        ) : raw && !raw.length ? (
          <Empty kind="ledger" text={t('brain.empty.ledger')} a11y={t('brain.ledger.empty')} />
        ) : (
          <Ledger tiles={tiles} chain={chainView} />
        )}

        {/* the night */}
        <Head text={up(t('brain.night'))} action={t('brain.night.report')} onAction={() => router.push('/night/report')} />
        <Night
          frac={win.frac}
          color={nightColor}
          center={nightCenter}
          centerLabel={night.real && (night.units ?? 0) > 0 ? t('brain.night.unitsWord') : t('night.tokens')}
          status={nightStatus}
          window={`${rules.from}–${rules.to}`}
          chips={chips}
          noReport={last ? null : t('brain.night.noReport')}
          a11y={nightA11y}
        />

        {/* the wider network: the old network tab's tonight, in one number */}
        {wider && wider.phones ? (
          <>
            <Head text={up(t('brain.wider'))} />
            <View style={styles.card} accessible accessibilityLabel={`${big(wider.tokens_night_low)}–${big(wider.tokens_night_high)} ${t('brain.wider.tonight', { hours: wider.hours })}. ${t('brain.wider.basis', { phones: wider.phones, observed: wider.observed })}`}>
              <Text style={styles.wideBig}>{big(wider.tokens_night_low)}–{big(wider.tokens_night_high)}</Text>
              <Text style={styles.cardLine}>{t('brain.wider.tonight', { hours: wider.hours })}</Text>
            </View>
          </>
        ) : null}
      </PullDownScroll>
      <Tips page="brain" tip={{ title: 'tips.brain.1.t', body: 'tips.brain.1.b', motion: 'tap' }} bottom={tabSpace + 12} />
    </View>
  );
}

function Head({ text, hint, action, onAction }: { text: string; hint?: string; action?: string; onAction?: () => void }) {
  return (
    <View style={styles.head}>
      <Text style={styles.section} accessibilityRole="header" accessibilityHint={hint}>{text}</Text>
      {action && onAction ? (
        <Pressable onPress={onAction} hitSlop={8} accessibilityRole="button">
          <Text style={styles.link}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  band: { position: 'absolute', top: 0, left: 0, right: 0, height: brand.top + 44, backgroundColor: colors.ink, zIndex: 2 },
  title: { position: 'absolute', top: brand.top - 8, left: brand.left, fontFamily: fonts.semibold, fontSize: 30, lineHeight: 32, letterSpacing: -0.9, color: colors.paper },
  body: { paddingTop: brand.top + 40, paddingHorizontal: brand.left },
  summary: { fontFamily: fonts.medium, fontSize: 14, color: colors.paper2, textAlign: 'center', marginTop: 2 },
  live: { color: colors.spotText },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 30, marginBottom: 6 },
  section: { fontFamily: fonts.regular, fontSize: 11, letterSpacing: 1.4, color: colors.mute },
  link: { fontFamily: fonts.medium, fontSize: 12, color: colors.spotText },
  more: { paddingVertical: 12 },
  card: { padding: 14, borderRadius: 14, backgroundColor: colors.ink2, marginTop: 4 },
  cardLine: { fontFamily: fonts.medium, fontSize: 13, color: colors.paper2, marginTop: 2 },
  wideBig: { fontFamily: fonts.semibold, fontSize: 28, letterSpacing: -0.8, color: colors.paper },
});
