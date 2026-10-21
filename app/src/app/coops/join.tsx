import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import StaffPage, { Said } from '@/components/StaffPage';
import Button from '@/components/Button';
import Input from '@/components/Input';
import { useAuth } from '@/auth/AuthContext';
import { COOP_COLORS, coopJoin, coopPeek, why, type Peek } from '@/data/coops';
import { invalidate } from '@/lib/offline';
import { useLang } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';

// Join with a code (typed or from a link): look first, then come in.
export default function JoinCoopScreen() {
  const { c } = useLocalSearchParams<{ c?: string }>();
  const { t } = useLang();
  const { session, isAnonymous } = useAuth();
  const [code, setCode] = useState(c ?? '');
  const [peek, setPeek] = useState<Peek | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const look = (v = code) => coopPeek(v.trim().toUpperCase()).then((p) => { setPeek(p); setSaid(p ? null : t('err.code')); }, (e) => setSaid(why(e)));
  useEffect(() => { if (c) look(c); }, [c]); // eslint-disable-line react-hooks/exhaustive-deps
  const join = () => {
    if (!session || isAnonymous) return router.push('/signup');
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
            <View style={styles.gap}><Button label={session && !isAnonymous ? t('coops.join.come') : t('coops.join.account')} onPress={join} /></View>
          )}
        </View>
      ) : null}
      <Said text={said} bad />
    </StaffPage>
  );
}
const styles = StyleSheet.create({
  gap: { marginTop: 12 },
  card: { marginTop: 20, borderWidth: 2, borderRadius: radius.md, padding: 16, gap: 4 },
  emoji: { fontSize: 28 },
  name: { fontFamily: fonts.semibold, fontSize: 22, letterSpacing: -0.5, color: colors.paper },
  meta: { fontFamily: fonts.regular, fontSize: 13, color: colors.mute },
});
