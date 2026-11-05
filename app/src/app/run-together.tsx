import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import Button from '@/components/Button';
import InfoTip from '@/components/InfoTip';
import StaffPage from '@/components/StaffPage';
import ModelIcon, { type ModelIconName } from '@/components/models/ModelIcon';
import { ScanModal, usePeerAdd } from '@/components/models/PeerScan';
import { MainMark } from '@/components/models/Tags';
import { ModeCard, useModes } from '@/components/models/modes';
import { usePassport } from '@/data/passport';
import { useLang } from '@/i18n';
import { catalogById } from '@/llm/catalog';
import { probeAll } from '@/llm/cluster';
import { load, useEngine } from '@/llm/engine';
import { explain } from '@/llm/errors';
import { hasNative, llama, type PeerFound } from '@/llm/native';
import { isRemote } from '@/llm/peers';
import { localById, useLocalModels, usePeers, useSettings, type Mode, type Peer } from '@/llm/store';
import { tapSelect } from '@/lib/haptics';
import { colors, fonts, radius } from '@/theme/tokens';

// "connect to a phone to run this together" (6.11.2026, from the model page): one question
// at a time. 1 how to reach the other phone (scan its code, pick an added one, look on this
// wi-fi), 2 which devices join, 3 apart or split (the model page's own cards and estimates,
// for the devices picked here), 4 start. The phone this flow runs on is the main device: it
// holds the file, loads the model through engine.load() (the same path as the model page)
// and uses the others; they only lend memory and processor from "share this phone".
type Step = 'how' | 'who' | 'mode' | 'go';
const STEPS: Step[] = ['how', 'who', 'mode', 'go'];

