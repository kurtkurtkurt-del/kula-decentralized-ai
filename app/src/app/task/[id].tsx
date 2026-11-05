import { useState } from 'react';
import { Alert, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import StaffPage, { Field, Quiet, Said, staffStyles } from '@/components/StaffPage';
import { Panel, Row, Section, Switch, Value } from '@/components/Row';
import Button from '@/components/Button';
import Markdown from '@/components/tasks/Markdown';
import { statusText, summaryText } from '@/components/tasks/status';
import { tapDone } from '@/lib/haptics';
import { modelFor } from '@/tasks/models';
import { forgetPhotos } from '@/tasks/photos';
import { stepsOf } from '@/tasks/prompts';
import { clearNowError, runNow, stopNow, useRunNow } from '@/tasks/runNow';
import { deleteTask, runAgain, updateTask, useTask } from '@/tasks/store';
import { stripThink } from '@/voice/text';
import type { Key } from '@/i18n/dict';
import { useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';

// One project (5.11.2026): where it stands, the answer when there is one (simple markdown,
// copy, share), the work behind it (draft and critiques) on request, "run again tonight"
// with a note, "run now" with its progress while the app is open, and its settings.
const two = (n: number) => String(n).padStart(2, '0');
const when = (ms: number) => {
  const d = new Date(ms);
  return `${two(d.getDate())}.${two(d.getMonth() + 1)}. ${two(d.getHours())}:${two(d.getMinutes())}`;
};

export default function TaskScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const task = useTask(id);
  const run = useRunNow();
  const { t } = useLang();
  const [work, setWork] = useState(false);
  const [note, setNote] = useState('');
  const [said, setSaid] = useState<{ text: string; bad?: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  if (!task) return <StaffPage title={t('task.edit.title')}><Quiet text={t('task.gone')} /></StaffPage>;
  const mine = run?.id === task.id ? run : null;
  const running = !!mine && !mine.error;
  const answer = task.last?.answer ?? '';
  const model = modelFor(task);

  const start = () => {
    setSaid(null);
    clearNowError();
    runNow(task.id).catch((e: Error) => {
      const k = e.message === 'busy' ? 'task.err.busy' : e.message === 'night' ? 'task.err.night' : e.message === 'nomodel' ? 'task.err.nomodel' : null;
      setSaid({ text: k ? t(k) : t('task.err.other', { why: e.message }), bad: true });
    });
  };
  const again = () => {
    runAgain(task.id, note);
    setNote('');
    setSaid({ text: t('task.again.done') });
  };
  const copy = () =>
    Clipboard.setStringAsync(answer).then(() => {
      tapDone();
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }, () => {});
  const share = () => Share.share({ message: `${task.title}\n\n${answer}` }).catch(() => {});
  const remove = () =>
    Alert.alert(t('task.delete'), t('task.delete.sure'), [
      { text: t('word.cancel'), style: 'cancel' },
      {
        text: t('task.delete'),
        style: 'destructive',
        onPress: () => {
          if (running) stopNow();
          deleteTask(task.id);
          forgetPhotos(task.id);
          router.back();
        },
      },
    ]);

  return (
    <StaffPage title={task.title}>
      <Text style={styles.status}>{statusText(task, new Date(), run, t)}</Text>
      <Text style={styles.summary}>{`${summaryText(task, t)} · ${(model?.name ?? '—').toLowerCase()}${task.chargeOnly ? ` · ${t('task.f.charge')}` : ''}`}</Text>
      {task.note ? <Text style={styles.summary}>{t('task.note.next', { note: task.note })}</Text> : null}

      {running ? (
        <View style={styles.live}>
          <Text style={styles.liveHead}>{`${t(`task.step.${mine!.step || stepsOf(task)[0]}` as Key)} · ${(mine!.index ?? 0) + 1}/${mine!.total || stepsOf(task).length}`}</Text>
          <Text style={styles.liveText} numberOfLines={8}>{stripThink(mine!.text).slice(-700) || '…'}</Text>
          <Button label={t('task.stop')} onPress={stopNow} kind="line" />
        </View>
      ) : null}

      <Section title={t('task.answer')} />
      {answer ? (
        <>
          <Text style={styles.summary}>{t('task.doneAt', { at: when(task.last!.at), model: (task.last!.model ?? '—').toLowerCase() })}{task.last!.note ? ` · ${t('task.note.used', { note: task.last!.note })}` : ''}</Text>
          <View style={styles.answer}><Markdown text={answer} /></View>
          <View style={styles.actions}>
            <Small label={copied ? t('task.copied') : t('task.copy')} onPress={copy} />
            <Small label={t('task.share')} onPress={share} />
            <Small label={work ? t('task.work.hide') : t('task.work.show')} onPress={() => setWork(!work)} />
          </View>
          {work ? (
            <View style={styles.work}>
              {task.last!.steps.slice(0, -1).map((s, i) => (
                <View key={i} style={styles.step}>
                  <Text style={styles.stepHead}>{`${t(`task.step.${s.name}` as Key).toUpperCase()} · ${t('task.step.meta', { tokens: s.tokens, s: Math.round(s.ms / 1000) })}`}</Text>
                  <Markdown text={s.text} />
                </View>
              ))}
              {task.last!.steps.length <= 1 ? <Quiet text={t('task.depth.quick')} /> : null}
            </View>
          ) : null}
        </>
      ) : (
        <Quiet text={t('task.noAnswer')} />
      )}

      <Section title={t('task.again')} />
      <Field label={t('task.again.note')} value={note} onChangeText={setNote} placeholder={t('task.again.ph')} autoCapitalize="sentences" autoCorrect />
      <View style={staffStyles.save}>
        <Button label={t('task.again')} onPress={again} />
        <Button label={t('task.runNow')} onPress={start} kind="line" disabled={running} accessibilityHint={t('task.runNow.hint')} />
      </View>
      <Said text={said?.text ?? (mine?.error ? t('task.err.other', { why: mine.error }) : null)} bad={said ? said.bad : true} />
      <Quiet text={t('task.runNow.hint')} />

      <Section title={t('task.prompt')} />
      <Text style={styles.prompt} selectable>{task.prompt}</Text>
      {task.photos.length ? (
        <>
          <View style={styles.photos}>
            {task.photos.map((uri) => <Image key={uri} source={{ uri }} style={styles.thumb} contentFit="cover" />)}
          </View>
          <Quiet text={t('task.f.photos.note')} />
        </>
      ) : null}

      <Panel>
        <Row label={t('task.f.on')} onPress={() => updateTask(task.id, { active: !task.active })} right={<Switch on={task.active} />} />
        <Row label={t('task.edit')} onPress={() => router.push({ pathname: '/task/new', params: { id: task.id } })} right={<Value text="" more />} />
        <Row label={t('task.delete')} onPress={remove} danger />
      </Panel>
    </StaffPage>
  );
}

function Small({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.small, pressed && styles.pressed]}>
      <Text style={styles.smallText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  status: { fontFamily: fonts.medium, fontSize: 15, color: colors.spotText, marginTop: 4 },
  summary: { fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18, color: colors.mute, marginTop: 6 },
  live: { marginTop: 16, padding: 14, borderRadius: radius.md, borderWidth: 1.5, borderColor: colors.spot, gap: 10 },
  liveHead: { fontFamily: fonts.regular, fontSize: 11, letterSpacing: 1.4, color: colors.spotText },
  liveText: { fontFamily: fonts.regular, fontSize: 13.5, lineHeight: 19, color: colors.paper },
  answer: { marginTop: 12 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 16 },
  small: { paddingHorizontal: 14, height: 34, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.ink3, justifyContent: 'center' },
  smallText: { fontFamily: fonts.medium, fontSize: 13, color: colors.paper },
  pressed: { opacity: 0.6 },
  work: { marginTop: 14, gap: 14 },
  step: { padding: 14, borderRadius: radius.md, backgroundColor: colors.ink2, gap: 8 },
  stepHead: { fontFamily: fonts.regular, fontSize: 11, letterSpacing: 1.2, color: colors.mute },
  prompt: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 22, color: colors.paper, marginTop: 10 },
  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 },
  thumb: { width: 76, height: 76, borderRadius: radius.sm, backgroundColor: colors.ink2 },
});
