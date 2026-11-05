import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { clearRefused, pendingJobs, useNet } from '@/lib/offline';
import { useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';

// What each kind of waiting job is called in the list under the bar.
const KIND: Record<string, string> = {
  swipe: 'offline.kind.keep', // a keep or let-go (the outbox job's first name)
  unswipe: 'offline.kind.keep',
  settings: 'offline.kind.settings',
  nightStart: 'offline.kind.night',
  nightEnd: 'offline.kind.night',
  passport: 'offline.kind.passport',
  friendRequest: 'offline.kind.friend',
  friendAccept: 'offline.kind.friend',
  friendRemove: 'offline.kind.friend',
  callAnswer: 'offline.kind.call',
  callCancel: 'offline.kind.call',
  dmSend: 'offline.kind.dm',
};

// While offline, a small line at the top: saved data is shown and how many writes are
// queued; tapping it lists what waits. "sending" while the queue flushes after
// reconnecting, and for a few seconds how many the server refused. Renders nothing
// otherwise.
export default function OfflineBar() {
  const { online, pending, sending, refused } = useNet();
  const { t, tx, tn, up } = useLang();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState(false);

  // Refusals show for five seconds, then the count goes back to zero.
  useEffect(() => {
    if (!refused) return;
    const timer = setTimeout(clearRefused, 5000);
    return () => clearTimeout(timer);
  }, [refused]);

  if (online && !sending && !refused) return null;
  const text = refused && !sending
    ? tn('offline.refused', refused)
    : online
      ? t('offline.sending')
      : [t('offline.title'), pending ? tn('offline.pending', pending) : t('offline.saved')].join(' · ');

  // The list: kinds with how many of each, in the order they were made.
  const counts = new Map<string, number>();
  if (open && pending) pendingJobs().forEach((j) => {
    const k = KIND[j.kind] ?? 'offline.kind.other';
    counts.set(k, (counts.get(k) ?? 0) + 1);
  });

  return (
    <View style={[styles.wrap, { top: insets.top + 4 }]} pointerEvents="box-none" accessibilityLiveRegion="polite">
      <Pressable
        onPress={() => pending && setOpen((o) => !o)}
        disabled={!pending}
        accessibilityRole={pending ? 'button' : undefined}
        style={[styles.pill, refused && !sending ? styles.pillRefused : null]}
      >
        <View style={[styles.dot, online && styles.dotOn]} />
        <Text style={styles.text}>{up(text)}</Text>
      </Pressable>
      {open && pending && counts.size ? (
        <View style={styles.list}>
          {[...counts].map(([k, n]) => (
            <Text key={k} style={styles.item}>
              {up(tx(k, k))} · {n}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center', zIndex: 50, elevation: 50 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: colors.ink, borderWidth: 1, borderColor: colors.ink3, paddingHorizontal: 12, paddingVertical: 5, borderRadius: radius.pill },
  pillRefused: { borderColor: colors.spot },
  dot: { width: 6, height: 6, borderRadius: 3, borderWidth: 1, borderColor: colors.mute },
  dotOn: { backgroundColor: colors.spot, borderColor: colors.spot },
  text: { fontFamily: fonts.regular, fontSize: 10, letterSpacing: 1.3, color: colors.paper },
  list: { marginTop: 6, backgroundColor: colors.ink, borderWidth: 1, borderColor: colors.ink3, borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 10, gap: 6 },
  item: { fontFamily: fonts.regular, fontSize: 10, letterSpacing: 1.3, color: colors.mute },
});
