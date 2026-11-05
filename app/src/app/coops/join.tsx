import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import StaffPage, { Said } from '@/components/StaffPage';
import Button from '@/components/Button';
import Input from '@/components/Input';
import { useAuth } from '@/auth/AuthContext';
import { COOP_COLORS, coopJoin, coopPeek, testCoopCodes, why, type Peek } from '@/data/coops';
import { useTestPeople } from '@/data/local/gate';
import { TestTag } from '@/components/connect/TestTag';
import { invalidate } from '@/lib/offline';
import { useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';

// Join with a code (typed or from a link): look first, then come in.
export default function JoinCoopScreen() {
  const { c } = useLocalSearchParams<{ c?: string }>();
  const { t } = useLang();
  const { ensureSession } = useAuth();
  const [code, setCode] = useState(c ?? '');
  const [peek, setPeek] = useState<Peek | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [testOn] = useTestPeople();
  const look = (v = code) => coopPeek(v.trim().toUpperCase()).then((p) => { setPeek(p); setSaid(p ? null : t('err.code')); }, (e) => setSaid(why(e)));
  const tryCode = (k: string) => {
    setCode(k);
    setPeek(null);
    look(k);
  };
  useEffect(() => { if (c) look(c); }, [c]); // eslint-disable-line react-hooks/exhaustive-deps
  // a guest joins like anyone (5.11.2026: no sign-up in the way)
  const join = async () => {
    if (!(await ensureSession())) return setSaid(t('auth.error.network'));
    coopJoin(code.trim().toUpperCase()).then((id) => { invalidate('coops'); router.replace({ pathname: '/coops/[id]', params: { id } }); }, (e) => setSaid(why(e)));
  };
  return (
    <StaffPage title={t('coops.join.title')}>
      <Input value={code} onChangeText={(v) => { setCode(v); setPeek(null); }} placeholder={t('coops.join.code')} autoCapitalize="characters" autoCorrect={false} maxLength={8} onSubmitEditing={() => look()} />
      <View style={styles.gap}><Button label={t('coops.join.look')} kind="line" onPress={() => look()} /></View>
      {peek ? (
        <View style={[styles.card, { borderColor: COOP_COLORS[peek.color] }]}>
          <Text style={styles.emoji}>{peek.emoji}</Text>
          <Text style={styles.name}>{peek.name.toLowerCase()}</Text>
          <Text style={styles.meta}>{t('coops.members', { n: peek.members })} · {t('coops.join.about')}</Text>
          {peek.mine ? <Text style={styles.meta}>{t('coops.join.mine')}</Text> : !peek.open ? <Text style={styles.meta}>{t('coops.join.closed')}</Text> : (
            <View style={styles.gap}><Button label={t('coops.join.come')} onPress={join} /></View>
          )}
        </View>
      ) : null}
      <Said text={said} bad />
      {testOn ? (
        <View style={styles.tests}>
          <View style={styles.testsHead}>
            <Text style={styles.testsWord}>{t('social.coop.tests')}</Text>
            <TestTag />
          </View>
          <View style={styles.chips}>
            {testCoopCodes().map((k) => (
              <Pressable key={k} onPress={() => tryCode(k)} accessibilityRole="button" style={({ pressed }) => [styles.chip, pressed && styles.pressed]}>
                <Text style={styles.chipText}>{k}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
    </StaffPage>
  );
}
const styles = StyleSheet.create({
  gap: { marginTop: 12 },
  card: { marginTop: 20, borderWidth: 2, borderRadius: radius.md, padding: 16, gap: 4 },
  emoji: { fontSize: 28 },
  name: { fontFamily: fonts.semibold, fontSize: 22, letterSpacing: -0.5, color: colors.paper },
  meta: { fontFamily: fonts.regular, fontSize: 13, color: colors.mute },
  tests: { marginTop: 28, gap: 10 },
  testsHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  testsWord: { fontFamily: fonts.regular, fontSize: 13, color: colors.mute },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, height: 34, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.ink3, justifyContent: 'center' },
  chipText: { fontFamily: fonts.jet, fontSize: 13, letterSpacing: 1, color: colors.paper },
  pressed: { opacity: 0.6 },
});
