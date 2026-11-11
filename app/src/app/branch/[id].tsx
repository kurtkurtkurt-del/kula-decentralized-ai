import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { BRANCH_IDS, type BranchId } from '@godseye/core';
import StaffPage from '@/components/StaffPage';
import Trust from '@/components/brain/Trust';
import { EyeCards } from '@/components/brain/Eye';
import { lastPassport } from '@/data/passport';
import { actOf, applyCard, branchOf, dismissCard, holdEye, useEyeView } from '@/eye/run';
import { useLang } from '@/i18n';
import { verifyChain } from '@/llm/audit';
import { hasNative, llama } from '@/llm/native';
import { selfTitle } from '@/llm/trust';
import { startTrustRhythm, useTrustReport } from '@/llm/trustStore';
import { colors, fonts, radius } from '@/theme/tokens';

// brain → one of the twelve (11.11.2026, src/eye/): the branch's page as the computer's panel
// draws it, on the phone: its line on the map, its gauge and few words, what it sees (key, value),
// its list and its note in its own words, and its cards. Trust and verification is the phone's
// own security report (src/eye/trustBranch.ts), drawn as on the brain tab. The eye keeps looking
// while the page is open.
export default function BranchScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const branch = (BRANCH_IDS as string[]).includes(id ?? '') ? (id as BranchId) : null;
  const { t, tx } = useLang();
  const view = useEyeView();
  useFocusEffect(useCallback(() => holdEye('branch'), []));
  const b = branch ? branchOf(view, branch) : null;
  const cards = useMemo(() => (view?.cards ?? []).filter((c) => c.branch === branch), [view, branch]);

  if (!branch) {
    return (
      <StaffPage title={t('eye.title')}>
        <Text style={styles.lede}>{t('eye.page.gone')}</Text>
      </StaffPage>
    );
  }
  const gauge = b && typeof b.gauge === 'number' && Number.isFinite(b.gauge) ? Math.max(0, Math.min(100, b.gauge)) : null;
  return (
    <StaffPage title={tx(`eye.branch.${branch}`, branch)}>
      <Text style={styles.lede}>{tx(`eye.what.${branch}`, b?.what ?? '')}</Text>
      {!b ? (
        <Text style={styles.lede}>{t('eye.waiting')}</Text>
      ) : (
        <>
          <View style={styles.head} accessible accessibilityLabel={b.error ? t('eye.broken', { why: b.error }) : b.built ? b.stat : t('eye.dark')}>
            <Text style={[styles.stat, b.error ? { color: colors.violet } : null]}>{b.error ? t('eye.broken', { why: b.error }) : b.built ? b.stat : t('eye.dark')}</Text>
            {gauge != null ? (
              <View style={styles.track}>
                <View style={[styles.fill, { width: `${gauge}%` }]} />
              </View>
            ) : null}
          </View>

          {cards.length ? <EyeCards cards={cards} actOf={(c) => actOf(c)} apply={applyCard} dismiss={dismissCard} /> : null}

          {branch === 'trust' ? <TrustPart /> : null}

          {b.rows.length && branch !== 'trust' ? (
            <>
              <Text style={styles.section}>{t('eye.page.sees')}</Text>
              <View style={styles.panel}>
                {b.rows.map(([k, v], i) => (
                  <View key={`${k}-${i}`} style={[styles.row, i > 0 && styles.rule]}>
                    <Text style={styles.key}>{k}</Text>
                    <Text style={styles.value}>{v}</Text>
                  </View>
                ))}
              </View>
            </>
          ) : null}

          {b.lines.length ? (
            <>
              <Text style={styles.section}>{t('eye.page.list')}</Text>
              <View style={styles.panel}>
                {b.lines.map((l, i) => (
                  <Text key={i} style={[styles.line, i > 0 && styles.rule]}>{l}</Text>
                ))}
              </View>
            </>
          ) : null}
          {b.note ? <Text style={styles.note}>{b.note}</Text> : null}
          <Text style={styles.foot}>{t('eye.page.words')}</Text>
        </>
      )}
    </StaffPage>
  );
}

/** Branch 8: the phone's own security report, localized, with the way to the full screen. */
function TrustPart() {
  const { t } = useLang();
  const [raw, setRaw] = useState<string[] | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!hasNative()) return;
      llama!.auditLedger(200).catch(() => [] as string[]).then(setRaw);
      return startTrustRhythm();
    }, []),
  );
  const host = useMemo(() => (raw ? { ok: verifyChain(raw).ok, lines: raw.length } : null), [raw]);
  const report = useTrustReport(host);
  return (
    <>
      <Trust report={report} self={selfTitle(lastPassport()?.device, t('brain.this')).name} onPress={() => router.push('/trust')} />
      <Pressable onPress={() => router.push('/trust')} accessibilityRole="button" hitSlop={8} style={styles.more}>
        <Text style={styles.link}>{t('eye.page.report')} ›</Text>
      </Pressable>
    </>
  );
}

const styles = StyleSheet.create({
  lede: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.paper2, marginBottom: 12 },
  head: { padding: 14, borderRadius: radius.md, backgroundColor: colors.ink2, gap: 8, marginBottom: 10 },
  stat: { fontFamily: fonts.semibold, fontSize: 18, letterSpacing: -0.3, color: colors.paper },
  track: { height: 4, borderRadius: 2, backgroundColor: colors.ink3, overflow: 'hidden' },
  fill: { height: 4, borderRadius: 2, backgroundColor: colors.spot },
  section: { fontFamily: fonts.regular, fontSize: 11, letterSpacing: 1.4, color: colors.mute, marginTop: 22, marginBottom: 6 },
  panel: { borderRadius: radius.md, backgroundColor: colors.ink2, paddingHorizontal: 14 },
  row: { paddingVertical: 10, gap: 2 },
  rule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.ink3 },
  key: { fontFamily: fonts.regular, fontSize: 12, color: colors.mute },
  value: { fontFamily: fonts.medium, fontSize: 13.5, lineHeight: 18, color: colors.paper },
  line: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, color: colors.paper2, paddingVertical: 9 },
  note: { fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 17, color: colors.mute, marginTop: 10 },
  foot: { fontFamily: fonts.regular, fontSize: 11, color: colors.meta, marginTop: 18 },
  more: { paddingVertical: 12 },
  link: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.spotText },
});
