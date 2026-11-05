import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import PullDownScroll from '@/components/PullDownScroll';
import EmptyState from '@/components/EmptyState';
import { useTabBarSpace } from '@/components/TabBar';
import { statusText, summaryText } from '@/components/tasks/status';
import { stateOf } from '@/tasks/schedule';
import { useRunNow } from '@/tasks/runNow';
import { useTasks } from '@/tasks/store';
import type { Task } from '@/tasks/types';
import { useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';
import { brand } from '@/theme/layout';

// Projects, the fourth tab (5.11.2026): the person's own night work. A new project is a
// question or a job with its hours (task/new.tsx); each row says where it stands (working
// now, begun, the answer ready, when it runs next); a row opens the project (task/[id].tsx).
// What is running comes first, then the answers, then what waits. All of it on the phone.
const ORDER = { running: 0, started: 1, ready: 2, waiting: 3, finished: 4, off: 5 } as const;

export default function ProjectsScreen() {
  const insets = useSafeAreaInsets();
  const tabSpace = useTabBarSpace();
  const { t } = useLang();
  const tasks = useTasks();
  const run = useRunNow();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const runningId = run && !run.error ? run.id : null;
  const sorted = [...tasks].sort((a, b) => ORDER[stateOf(a, runningId)] - ORDER[stateOf(b, runningId)] || (b.last?.at ?? b.createdAt) - (a.last?.at ?? a.createdAt));

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <PullDownScroll
        closable={false}
        header={<View style={styles.band}><Text style={styles.title}>{t('task.title')}</Text></View>}
        contentContainerStyle={[styles.body, { paddingBottom: tabSpace + insets.bottom + 28 }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.intro}>{t('task.intro')}</Text>
        <Pressable onPress={() => router.push('/task/new')} accessibilityRole="button" style={({ pressed }) => [styles.newRow, pressed && styles.pressed]}>
          <View style={styles.newMark}><Text style={styles.newPlus}>+</Text></View>
          <Text style={styles.newText}>{t('task.new')}</Text>
        </Pressable>

        {!tasks.length ? <EmptyState text={t('task.empty')} /> : (
          <View style={styles.panel}>
            <View style={styles.panelIn}>
              {sorted.map((task) => <TaskRow key={task.id} task={task} line={statusText(task, now, run, t)} summary={summaryText(task, t)} state={stateOf(task, runningId)} />)}
            </View>
          </View>
        )}
        <Text style={styles.limit}>{t('task.limit')}</Text>
      </PullDownScroll>
    </View>
  );
}

function TaskRow({ task, line, summary, state }: { task: Task; line: string; summary: string; state: keyof typeof ORDER }) {
  const lit = state === 'running' || state === 'started';
  return (
    <Pressable onPress={() => router.push({ pathname: '/task/[id]', params: { id: task.id } })} accessibilityRole="button" style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <View style={[styles.dot, lit && styles.dotLive, state === 'ready' && styles.dotReady, (state === 'off' || state === 'finished') && styles.dotOff]} />
      <View style={styles.text}>
        <Text style={styles.name} numberOfLines={1}>{task.title}</Text>
        <Text style={[styles.meta, (lit || state === 'ready') && styles.metaLive]} numberOfLines={2}>{line}</Text>
        <Text style={styles.meta} numberOfLines={1}>{summary}</Text>
      </View>
      <Text style={styles.more}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  band: { position: 'absolute', top: 0, left: 0, right: 0, height: brand.top + 44, backgroundColor: colors.ink, zIndex: 2 },
  title: { position: 'absolute', top: brand.top - 8, left: brand.left, fontFamily: fonts.semibold, fontSize: 30, lineHeight: 32, letterSpacing: -0.9, color: colors.paper },
  body: { paddingTop: brand.top + 48, paddingHorizontal: brand.left },
  intro: { fontFamily: fonts.regular, fontSize: 14.5, lineHeight: 21, color: colors.mute, marginTop: 10 },
  newRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 14, paddingVertical: 10 },
  newMark: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.spot, alignItems: 'center', justifyContent: 'center' },
  newPlus: { fontFamily: fonts.medium, fontSize: 20, lineHeight: 22, color: colors.ink },
  newText: { fontFamily: fonts.medium, fontSize: 15, color: colors.paper },
  panel: { borderWidth: 1, borderColor: colors.ink3, borderRadius: radius.md, overflow: 'hidden', marginTop: 8 },
  panelIn: { marginBottom: -1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 14, borderBottomWidth: 1, borderBottomColor: colors.ink3 },
  pressed: { opacity: 0.6 },
  dot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5, borderColor: colors.meta },
  dotLive: { backgroundColor: colors.spot, borderColor: colors.spot },
  dotReady: { backgroundColor: colors.gold, borderColor: colors.gold },
  dotOff: { borderColor: colors.ink3 },
  text: { flex: 1, gap: 3 },
  name: { fontFamily: fonts.medium, fontSize: 16, letterSpacing: -0.2, color: colors.paper },
  meta: { fontFamily: fonts.regular, fontSize: 11.5, lineHeight: 15, color: colors.meta },
  metaLive: { color: colors.spotText },
  more: { fontFamily: fonts.regular, fontSize: 16, color: colors.meta },
  limit: { fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 18, color: colors.mute, marginTop: 22 },
});
