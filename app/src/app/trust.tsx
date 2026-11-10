import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import StaffPage from '@/components/StaffPage';
import { Panel, Row, Value } from '@/components/Row';
import { TRUST_COLOR } from '@/components/brain/Trust';
import { lastPassport } from '@/data/passport';
import { useLang } from '@/i18n';
import { verifyChain } from '@/llm/audit';
import { hasNative, llama } from '@/llm/native';
import { peers as savedPeers } from '@/llm/store';
import { sayCheck, sayHeadline, selfTitle, type TrustCheck, type Verdict } from '@/llm/trust';
import { acceptTrust, checkTrust, startTrustRhythm, useTrustNotes, useTrustReport } from '@/llm/trustStore';
import { colors, fonts, radius } from '@/theme/tokens';

const LEDGER = 200; // this phone's own lines read for its chain

// brain → trust and verification (10.11.2026, src/llm/trust.ts): the cluster's security report
// when this phone is the master. One verdict on top, this phone's own ledger, then every paired
// device with its checks: pinned, encrypted, identity, refused today, ledger, key. A ledger that
// started over or does not hold stays red until the person says they know why.
export default function TrustScreen() {
  const { t, tx } = useLang();
  const notes = useTrustNotes();
  const [raw, setRaw] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  useFocusEffect(
    useCallback(() => {
      if (!hasNative()) return;
      llama!.auditLedger(LEDGER).catch(() => [] as string[]).then(setRaw);
      return startTrustRhythm();
    }, []),
  );
  const host = useMemo(() => (raw ? { ok: verifyChain(raw).ok, lines: raw.length } : null), [raw]);
  const report = useTrustReport(host);
  const me = selfTitle(lastPassport()?.device, t('brain.this'));

  const now = () => {
    if (busy) return;
    setBusy(true);
    checkTrust(savedPeers()).finally(() => setBusy(false));
  };
  const when = (ms: number) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <StaffPage title={t('trust.title')}>
      <Text style={styles.lede}>{t('trust.lede')}</Text>

      <View style={[styles.verdict, report.verdict === 'bad' && styles.verdictBad]} accessible accessibilityLiveRegion="polite">
        <View style={[styles.bigDot, { backgroundColor: TRUST_COLOR[report.verdict] }]} />
        <View style={styles.flex}>
          <Text style={[styles.verdictWord, { color: report.verdict === 'unknown' ? colors.paper2 : TRUST_COLOR[report.verdict] }]}>{t(`trust.verdict.${report.verdict}`)}</Text>
          <Text style={styles.headline}>{sayHeadline(report.headline, tx, me.name)}</Text>
        </View>
      </View>

      {/* this phone: its own ledger's chain */}
      <View style={styles.device}>
        <Title name={me.name} tag={me.tag} verdict={report.host.ok === false ? 'bad' : report.host.ok ? 'ok' : 'unknown'} />
        <CheckRow c={report.host} label={t('trust.k.ledger')} tx={tx} />
      </View>

      {report.devices.map((d) => {
        const n = notes[d.id];
        return (
          <View key={d.id} style={[styles.device, d.verdict === 'bad' && styles.deviceBad]}>
            <Title name={d.name} tag={n?.at ? t('trust.at', { at: when(n.at) }) : null} verdict={d.verdict} />
            {d.checks.map((c) => <CheckRow key={c.k} c={c} label={t(`trust.k.${c.k}`)} tx={tx} />)}
            {d.accept ? (
              <Pressable onPress={() => acceptTrust(d.id)} accessibilityRole="button" style={({ pressed }) => [styles.accept, pressed && styles.pressed]}>
                <Text style={styles.acceptText}>{t('trust.accept')}</Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}

      <Text style={styles.note}>{t('trust.note')}</Text>
      {hasNative() && report.devices.length ? (
        <Panel>
          <Row label={busy ? t('trust.checking') : t('trust.checkNow')} onPress={busy ? undefined : now} right={<Value text="" more />} />
        </Panel>
      ) : null}
    </StaffPage>
  );
}

function Title({ name, tag, verdict }: { name: string; tag: string | null; verdict: Verdict }) {
  const { t } = useLang();
  return (
    <View style={styles.title} accessible accessibilityRole="header" accessibilityLabel={`${name}${tag ? `, ${tag}` : ''}: ${t(`trust.verdict.${verdict}`)}`}>
      <View style={[styles.dot, { backgroundColor: TRUST_COLOR[verdict] }]} />
      <Text style={styles.name} numberOfLines={1}>
        {name}
        {tag ? <Text style={styles.tag}>  · {tag}</Text> : null}
      </Text>
      <Text style={[styles.word, { color: verdict === 'unknown' ? colors.meta : TRUST_COLOR[verdict] }]}>{t(`trust.verdict.${verdict}`)}</Text>
    </View>
  );
}

function CheckRow({ c, label, tx }: { c: TrustCheck; label: string; tx: (key: string, fallback?: string, vars?: Record<string, string | number>) => string }) {
  const color = c.ok === true ? colors.green : c.ok === false ? colors.violet : colors.meta;
  const text = sayCheck(c, tx);
  return (
    <View style={styles.check} accessible accessibilityLabel={`${label}: ${text}`}>
      <Text style={[styles.mark, { color }]}>{c.ok === true ? '✓' : c.ok === false ? '✕' : '–'}</Text>
      <View style={styles.flex}>
        <Text style={styles.label}>{label}</Text>
        <Text style={[styles.text, c.ok === false && { color: colors.violet }]}>{text}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  lede: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.mute },
  flex: { flex: 1 },
  verdict: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginTop: 18, padding: 14, borderRadius: radius.md, backgroundColor: colors.ink2, borderWidth: 1, borderColor: 'transparent' },
  verdictBad: { borderColor: colors.violet },
  bigDot: { width: 14, height: 14, borderRadius: 7, marginTop: 6 },
  verdictWord: { fontFamily: fonts.semibold, fontSize: 22, letterSpacing: -0.5 },
  headline: { fontFamily: fonts.regular, fontSize: 13.5, lineHeight: 19, color: colors.paper2, marginTop: 2 },
  device: { marginTop: 14, paddingHorizontal: 14, paddingVertical: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.ink3 },
  deviceBad: { borderColor: colors.violet },
  title: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 6 },
  dot: { width: 9, height: 9, borderRadius: 5 },
  name: { flex: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.paper },
  tag: { fontFamily: fonts.regular, fontSize: 12, color: colors.meta },
  word: { fontFamily: fonts.medium, fontSize: 12 },
  check: { flexDirection: 'row', gap: 10, paddingVertical: 6, borderTopWidth: 1, borderTopColor: colors.ink3 },
  mark: { width: 14, fontFamily: fonts.semibold, fontSize: 13, textAlign: 'center', marginTop: 1 },
  label: { fontFamily: fonts.regular, fontSize: 10.5, letterSpacing: 1, color: colors.meta },
  text: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18, color: colors.paper2 },
  accept: { alignSelf: 'flex-start', marginTop: 8, marginBottom: 4, paddingHorizontal: 12, height: 32, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.violet, justifyContent: 'center' },
  acceptText: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.violet },
  note: { fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18, color: colors.mute, marginTop: 18 },
  pressed: { opacity: 0.7 },
});
