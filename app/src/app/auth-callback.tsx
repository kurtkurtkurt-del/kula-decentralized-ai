import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import * as Linking from 'expo-linking';
import { router } from 'expo-router';
import { sessionFromUrl } from '@/auth/google';
import { supabase } from '@/lib/supabase';
import { useT } from '@/i18n';
import { colors, fonts } from '@/theme/tokens';

// Google OAuth return. Usually the in-app browser captures the redirect itself
// (auth/google.ts); Android sometimes opens the app with this URL instead, in which
// case this screen sets the session and continues. Without a handle, that step comes first.
export default function AuthCallback() {
  const t = useT();
  const url = Linking.useLinkingURL();
  useEffect(() => {
    let live = true;
    (async () => {
      if (url) await sessionFromUrl(url).catch(() => false);
      const { data } = await supabase.auth.getSession();
      if (!live) return;
      // no session from the link: the app goes on as before (a guest enters by itself)
      router.replace(data.session ? '/models' : '/');
    })();
    return () => {
      live = false;
    };
  }, [url]);
  return (
    <View style={styles.root}>
      <Text style={styles.text}>{t('word.moment')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  text: { fontFamily: fonts.regular, fontSize: 14, color: colors.mute },
});
