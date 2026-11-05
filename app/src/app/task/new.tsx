import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import StaffPage, { Choice, Field, Quiet, Said, staffStyles } from '@/components/StaffPage';
import { Panel, Row, Section, Switch } from '@/components/Row';
import Button from '@/components/Button';
import { nightWindow } from '@/data/settings';
import { useLocalModels } from '@/llm/store';
import { estimate } from '@/tasks/estimate';
import { bestModel, modelFor, tpsFor } from '@/tasks/models';
import { MAX_PHOTOS, forgetPhoto, forgetPhotos, keepPhoto, pickPhotos, type PickFrom } from '@/tasks/photos';
import { isThinking } from '@/tasks/prompts';
import { hhmm } from '@/tasks/schedule';
import { createTask, getTask, newId, updateTask } from '@/tasks/store';
import { DAYS, DEPTHS, FORMS, LENGTHS, type Days, type Depth, type Form, type Length, type TaskInput } from '@/tasks/types';
import type { Key } from '@/i18n/dict';
import { useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';

// A new project, or an existing one (?id=…): what you want, its photos, the answer's form
// and length; then the calibration for the night (its hours, from the night window by
// default; which nights; how carefully; the model; only on charge) with an estimate of
// what fits tonight before it is saved. Saved on the phone only (tasks/store.ts).
const HOURS = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
const BEST = 'best';

export default function NewTaskScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const editing = id ? getTask(id) : null;
  const { t } = useLang();
  const models = useLocalModels();
  const night = nightWindow();
  const [draftId] = useState(() => editing?.id ?? newId());
  const [f, setF] = useState<TaskInput>(() =>
    editing
      ? { title: editing.title, prompt: editing.prompt, photos: editing.photos, form: editing.form, length: editing.length, from: editing.from, to: editing.to, days: editing.days, depth: editing.depth, modelId: editing.modelId, chargeOnly: editing.chargeOnly }
      : { title: '', prompt: '', photos: [], form: 'long', length: 'medium', from: night.from, to: night.to, days: 'every', depth: 'careful', modelId: null, chargeOnly: true },
  );
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // a new project left without saving takes its photos with it
  const saved = useRef(false);
  const isEdit = !!editing;
  useEffect(() => () => {
    if (!isEdit && !saved.current) forgetPhotos(draftId);
  }, [isEdit, draftId]);
  const set = <K extends keyof TaskInput>(k: K, v: TaskInput[K]) => setF((x) => ({ ...x, [k]: v }));

  const best = useMemo(() => bestModel(), [models]); // eslint-disable-line react-hooks/exhaustive-deps -- re-read when the downloads change
  const model = modelFor(f);
  const speed = tpsFor(model);
  const est = estimate({ tps: speed?.tps ?? null, from: f.from, to: f.to, depth: f.depth, length: f.length, thinking: isThinking(model?.id), promptChars: f.title.length + f.prompt.length, now: new Date() });

  const addPhotos = async (from: PickFrom) => {
    setSaid(null);
    try {
      const picked = await pickPhotos(from, MAX_PHOTOS - f.photos.length);
      const kept: string[] = [];
      for (const p of picked) kept.push(await keepPhoto(draftId, p));
      if (kept.length) setF((x) => ({ ...x, photos: [...x.photos, ...kept].slice(0, MAX_PHOTOS) }));
    } catch (e) {
      setSaid((e as Error).message === 'denied' ? t('task.f.photos.denied') : (e as Error).message);
    }
  };
  const removePhoto = (uri: string) => {
    // a photo of a saved project goes when the project is saved without it
    if (!editing?.photos.includes(uri)) forgetPhoto(uri);
    set('photos', f.photos.filter((p) => p !== uri));
  };
  const save = () => {
    if (!f.title.trim() || !f.prompt.trim()) return setSaid(t('task.needs'));
    setBusy(true);
    saved.current = true;
    const input = { ...f, title: f.title.trim(), prompt: f.prompt.trim() };
    if (editing) {
      editing.photos.filter((p) => !input.photos.includes(p)).forEach(forgetPhoto);
      updateTask(editing.id, input);
      router.back();
    } else {
      const made = createTask(input, Date.now(), draftId);
      router.replace({ pathname: '/task/[id]', params: { id: made.id } });
    }
  };

  const opts = <T extends string>(list: readonly T[], prefix: string) => list.map((v) => ({ id: v, label: t(`${prefix}.${v}` as Key) }));
  const modelOptions = [{ id: BEST, label: best ? t('task.model.best', { name: best.name.toLowerCase() }) : t('task.model.none') }, ...models.map((m) => ({ id: m.id, label: m.name.toLowerCase() }))];

  return (
    <StaffPage title={t(editing ? 'task.edit.title' : 'task.new.title')}>
      <Field label={t('task.f.title')} value={f.title} onChangeText={(v) => set('title', v)} placeholder={t('task.f.title.ph')} autoCapitalize="sentences" maxLength={80} />
      <Field label={t('task.f.prompt')} value={f.prompt} onChangeText={(v) => set('prompt', v)} placeholder={t('task.f.prompt.ph')} multiline autoCapitalize="sentences" autoCorrect />

      <Section title={t('task.f.photos')} />
      <View style={styles.photos}>
        {f.photos.map((uri) => (
          <Pressable key={uri} onPress={() => removePhoto(uri)} accessibilityRole="button" accessibilityLabel={t('task.f.photos.remove')} style={styles.thumbWrap}>
            <Image source={{ uri }} style={styles.thumb} contentFit="cover" />
            <Text style={styles.x}>×</Text>
          </Pressable>
        ))}
        {f.photos.length < MAX_PHOTOS ? (
          <>
            <Pick label={t('task.f.camera')} onPress={() => addPhotos('camera')} />
            <Pick label={t('task.f.library')} onPress={() => addPhotos('library')} />
          </>
        ) : null}
      </View>
      <Quiet text={t('task.f.photos.note')} />

      <Choice label={t('task.f.form')} value={f.form} options={opts(FORMS, 'task.form')} onSelect={(v) => set('form', v as Form)} />
      <Choice label={t('task.f.length')} value={f.length} options={opts(LENGTHS, 'task.length')} onSelect={(v) => set('length', v as Length)} />

      <View style={staffStyles.gap} />
      <Section title={t('task.night')} />
      <View style={styles.pair}>
        <View style={styles.half}><Choice label={t('task.f.from')} value={f.from} options={HOURS.map((h) => ({ id: h, label: h }))} onSelect={(v) => set('from', v)} /></View>
        <View style={styles.half}><Choice label={t('task.f.to')} value={f.to} options={HOURS.map((h) => ({ id: h, label: h }))} onSelect={(v) => set('to', v)} /></View>
      </View>
      <Choice label={t('task.f.days')} value={f.days} options={opts(DAYS, 'task.days')} onSelect={(v) => set('days', v as Days)} />
      <Choice label={t('task.f.depth')} value={f.depth} options={opts(DEPTHS, 'task.depth')} onSelect={(v) => set('depth', v as Depth)} />
      <Choice label={t('task.f.model')} value={f.modelId ?? BEST} options={modelOptions} onSelect={(v) => set('modelId', v === BEST ? null : v)} />
      <Panel>
        <Row label={t('task.f.charge')} hint={t('task.f.charge.hint')} onPress={() => set('chargeOnly', !f.chargeOnly)} right={<Switch on={f.chargeOnly} />} />
      </Panel>

      <View style={[styles.est, est.kind === 'over' && styles.estOver]}>
        <Text style={styles.estKicker}>{t('task.est.title').toUpperCase()}</Text>
        {!model ? (
          <Text style={styles.estLine}>{t('task.model.none')}</Text>
        ) : est.kind === 'unknown' ? (
          <Text style={styles.estLine}>{t('task.est.unknown')}</Text>
        ) : (
          <>
            <Text style={styles.estLine}>{est.kind === 'fits' ? t('task.est.fits', { words: est.words, at: hhmm(est.doneAt) }) : t('task.est.over')}</Text>
            <Text style={styles.estMeta}>{`${t('task.est.detail', { steps: est.steps, min: Math.max(1, Math.round(est.seconds / 60)), tps: speed!.tps })} · ${t(speed!.measured ? 'task.est.measured' : 'task.est.guess')}`}</Text>
          </>
        )}
      </View>

      <Said text={said} bad />
      <View style={staffStyles.save}>
        <Button label={t('task.save')} onPress={save} disabled={busy} />
      </View>
    </StaffPage>
  );
}

