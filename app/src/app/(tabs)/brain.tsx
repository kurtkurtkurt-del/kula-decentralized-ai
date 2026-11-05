import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { router, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import PullDownScroll from '@/components/PullDownScroll';
import BrainGlyph from '@/components/BrainGlyph';
import Tips from '@/components/Tips';
import { useTabBarSpace } from '@/components/TabBar';
import { networkEstimate, type NetworkEstimate } from '@/data/network';
import { useRefreshOnFocus } from '@/hooks/useRefresh';
import { useLang } from '@/i18n';
import { detailOf, parseLedger, peerBadge, summarize, verdictOf, verifyChain, type AuditEntry } from '@/llm/audit';
import { clearBrainLog, countOf, latest, useBrainLog, type BrainEntry, type Tone } from '@/llm/brainlog';
import { useEngine, type Device } from '@/llm/engine';
import { hasNative, llama } from '@/llm/native';
import { usePeers, type Peer } from '@/llm/store';
import { nightRules } from '@/data/settings';
import { useReports } from '@/night/report';
import { useNight } from '@/night/useNight';
import { VERDICT_COLOR } from '@/theme/audit';
import { colors, fonts, radius } from '@/theme/tokens';
import { brand } from '@/theme/layout';

// The brain (5.11.2026; the network tab's place, now in the middle of the bar): beyin at
// work on this phone, live. Right now: the engine (model, mode, who holds what, who is busy).
// The cluster: this phone and every paired device with the checker's badge. What it decided:
// the planner's and the dispatcher's reasons (llm/brainlog.ts). The ledger: what the checker
// signed, its chain, the newest lines (settings → beyin audit has all of it). The night:
// tonight's worker and the last morning report. The wider network: what every phone could
// make tonight (the old network tab's one number that still says something about kula).
const LEDGER = 200; // lines read from the native ledger
const SHOWN = 12;   // decisions shown before "show all"
const FEED = 8;     // ledger lines shown here

const TONE: Record<Tone, string> = { info: colors.mute, ok: colors.green, warn: colors.gold, bad: colors.violet };
const two = (n: number) => String(n).padStart(2, '0');
const clock = (ms: number) => {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return `${today ? '' : `${two(d.getDate())}.${two(d.getMonth() + 1)} `}${two(d.getHours())}:${two(d.getMinutes())}`;
};
const big = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

export default function BrainScreen() {
  const insets = useSafeAreaInsets();
  const tabSpace = useTabBarSpace();
  const { t, tx, up } = useLang();
  const tick = useRefreshOnFocus('networkEstimate');
  const engine = useEngine();
  const peers = usePeers();
  const log = useBrainLog();
  const night = useNight();
  const reports = useReports();
  const [raw, setRaw] = useState<string[] | null>(null);
  const [all, setAll] = useState(false);
  const [wider, setWider] = useState<NetworkEstimate | null>(null);

  // the ledger: on focus, and every 15 s while the tab is open (the worker writes as it goes)
  const readLedger = useCallback(() => {
    if (!hasNative()) return setRaw([]);
    llama!.auditLedger(LEDGER).catch(() => llama!.gateLedger(LEDGER)).catch(() => [] as string[]).then(setRaw);
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
  const sum = summarize(entries);
  const feed = entries.filter((e) => e.line).slice(-FEED).reverse();
  const counts = countOf(log);
  const decisions = latest(log, all ? 50 : SHOWN);
  const last = reports.at(-1) ?? null;

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <PullDownScroll
        closable={false}
        header={<View style={styles.band}><Text style={styles.title}>{t('brain.title')}</Text></View>}
        contentContainerStyle={[styles.body, { paddingBottom: tabSpace + insets.bottom + 28 }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.lede}>{t('brain.lede')}</Text>

        {/* right now: the engine */}
        <Head text={up(t('brain.now'))} />
        <Now engine={engine} t={t} tx={tx} />

        {/* the cluster: this phone, then every paired device with its badge */}
        <Head text={up(t('brain.cluster'))} action={t('brain.devices.add')} onAction={() => router.push('/peers')} />
        <Cluster devices={engine.devices} peers={peers} entries={entries} t={t} />

        {/* what it decided */}
        <Head text={up(t('brain.decisions'))} action={log.length ? t('brain.log.clear') : undefined} onAction={clearBrainLog} />
        {log.length ? <Text style={styles.meta}>{t('brain.log.counts', { n: counts.total, warn: counts.warn, bad: counts.bad })}</Text> : null}
        {!log.length ? <Text style={styles.note}>{t('brain.log.empty')}</Text> : null}
        {decisions.map((e, i) => <Decision key={`${e.at}-${i}`} e={e} tx={tx} />)}
        {log.length > SHOWN ? (
          <Pressable onPress={() => setAll(!all)} hitSlop={8} style={styles.more}>
            <Text style={styles.link}>{all ? t('brain.log.less') : t('brain.log.more', { n: Math.min(log.length, 50) })}</Text>
          </Pressable>
        ) : null}

        {/* the ledger */}
        <Head text={up(t('brain.ledger'))} action={t('brain.ledger.full')} onAction={() => router.push('/audit')} />
        <Text style={styles.meta}>{t('brain.ledger.lede')}</Text>
        <View style={styles.counts}>
          <Count n={sum.rejects} label={t('audit.rejects')} color={VERDICT_COLOR.rejected} />
          <Count n={sum.warns} label={t('audit.warns')} color={VERDICT_COLOR.warn} />
          <Count n={sum.total} label={t('audit.lines')} color={colors.paper} />
        </View>
        {raw && raw.length ? (
          <View style={[styles.chain, !chain.ok && styles.chainBad]}>
            <View style={[styles.dot, { backgroundColor: chain.ok ? VERDICT_COLOR.verified : VERDICT_COLOR.rejected }]} />
            <Text style={[styles.chainText, !chain.ok && styles.chainBadText]}>
              {chain.ok ? (chain.fromGenesis ? t('audit.chain.ok') : t('audit.chain.partial')) : t('audit.chain.broken', { n: (chain.broken ?? 0) + 1 })}
            </Text>
          </View>
        ) : null}
        {!hasNative() ? <Text style={styles.note}>{t('brain.ledger.noNative')}</Text> : raw && !raw.length ? <Text style={styles.note}>{t('brain.ledger.empty')}</Text> : null}
        {feed.map((e, i) => {
          const line = e.line!;
          const v = verdictOf(line);
          const detail = detailOf(line);
          return (
            <View key={`${line.t}-${i}`} style={styles.row}>
              <BrainGlyph kind={line.kind} color={VERDICT_COLOR[v]} />
              <View style={styles.rowText}>
                <Text style={styles.name} numberOfLines={1}>
                  {tx(`audit.kind.${line.kind}`, line.kind)}
                  <Text style={styles.kind}>  · {line.peer ?? t('audit.peer.this')}</Text>
                </Text>
                {detail ? <Text style={styles.detail} numberOfLines={2}>{detail}</Text> : null}
                <Text style={styles.time}>{clock(line.t)} · <Text style={{ color: VERDICT_COLOR[v] }}>{t(`audit.verdict.${v}`)}</Text></Text>
              </View>
            </View>
          );
        })}

        {/* the night */}
        <Head text={up(t('brain.night'))} action={t('brain.night.report')} onAction={() => router.push('/night/report')} />
        <View style={styles.card}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {night.state === 'running'
              ? `${t('night.running')} · ${(night.slug ?? '').replace(/-/g, ' ')}`
              : night.state === 'waiting' && night.reason
                ? t(`night.waiting.${night.reason}`, { n: nightRules().minBattery })
                : night.state === 'done' ? t('night.done') : t('brain.night.idle')}
          </Text>
          {night.state === 'running' || night.tokens ? (
            <Text style={styles.meta}>
              {[`${big(night.tokens)} ${t('night.tokens')}`, `${night.tps} tok/s`, night.real ? t('night.units', { n: night.units ?? 0 }) : t('night.sim'), night.checked ? t('night.checked', { ok: (night.checked ?? 0) - (night.wrong ?? 0), n: night.checked }) : ''].filter(Boolean).join(' · ')}
            </Text>
          ) : null}
          {night.real && night.devices?.length ? (
            <Text style={styles.meta}>{night.devices.map((d) => `${d.name.toLowerCase()} ${d.units}${d.out ? ` (${t('brain.device.out')})` : ''}`).join('  ·  ')}</Text>
          ) : null}
          <Text style={[styles.meta, styles.cardFoot]}>
            {last ? `${t('brain.night.report')}: ${t('night.report.last', { units: last.units, tps: last.tps, wh: last.wh })}` : t('brain.night.noReport')}
          </Text>
        </View>

        {/* the wider network: the old network tab's tonight, in one card */}
        {wider && wider.phones ? (
          <>
            <Head text={up(t('brain.wider'))} />
            <View style={styles.card}>
              <Text style={styles.wideBig}>{big(wider.tokens_night_low)}–{big(wider.tokens_night_high)}</Text>
              <Text style={styles.cardLine}>{t('brain.wider.tonight', { hours: wider.hours })}</Text>
              <Text style={styles.meta}>{t('brain.wider.basis', { phones: wider.phones, observed: wider.observed })}</Text>
            </View>
          </>
        ) : null}
      </PullDownScroll>
      <Tips page="brain" tip={{ title: 'tips.brain.1.t', body: 'tips.brain.1.b', motion: 'tap' }} bottom={tabSpace + 12} />
    </View>
  );
}

type T = ReturnType<typeof useLang>['t'];
type Tx = ReturnType<typeof useLang>['tx'];

function Head({ text, action, onAction }: { text: string; action?: string; onAction?: () => void }) {
  return (
    <View style={styles.head}>
      <Text style={styles.section}>{text}</Text>
      {action && onAction ? (
        <Pressable onPress={onAction} hitSlop={8} accessibilityRole="button">
          <Text style={styles.link}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Now({ engine, t, tx }: { engine: ReturnType<typeof useEngine>; t: T; tx: Tx }) {
  if (!engine.model && !engine.loading) {
    return <Text style={styles.note}>{engine.error ? t('brain.lastError', { why: engine.error }) : t('brain.idle')}</Text>;
  }
  const busy = engine.devices.filter((d) => d.busy).length;
  const total = engine.split.reduce((a, s) => a + s.gb, 0) || 1;
  return (
    <View style={styles.card}>
      <View style={styles.between}>
        <Text style={styles.cardTitle} numberOfLines={1}>{(engine.model?.name ?? '').toLowerCase()}</Text>
        <View style={styles.mode}><Text style={styles.modeText}>{t(`brain.mode.${engine.mode}`)}</Text></View>
      </View>
      {engine.loading ? (
        <Text style={[styles.meta, styles.live]}>{t('brain.loading', { what: tx(`model.loading.${engine.loading}`, engine.loading).replace(/…$/, '') })}</Text>
      ) : (
        <Text style={styles.meta}>
          {[t('brain.busy', { n: busy, all: engine.devices.length }), engine.generating ? t('brain.generating') : ''].filter(Boolean).join(' · ')}
        </Text>
      )}
      {engine.split.length ? (
        <View style={styles.shares}>
          <Text style={styles.small}>{t('brain.shares')}</Text>
          {engine.split.map((s) => (
            <View key={s.name} style={styles.share}>
              <Text style={styles.shareName} numberOfLines={1}>{s.name.toLowerCase()}</Text>
              <View style={styles.shareBar}><View style={[styles.shareIn, { width: `${Math.max(4, (s.gb / total) * 100)}%` }]} /></View>
              <Text style={styles.shareGb}>{s.gb} gb</Text>
            </View>
          ))}
        </View>
      ) : null}
      {engine.plan?.aloneFaster ? <Text style={[styles.meta, { color: TONE.warn }]}>{t('brain.plan.aloneFaster')}</Text> : null}
      {engine.model && !engine.loading ? (
        <Pressable onPress={() => router.push('/chat')} hitSlop={8} style={styles.cardFoot}>
          <Text style={styles.link}>{t('brain.open.chat')} ›</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Cluster({ devices, peers, entries, t }: { devices: Device[]; peers: Peer[]; entries: AuditEntry[]; t: T }) {
  const me = devices.find((d) => d.local);
  const state = (d: Device | undefined) => (!d ? t('brain.device.saved') : d.out ? t('brain.device.out') : d.busy ? t('brain.device.busy') : t('brain.device.idle'));
  return (
    <View>
      <View style={styles.row}>
        <BrainGlyph kind="connect" color={colors.green} />
        <View style={styles.rowText}>
          <Text style={styles.name} numberOfLines={1}>{(me?.name ?? t('brain.this')).toLowerCase()}<Text style={styles.kind}>  · {t('brain.this')}</Text></Text>
          <Text style={styles.detail}>{[me ? t('brain.device.tps', { tps: me.tps }) : '', me ? state(me) : ''].filter(Boolean).join(' · ') || t('brain.device.idle')}</Text>
        </View>
      </View>
      {peers.map((p) => {
        const d = devices.find((x) => x.id === p.id);
        const badge = peerBadge(entries, p.host);
        return (
          <View key={p.id} style={styles.row}>
            <BrainGlyph kind={badge === 'rejected' ? 'reject' : badge === 'warn' ? 'claim' : 'connect'} color={VERDICT_COLOR[badge]} />
            <View style={styles.rowText}>
              <Text style={styles.name} numberOfLines={1}>{p.name.toLowerCase()}<Text style={styles.kind}>  · {t(`peers.kind.${p.kind}`)}</Text></Text>
              <Text style={styles.detail}>{[d ? t('brain.device.tps', { tps: d.tps }) : '', state(d)].filter(Boolean).join(' · ')}</Text>
            </View>
            <Text style={[styles.badge, { color: VERDICT_COLOR[badge], borderColor: VERDICT_COLOR[badge] }]}>{t(`audit.verdict.${badge}`)}</Text>
          </View>
        );
      })}
      {!peers.length ? <Text style={styles.note}>{t('brain.devices.none')}</Text> : null}
    </View>
  );
}

function Decision({ e, tx }: { e: BrainEntry; tx: Tx }) {
  const color = TONE[e.tone];
  return (
    <View style={styles.row}>
      <BrainGlyph kind={e.kind} color={color} />
      <View style={styles.rowText}>
        <Text style={[styles.line, e.tone === 'bad' && { color }]}>{tx(e.key, e.key, e.vars)}</Text>
        {e.detail ? <Text style={styles.detail} numberOfLines={3}>{e.detail}</Text> : null}
        <Text style={styles.time}>{clock(e.at)}</Text>
      </View>
    </View>
  );
}

function Count({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <View style={styles.count}>
      <Text style={[styles.countN, { color }]}>{n}</Text>
      <Text style={styles.countLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  band: { position: 'absolute', top: 0, left: 0, right: 0, height: brand.top + 44, backgroundColor: colors.ink, zIndex: 2 },
  title: { position: 'absolute', top: brand.top - 8, left: brand.left, fontFamily: fonts.semibold, fontSize: 30, lineHeight: 32, letterSpacing: -0.9, color: colors.paper },
  body: { paddingTop: brand.top + 48, paddingHorizontal: brand.left },
  lede: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.mute, marginTop: 6 },
  head: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 30, marginBottom: 6 },
  section: { fontFamily: fonts.regular, fontSize: 11, letterSpacing: 1.4, color: colors.mute },
  link: { fontFamily: fonts.medium, fontSize: 12, color: colors.spotText },
  note: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.mute, marginTop: 6 },
  meta: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: colors.mute, marginTop: 4 },
  live: { color: colors.spotText },
  small: { fontFamily: fonts.regular, fontSize: 10, letterSpacing: 1.4, color: colors.meta, marginBottom: 4 },
  card: { padding: 14, borderRadius: radius.md, backgroundColor: colors.ink2, marginTop: 4 },
  cardTitle: { flex: 1, fontFamily: fonts.semibold, fontSize: 17, letterSpacing: -0.3, color: colors.paper },
  cardLine: { fontFamily: fonts.medium, fontSize: 13, color: colors.paper, marginTop: 2 },
  cardFoot: { marginTop: 10 },
  between: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  mode: { paddingHorizontal: 10, height: 24, borderRadius: radius.pill, backgroundColor: colors.ink, justifyContent: 'center' },
  modeText: { fontFamily: fonts.medium, fontSize: 11.5, color: colors.paper },
  shares: { marginTop: 12, gap: 6 },
  share: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  shareName: { width: 96, fontFamily: fonts.regular, fontSize: 12, color: colors.paper },
  shareBar: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.ink3, overflow: 'hidden' },
  shareIn: { height: 6, borderRadius: 3, backgroundColor: colors.spot },
  shareGb: { width: 52, textAlign: 'right', fontFamily: fonts.jet, fontSize: 11, color: colors.mute },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.ink3 },
  rowText: { flex: 1, gap: 2 },
  name: { fontFamily: fonts.semibold, fontSize: 14.5, color: colors.paper },
  kind: { fontFamily: fonts.regular, fontSize: 12, color: colors.meta },
  line: { fontFamily: fonts.medium, fontSize: 14, lineHeight: 19, color: colors.paper },
  detail: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 16, color: colors.mute },
  time: { fontFamily: fonts.jet, fontSize: 10.5, color: colors.meta, marginTop: 2 },
  badge: { alignSelf: 'center', fontFamily: fonts.medium, fontSize: 11, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, borderWidth: 1, overflow: 'hidden' },
  more: { paddingVertical: 12 },
  counts: { flexDirection: 'row', gap: 10, marginTop: 12 },
  count: { flex: 1, backgroundColor: colors.ink2, borderRadius: radius.md, paddingVertical: 12, paddingHorizontal: 14 },
  countN: { fontFamily: fonts.semibold, fontSize: 24 },
  countLabel: { fontFamily: fonts.regular, fontSize: 12, color: colors.mute, marginTop: 2 },
  chain: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 12, paddingVertical: 10, paddingHorizontal: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.ink3 },
  chainBad: { borderColor: colors.violet, backgroundColor: 'rgba(200,106,81,0.08)' },
  chainText: { flex: 1, fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 17, color: colors.mute },
  chainBadText: { fontFamily: fonts.medium, color: colors.violet },
  dot: { width: 8, height: 8, borderRadius: 4 },
  wideBig: { fontFamily: fonts.semibold, fontSize: 28, letterSpacing: -0.8, color: colors.paper },
});