export default function RunTogetherScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t, tx, up } = useLang();
  useLocalModels();
  const passport = usePassport();
  const settings = useSettings();
  const peers = usePeers();
  const engine = useEngine();
  const wanted = decodeURIComponent(id ?? '');
  const model = localById(wanted);
  const cat = catalogById(wanted);
  const name = (model?.name ?? cat?.name ?? wanted).toLowerCase();
  const [step, setStep] = useState<Step>(peers.length ? 'who' : 'how');
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(peers.map((p) => p.id)));
  const [ok, setOk] = useState<Record<string, boolean | null>>({});
  const [scan, setScan] = useState(false);
  const [nearby, setNearby] = useState<PeerFound[] | null>(null);
  const [looking, setLooking] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // a peer just added by its code joins at once, and the flow moves on to "which devices"
  const add = usePeerAdd((p) => {
    setScan(false);
    if (!p) return;
    setChosen((s) => new Set(s).add(p.id));
    setStep('who');
  });
  const picked = useMemo(() => peers.filter((p) => chosen.has(p.id)), [peers, chosen]);
  const modes = useModes(model, picked, settings.ctx);
  const [mode, setMode] = useState<Mode>(settings.lastMode === 'split' ? 'split' : 'apart');

  // reachability of every added device, once on the "which devices" step (lan on rpc, far on api)
  const peerKey = peers.map((p) => p.id).join(',');
  useEffect(() => {
    if (step !== 'who' || !peers.length) return;
    let on = true;
    Promise.all([probeAll(peers.filter((p) => !isRemote(p)), 'rpc'), probeAll(peers.filter(isRemote), 'api')]).then(([near, far]) => {
      if (!on) return;
      setOk({ ...Object.fromEntries([...near.ok, ...far.ok].map((p) => [p.id, true])), ...Object.fromEntries([...near.bad, ...far.bad].map((b) => [b.peer.id, false])) });
    }).catch(() => {});
    return () => { on = false; };
  }, [step, peerKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const findNearby = async () => {
    if (!hasNative()) return;
    setNearby([]);
    setLooking(true);
    const sub = llama!.addListener('onPeerFound', (f) => setNearby((xs) => (xs?.some((x) => x.id === f.id) ? xs : [...(xs ?? []), f])));
    await llama!.discover(true).catch(() => {});
    setTimeout(async () => {
      sub.remove();
      await llama!.discover(false).catch(() => {});
      setLooking(false);
    }, 5000);
  };
  const toggle = (p: Peer) => {
    tapSelect();
    setChosen((s) => {
      const n = new Set(s);
      if (n.has(p.id)) n.delete(p.id);
      else n.add(p.id);
      return n;
    });
  };
  const openScan = () => {
    add.setErr(null);
    setScan(true);
  };
  const start = async () => {
    if (!model || !picked.length) return;
    setErr(null);
    setBusy(true);
    try {
      // the same load the model page's mode sheet does; choosing split is choosing to share
      await load(model, mode, settings.ctx, picked, mode === 'split');
      router.push('/chat');
    } catch (e) {
      setErr(explain(e, tx));
    } finally {
      setBusy(false);
    }
  };

  const n = STEPS.indexOf(step);
  const back = n > 0 ? () => setStep(STEPS[n - 1]) : null;
  const cards = modes.cards.filter((c) => c.mode !== 'alone');
  const modeOff = cards.find((c) => c.mode === mode)?.off ?? null;
  const ownName = (passport?.device ?? t('devices.this')).toLowerCase();

  return (
    <StaffPage title={t('modelsui.rt.title')}>
      <View style={styles.lede}>
        <MainMark size={16} />
        <Text style={styles.ledeText}>{t('modelsui.rt.lede', { model: name })}</Text>
        <InfoTip title={t('modelsui.main.this')} text={t('modelsui.main.why')} />
      </View>

      <View style={styles.steps} accessibilityLabel={t('modelsui.rt.step', { n: n + 1, m: STEPS.length })}>
        {STEPS.map((s, i) => <View key={s} style={[styles.dot, i <= n && styles.dotOn]} />)}
        <Text style={styles.stepText}>{up(t('modelsui.rt.step', { n: n + 1, m: STEPS.length }))}</Text>
      </View>

      {step === 'how' ? (
        <>
          <Text style={styles.q}>{t('modelsui.rt.how')}</Text>
          <Choice icon="qr" title={t('modelsui.rt.scan')} hint={t('modelsui.rt.scan.hint')} onPress={openScan} />
          <Choice icon="list" title={t('modelsui.rt.added')} hint={peers.length ? t('modelsui.rt.added.hint', { n: peers.length }) : t('modelsui.rt.added.none')} off={!peers.length} onPress={() => setStep('who')} />
          {hasNative() ? <Choice icon="wifi" title={looking ? t('peers.searching') : t('modelsui.rt.nearby')} hint={t('modelsui.rt.nearby.hint')} onPress={findNearby} /> : null}
          {nearby && !looking && nearby.length === 0 ? <Text style={styles.note}>{t('modelsui.rt.nearby.none')}</Text> : null}
          {(nearby ?? []).map((f) => (
            <Pressable key={f.serviceName} onPress={openScan} accessibilityRole="button" accessibilityLabel={`${f.name} · ${t('peers.scan')}`} style={({ pressed }) => [styles.found, pressed && styles.pressed]}>
              <Text style={styles.foundName}>{f.name.toLowerCase()}<Text style={styles.meta}>  · {f.host}</Text></Text>
              <Text style={styles.link}>{t('peers.scan')} ›</Text>
            </Pressable>
          ))}
          <Pressable onPress={add.paste} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('peers.paste')} style={styles.linkHit}><Text style={styles.link}>{t('peers.paste')} ›</Text></Pressable>
          {add.note ? <Text style={styles.okText} accessibilityLiveRegion="polite">{add.note}</Text> : null}
          {add.err && !scan ? <Text style={styles.err} accessibilityRole="alert">{add.err}</Text> : null}
        </>
      ) : null}

      {step === 'who' ? (
        <>
          <Text style={styles.q}>{t('modelsui.rt.who')}</Text>
          <View style={styles.row}>
            <View style={[styles.box, styles.boxOn]} />
            <View style={styles.rowText}>
              <Text style={styles.name}>{ownName}</Text>
              <MainMark label={t('modelsui.main.this')} size={13} />
            </View>
          </View>
          {peers.map((p) => {
            const on = chosen.has(p.id);
            return (
              <Pressable key={p.id} onPress={() => toggle(p)} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={p.name} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                <View style={[styles.box, on && styles.boxOn]} />
                <View style={styles.rowText}>
                  <Text style={styles.name} numberOfLines={1}>{p.name.toLowerCase()}<Text style={styles.meta}>  · {t(`peers.kind.${p.kind}`)}</Text></Text>
                  <Text style={[styles.meta, ok[p.id] === true && styles.okSmall, ok[p.id] === false && styles.badSmall]}>{ok[p.id] == null ? '…' : ok[p.id] ? t('peers.ok') : t('peers.off')}</Text>
                </View>
              </Pressable>
            );
          })}
          <Pressable onPress={() => setStep('how')} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('modelsui.rt.add')} style={styles.linkHit}><Text style={styles.link}>+ {t('modelsui.rt.add')}</Text></Pressable>
          {!picked.length ? <Text style={styles.note}>{t('modelsui.rt.who.none')}</Text> : null}
        </>
      ) : null}

      {step === 'mode' ? (
        <>
          <Text style={styles.q}>{t('modelsui.rt.mode')}</Text>
          <View style={styles.cards} accessibilityRole="radiogroup">
            {cards.map((c) => <ModeCard key={c.mode} {...c} on={mode === c.mode} onPress={() => { tapSelect(); setMode(c.mode); }} />)}
          </View>
          <Text style={styles.note}>{t('mode.est.how')}</Text>
        </>
      ) : null}

      {step === 'go' ? (
        <>
          <Text style={styles.q}>{t('modelsui.rt.ready')}</Text>
          <View style={styles.card}>
            <View style={styles.kv}><Text style={styles.k}>{t('modelsui.rt.model')}</Text><Text style={styles.v}>{name}</Text></View>
            <View style={styles.kv}><Text style={styles.k}>{t('modelsui.rt.how.mode')}</Text><Text style={styles.v}>{cards.find((c) => c.mode === mode)?.title ?? mode}</Text></View>
            <View style={styles.kv}><Text style={styles.k}>{t('modelsui.rt.devices')}</Text><Text style={styles.v}>{[ownName, ...picked.map((p) => p.name.toLowerCase())].join(' · ')}</Text></View>
            <MainMark label={`${t('modelsui.main.this')} · ${ownName}`} size={14} />
          </View>
          {!model ? <Text style={styles.err}>{t('modelsui.rt.notOnPhone')}</Text> : null}
          {engine.loading && busy ? <Text style={styles.loading} accessibilityLiveRegion="polite">{tx(`model.loading.${engine.loading}`, engine.loading)}</Text> : null}
          {err ? <Text style={styles.err} accessibilityRole="alert">{err}</Text> : null}
        </>
      ) : null}

      <View style={styles.actions}>
        {step === 'who' ? <Button label={t('modelsui.rt.next')} onPress={() => setStep('mode')} kind="red" disabled={!picked.length} /> : null}
        {step === 'mode' ? <Button label={t('modelsui.rt.next')} onPress={() => setStep('go')} kind="red" disabled={!!modeOff} accessibilityHint={modeOff ?? undefined} /> : null}
        {step === 'go' ? <Button label={busy ? t('word.loading') : `${t('mode.go')} · ${name}`} onPress={busy ? undefined : start} kind="red" disabled={!model || busy || !picked.length || !!modeOff} /> : null}
        {back ? <Button label={t('word.back')} onPress={() => setStep(STEPS[n - 1])} kind="line" /> : null}
      </View>

      <ScanModal open={scan} err={add.err} onClose={() => setScan(false)} onData={add.take} onPaste={add.paste} />
    </StaffPage>
  );
}