function Pick({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.pick, pressed && styles.pressed]}>
      <Text style={styles.pickPlus}>+</Text>
      <Text style={styles.pickText} numberOfLines={2}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 10 },
  thumbWrap: { width: 76, height: 76, borderRadius: radius.sm, overflow: 'hidden', backgroundColor: colors.ink2 },
  thumb: { width: '100%', height: '100%' },
  x: { position: 'absolute', top: 2, right: 6, fontFamily: fonts.semibold, fontSize: 16, color: colors.ink, textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 3 },
  pick: { width: 76, height: 76, borderRadius: radius.sm, borderWidth: 1.5, borderStyle: 'dashed', borderColor: colors.mute, alignItems: 'center', justifyContent: 'center', padding: 4 },
  pickPlus: { fontFamily: fonts.medium, fontSize: 20, lineHeight: 22, color: colors.mute },
  pickText: { fontFamily: fonts.regular, fontSize: 10.5, color: colors.mute, textAlign: 'center' },
  pressed: { opacity: 0.6 },
  pair: { flexDirection: 'row', gap: 16 },
  half: { flex: 1 },
  est: { marginTop: 22, padding: 14, borderRadius: radius.md, backgroundColor: colors.ink2, gap: 6 },
  estOver: { borderWidth: 1.5, borderColor: colors.spotText },
  estKicker: { fontFamily: fonts.regular, fontSize: 11, letterSpacing: 1.4, color: colors.mute },
  estLine: { fontFamily: fonts.medium, fontSize: 16, lineHeight: 22, color: colors.paper },
  estMeta: { fontFamily: fonts.regular, fontSize: 12, color: colors.mute },
});
