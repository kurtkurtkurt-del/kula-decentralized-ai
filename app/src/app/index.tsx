import { useEffect } from 'react';
import { Redirect } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import Intro from '@/components/Intro';
import { useAuth } from '@/auth/AuthContext';
import { useState } from 'react';

// The intro plays once; then straight to the models (4.11.2026; before, the passport). Signed in or not: the passport
// is measured on the phone, the account only keeps it.
export default function Home() {
  const [done, setDone] = useState(false);
  const { ready, session } = useAuth();
  useEffect(() => {
    if (ready && session) setDone(true);
  }, [ready, session]);
  if (done) return <Redirect href="/models" />;
  return (
    <View style={styles.root}>
      <Intro onDone={() => setDone(true)} />
    </View>
  );
}
const styles = StyleSheet.create({ root: { flex: 1 } });
