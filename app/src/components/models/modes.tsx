import { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { usePassport, useLinked } from '@/data/passport';
import type { Passport } from '@/passport/contract';
import { useLang } from '@/i18n';
import { activeShare, fitOn, fitTogether, haveMb } from '@/llm/fit';
import { estimateAlone, modelProfile, NETWORKS, planShares, withMeasured, workerFromPeer, type Estimate, type SimDevice, type SplitPlan } from '@/llm/sim';
import { modelKey } from '@/llm/cluster';
import { measuredFor } from '@/bench/store';
import type { LocalModel, Mode, Peer } from '@/llm/store';
import { colors, fonts, radius } from '@/theme/tokens';

// The mode question's numbers and cards (6.11.2026: moved out of the model page so the
// "run this together" flow asks the same question with the same estimates, for the devices
// picked there instead of every saved one). The planner's own model (sim/) gives the numbers,
// the passport's fit the words.
export type ModeCardData = { mode: Mode; title: string; why: string; est: string; fit: string; off: string | null };

export function useModes(model: LocalModel | null, peers: Peer[], ctx: number) {
  const { t, tx } = useLang();
  const passport = usePassport();
  const linked = useLinked();
  const farPeers = peers.filter((p) => !!p.relay).length;
  const pool: Passport[] = useMemo(() => [...(passport ? [passport] : []), ...linked.map((l) => l.data)], [passport, linked]);
  const measuredHere = model ? measuredFor('self', modelKey(model)) : null;
  const fit = model ? fitOn(passport, { size: model.size, kv_mb_per_1k: model.kv_mb_per_1k, ctx, active: activeShare(model) }, measuredHere) : null;
  const together = model && pool.length > 1 ? fitTogether(pool, { size: model.size, kv_mb_per_1k: model.kv_mb_per_1k, ctx, active: activeShare(model) }) : null;
  // the same model the planner runs at load time (sim/model.ts), fed from the passport
  // (this phone) and the peers' qr numbers, on 5 ghz wi-fi: what each option would do
  const est = useMemo(() => {
    if (!model) return null;
    const sim = modelProfile(model);
    const bw = passport ? Number(passport.mem_bw_read_gbs) || Number(passport.mem_bw_gbs) || 4 : 4;
    const key = modelKey(model);
    const local: SimDevice = withMeasured({ id: 'me', capMb: Math.max(haveMb(passport), 1), bw, eff: 0.6 }, sim, measuredFor('self', key));
    const workers = peers.map((p) => withMeasured(workerFromPeer(p), sim, measuredFor(p.id, key)));
    const alone: Estimate = estimateAlone(sim, local);
    const apartTps = [local, ...workers].reduce((a, d) => a + estimateAlone(sim, d).tps, 0);
    let split: SplitPlan | null = null;
    let splitErr: string | null = null;
    if (workers.length) {
      try {
        split = planShares({ model: sim, ctx, local, workers, net: NETWORKS.wifi5, share: true });
      } catch (e) {
        splitErr = (e as Error).message;
      }
    }
    return { alone, apartTps: Math.round(apartTps * 10) / 10, split, splitErr };
  }, [model, passport, peers, ctx]);
  const nameOf = (id: string) => (id === 'me' ? (passport?.device ?? t('mode.alone')) : peers.find((p) => p.id === id)?.name ?? id).toLowerCase();
  const splitMeta = est?.split
    ? [t('mode.est.load', { s: Math.round(est.split.est.loadS) }), t('mode.est.tps', { tps: est.split.est.tps }), t('mode.est.token', { ms: Math.round(est.split.est.netMsPerToken) }),
      [{ id: 'me', assignedMb: est.split.localMb }, ...est.split.used].map((u) => `${nameOf(u.id)} ${(u.assignedMb / 1024).toFixed(1)} gb`).join(' · '),
      ...(est.split.aloneFaster && est.split.estAlone ? [t('mode.est.aloneFaster', { tps: est.split.estAlone.tps })] : [])].join('\n')
    : est?.splitErr ? tx(`model.err.${est.splitErr}`, est.splitErr) : '';

  // what each card says (5.11.2026): an estimate, a fit, one line of why, and, when it is
  // off, the reason
  const estWord = (f: { tps?: { low: number; high: number } | null } | null) => (f?.tps ? t('mode.est', { low: f.tps.low, high: f.tps.high }) : t('mode.estUnknown'));
  const fitWord = (v: 'fits' | 'tight' | 'no' | undefined) => (v === 'fits' ? t('mode.fit.fits') : v === 'tight' ? t('mode.fit.tight') : v === 'no' ? t('mode.fit.no') : '');
  const splitOff = !peers.length ? t('mode.off.noPeers') : together && together.verdict === 'no' ? t('mode.off.toobig') : null;
  const apartOff = !peers.length ? t('mode.off.noPeers') : null;
  const aloneEst = est ? `${t('mode.est.tps', { tps: est.alone.tps })} · ${t('mode.est.load', { s: Math.round(est.alone.loadS) })}` : estWord(fit);
  const apartEst = peers.length && est ? t('mode.est.together', { n: peers.length + 1, tps: est.apartTps }) : estWord(fit);
  const splitEst = splitMeta || estWord(together);
  const cards: ModeCardData[] = [
    { mode: 'alone', title: t('mode.alone'), why: fit?.verdict === 'no' ? t('mode.tryAnyway') : t('mode.alone.why'), est: aloneEst, fit: fitWord(fit?.verdict), off: null },
    { mode: 'apart', title: t('mode.apart'), why: `${t('mode.apart.why')} ${t('mode.beyin')}`, est: `${apartEst}${farPeers ? ` · ${t('mode.apart.remote', { n: farPeers })}` : ''}`, fit: fitWord(fit?.verdict), off: apartOff },
    { mode: 'split', title: t('mode.split'), why: `${t('mode.split.why')}${farPeers ? ` ${t('mode.split.remote', { n: farPeers })}.` : ''}`, est: splitEst, fit: together ? (together.verdict === 'no' ? t('mode.fit.no') : t('mode.fit.together')) : '', off: splitOff ?? (peers.length && est && !est.split ? (est.splitErr ? tx(`model.err.${est.splitErr}`, est.splitErr) : t('mode.off.toobig')) : null) },
  ];
  return { fit, together, est, cards, splitEst, estWord, fitWord };
}

export function ModeCard({ title, why, est, fit, off, on, onPress }: ModeCardData & { on: boolean; onPress: () => void }) {
  const { t } = useLang();
  const label = [title, fit, est, off ?? ''].filter(Boolean).join(', ');
  return (
    <Pressable onPress={onPress} disabled={!!off} accessibilityRole="radio" accessibilityState={{ selected: on, checked: on, disabled: !!off }} accessibilityLabel={label} style={({ pressed }) => [styles.card, on && styles.cardOn, off && styles.off, pressed && styles.pressed]}>
      <View style={styles.cardTop}>
        <View style={[styles.radio, on && styles.radioOn]}>{on ? <View style={styles.radioDot} /> : null}</View>
        <Text style={styles.optTitle} numberOfLines={2}>{title}</Text>
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
  card: { padding: 14, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.ink3, backgroundColor: colors.ink2, gap: 8, minHeight: 44 },
  cardOn: { borderColor: colors.spot, backgroundColor: colors.ink },
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
  optWhy: { fontFamily: fonts.regular, fontSize: 12.5, color: colors.paper2, lineHeight: 17 },
  optMeta: { fontFamily: fonts.jet, fontSize: 11, lineHeight: 15, color: colors.spotText, flexShrink: 1 },
  pressed: { opacity: 0.6 },
});