function Choice({ icon, title, hint, off, onPress }: { icon: ModelIconName; title: string; hint: string; off?: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={() => { tapSelect(); onPress(); }} disabled={off} accessibilityRole="button" accessibilityLabel={title} accessibilityHint={hint} accessibilityState={{ disabled: !!off }} style={({ pressed }) => [styles.choice, off && styles.off, pressed && styles.pressed]}>
      <View style={styles.choiceIcon}><ModelIcon name={icon} size={22} color={colors.paper} /></View>
      <View style={styles.rowText}>
        <Text style={styles.name}>{title}</Text>
        <Text style={styles.meta}>{hint}</Text>
      </View>
      <Text style={styles.chev}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  lede: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ledeText: { flex: 1, fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: colors.paper2 },
  steps: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 18 },
  dot: { width: 18, height: 4, borderRadius: 2, backgroundColor: colors.ink3 },
  dotOn: { backgroundColor: colors.spot },
  stepText: { fontFamily: fonts.regular, fontSize: 10, letterSpacing: 1.4, color: colors.meta, marginLeft: 6 },
  q: { fontFamily: fonts.semibold, fontSize: 20, letterSpacing: -0.4, color: colors.paper, marginTop: 14, marginBottom: 8 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, marginTop: 8, borderRadius: radius.md, backgroundColor: colors.ink2, minHeight: 64 },
  choiceIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  chev: { fontFamily: fonts.medium, fontSize: 18, color: colors.mute },
  off: { opacity: 0.45 },
  found: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 12, minHeight: 48, borderBottomWidth: 1, borderBottomColor: colors.ink3 },
  foundName: { fontFamily: fonts.medium, fontSize: 14, color: colors.paper, flexShrink: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, minHeight: 56, borderBottomWidth: 1, borderBottomColor: colors.ink3 },
  rowText: { flex: 1, gap: 3 },
  name: { fontFamily: fonts.semibold, fontSize: 16, color: colors.paper },
  meta: { fontFamily: fonts.regular, fontSize: 12, color: colors.mute },
  okSmall: { color: colors.spotText },
  badSmall: { color: colors.violet },
  box: { width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, borderColor: colors.paper },
  boxOn: { backgroundColor: colors.spot, borderColor: colors.spot },
  cards: { gap: 8 },
  card: { marginTop: 4, padding: 14, borderRadius: radius.md, backgroundColor: colors.ink2, gap: 8 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  k: { fontFamily: fonts.regular, fontSize: 12, color: colors.mute },
  v: { fontFamily: fonts.medium, fontSize: 13, color: colors.paper, flexShrink: 1, textAlign: 'right' },
  note: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 17, color: colors.mute, marginTop: 10 },
  okText: { fontFamily: fonts.medium, fontSize: 12.5, color: colors.spotText, marginTop: 8 },
  err: { fontFamily: fonts.medium, fontSize: 13, color: colors.violet, marginTop: 12 },
  loading: { fontFamily: fonts.medium, fontSize: 13, color: colors.spotText, marginTop: 12 },
  link: { fontFamily: fonts.medium, fontSize: 13, color: colors.spotText },
  linkHit: { minHeight: 44, justifyContent: 'center', marginTop: 4 },
  actions: { marginTop: 24, gap: 10 },
  pressed: { opacity: 0.6 },
});
