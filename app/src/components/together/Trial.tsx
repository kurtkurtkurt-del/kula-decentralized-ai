import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import Button from '@/components/Button';
import PickerSheet from '@/components/PickerSheet';
import { useLang } from '@/i18n';
import { engine, load, useEngine } from '@/llm/engine';
import { explain } from '@/llm/errors';
import { hasNative, llama } from '@/llm/native';
import { useLocalModels, useSettings, type Peer } from '@/llm/store';
import { tapDone, tapFail } from '@/lib/haptics';
import { speedTest, trialModel, TRIAL_TOKENS, type Speed } from '@/components/together/tests';
import { colors, fonts, radius, tint } from '@/theme/tokens';

// Part 3, try it: two small tests on the connected phones. A ping (the gate, a few knocks
// each; the result shows beside every phone in part 2) and a speed test: the model loaded
// apart (a copy on every phone, as the mode question would), then each device answers one
// short prompt at the same time; per device tok/s, the sum, and how many times this phone
// alone that is. No android module, no model: a sentence says so instead of a button.
type Props = { peers: Peer[]; pinging: boolean; onPing: () => void };

export default function Trial({ peers, pinging, onPing }: Props) {
  const { t, tx, up } = useLang();
  const e = useEngine();
  const models = useLocalModels().filter((m) => !!m.path);
  const settings = useSettings();
  const [chosen, setChosen] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<Speed | null>(null);

  if (!hasNative()) return <Text style={s.quiet}>{t('power.noNative')}</Text>;

  const model = chosen ? models.find((m) => m.id === chosen) ?? null : trialModel(models, e.model, settings.modelId);
  const ready = !!model && e.model?.id === model.id && e.mode === 'apart' && !!e.load && !e.loading;
  const busy = running || !!e.loading || e.generating;

  const go = async () => {
    if (!model || busy) return;
    setErr(null);
    setRes(null);
    setRunning(true);
    llama?.keepScreenOn(true).catch(() => {});
    try {
      if (!ready) await load(model, 'apart', settings.ctx, peers);
      const r = await speedTest(engine().devices);
      setRes(r);
      tapDone();
    } catch (x) {
      tapFail();
      setErr(explain(x, tx));
    } finally {
      setRunning(false);
      llama?.keepScreenOn(false).catch(() => {});
    }
  };

  const max = res ? Math.max(1, ...res.rows.map((r) => r.tps)) : 1;
  const skipped = ready || res ? e.plan?.skipped ?? [] : [];

  return (
    <View>
      {/* ping */}
      <View style={s.block}>
        <View style={s.blockHead}>
          <Text style={s.blockTitle}>{t('power.ping')}</Text>
          <Text style={s.blockKind}>{up(t('power.ping.kind'))}</Text>
        </View>
        <Text style={s.hint}>{t('power.ping.hint')}</Text>
        {peers.length ? (
          <View style={s.btnRow}><Button label={pinging ? t('power.ping.busy') : t('power.ping.run')} onPress={onPing} kind="line" disabled={pinging} /></View>
        ) : (
          <Text style={s.quiet}>{t('power.needPeer')}</Text>
        )}
      </View>

      {/* speed */}
      <View style={s.block}>
        <View style={s.blockHead}>
          <Text style={s.blockTitle}>{t('power.speed')}</Text>
          <Text style={s.blockKind}>{up(t('power.speed.kind', { n: TRIAL_TOKENS }))}</Text>
        </View>
        <Text style={s.hint}>{t('power.speed.hint')}</Text>
        {!model ? (
          <>
            <Text style={s.quiet}>{t('power.noModel')}</Text>
            <View style={s.btnRow}><Button label={t('power.noModel.go')} onPress={() => router.push('/models')} kind="line" /></View>
          </>
        ) : (
          <>
            <Pressable onPress={models.length > 1 && !busy ? () => setPicking(true) : undefined} disabled={models.length < 2 || busy} accessibilityRole="button" style={s.modelRow}>
              <Text style={s.modelK}>{t('bench.model')}</Text>
              <Text style={s.modelV} numberOfLines={1}>{model.name.toLowerCase()}{models.length > 1 ? '  ›' : ''}</Text>
            </Pressable>
            {!peers.length ? <Text style={s.quiet}>{t('power.speed.alone')}</Text> : null}
            {e.loading ? (
              <View style={s.live}><Text style={s.liveText}>{t('power.speed.loading', { what: e.loading })}</Text></View>
            ) : running ? (
              <View style={s.live}><Text style={s.liveText}>{t('power.speed.running')}</Text></View>
            ) : (
              <View style={s.btnRow}>
                <Button label={ready ? t('power.speed.run') : t('power.speed.load')} onPress={go} kind="red" disabled={busy} />
                {!ready && e.model ? <Text style={s.small}>{t('power.speed.replace', { what: `${e.model.name.toLowerCase()} · ${e.mode}` })}</Text> : null}
                {e.generating ? <Text style={s.small}>{t('power.busy')}</Text> : null}
              </View>
            )}
          </>
        )}
        {err ? <Text style={s.err} accessibilityRole="alert">{err}</Text> : null}

        {res ? (
          <View style={s.card}>
            {res.rows.map((r) => (
              <View key={r.id} style={s.bar}>
                <View style={s.barHead}>
                  <Text style={s.barName} numberOfLines={1}>{r.local ? t('devices.this') : r.name.toLowerCase()}</Text>
                  <Text style={[s.barVal, !!r.error && s.errText]}>{r.error ? t('power.speed.failed') : `${r.tps} tok/s`}</Text>
                </View>
                {r.error ? <Text style={s.small} numberOfLines={2}>{explain(new Error(r.error), tx)}</Text> : (
                  <View style={s.track}><View style={[s.fill, { width: `${Math.max(4, (r.tps / max) * 100)}%` }]} /></View>
                )}
              </View>
            ))}
            <View style={s.total}>
              <Text style={s.totalK}>{up(t('power.speed.total'))}</Text>
              <Text style={s.big}>{res.total}<Text style={s.unit}> tok/s</Text></Text>
              {res.times ? <Text style={s.times}>{t('power.speed.times', { x: res.times })}</Text> : null}
              <Text style={s.small}>{t('power.speed.tokens', { n: res.tokens, s: Math.round(res.wallMs / 100) / 10 })}</Text>
            </View>
          </View>
        ) : null}
        {skipped.map((b) => (
          <Text key={b.peer.id} style={s.small}>{t('power.speed.skipped', { name: b.peer.name.toLowerCase(), why: tx(`peers.err.${b.why}`, explain(new Error(b.why), tx)) })}</Text>
        ))}
      </View>

      <PickerSheet open={picking} title={t('bench.model')} options={models.map((m) => ({ id: m.id, label: m.name.toLowerCase(), extra: m.quant }))} selected={model?.id ?? null}
        onSelect={(id) => { setChosen(id); setPicking(false); setRes(null); }} onClose={() => setPicking(false)} />
    </View>
  );
}

const s = StyleSheet.create({
  block: { marginTop: 12, paddingVertical: 14, paddingHorizontal: 14, borderWidth: 1, borderColor: colors.ink3, borderRadius: radius.md, gap: 6 },
  blockHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
  blockTitle: { fontFamily: fonts.semibold, fontSize: 16, color: colors.paper },
  blockKind: { fontFamily: fonts.jet, fontSize: 9.5, letterSpacing: 1.1, color: colors.meta },
  hint: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 19, color: colors.mute },
  quiet: { fontFamily: fonts.regular, fontSize: 13.5, lineHeight: 19, color: colors.mute, marginTop: 6 },
  btnRow: { marginTop: 8, gap: 8 },
  small: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: colors.mute, marginTop: 4 },
  modelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, minHeight: 44, borderBottomWidth: 1, borderBottomColor: colors.ink3 },
  modelK: { fontFamily: fonts.regular, fontSize: 13, color: colors.mute },
  modelV: { flexShrink: 1, fontFamily: fonts.jet, fontSize: 12.5, color: colors.paper },
  live: { marginTop: 8, padding: 14, borderRadius: radius.md, backgroundColor: colors.ink2 },
  liveText: { fontFamily: fonts.semibold, fontSize: 14, color: colors.spotText },
  err: { fontFamily: fonts.medium, fontSize: 13, color: colors.violet, marginTop: 8 },
  errText: { color: colors.violet },
  card: { marginTop: 12, padding: 14, borderRadius: radius.md, backgroundColor: colors.ink2, gap: 12 },
  bar: { gap: 5 },
  barHead: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  barName: { flexShrink: 1, fontFamily: fonts.medium, fontSize: 13, color: colors.paper },
  barVal: { fontFamily: fonts.jet, fontSize: 12.5, color: colors.paper },
  track: { height: 8, borderRadius: 4, backgroundColor: tint(0.15), overflow: 'hidden' },
  fill: { height: 8, borderRadius: 4, backgroundColor: colors.spot },
  total: { paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.rule, gap: 2 },
  totalK: { fontFamily: fonts.regular, fontSize: 10, letterSpacing: 1.4, color: colors.spotText },
  big: { fontFamily: fonts.logo, fontSize: 40, lineHeight: 46, color: colors.paper },
  unit: { fontFamily: fonts.regular, fontSize: 14, color: colors.mute },
  times: { fontFamily: fonts.semibold, fontSize: 14, color: colors.spotText },
});
