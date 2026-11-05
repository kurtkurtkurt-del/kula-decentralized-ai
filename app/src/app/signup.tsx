import { useEffect, useState } from 'react';
import { resendConfirmation } from '@/data/safety';
import { serverText } from '@/lib/serverText';
import { KeyboardAvoidingView, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { router, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import BackButton, { EdgeBack } from '@/components/BackButton';
import Button from '@/components/Button';
import Input from '@/components/Input';
import { authMessage, useAuth } from '@/auth/AuthContext';
import { signInWithGoogle } from '@/auth/google';
import { appleAvailable, signInWithApple } from '@/auth/apple';
import * as AppleAuthentication from 'expo-apple-authentication';
import GoogleMark from '@/components/GoogleMark';
import { useT } from '@/i18n';
import { colors, fonts, radius } from '@/theme/tokens';
import { brand } from '@/theme/layout';

// Sign up / sign in.
export default function SignUpScreen() {
  const insets = useSafeAreaInsets();
  const t = useT();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const { signUp, signIn, signInAsGuest, resetPassword } = useAuth();
  // the settings pass ?mode=up (make an account) or ?mode=in (sign in); nothing: the demo door.
  const params = useLocalSearchParams<{ mode?: string }>();
  const [mode, setMode] = useState<'up' | 'in'>(params.mode === 'in' ? 'in' : 'up');
  // 5.11.2026: the app is tried without a password. The account form opens only on request.
  const [withAccount, setWithAccount] = useState(params.mode === 'in' || params.mode === 'up');

  // Creates the account (or signs in if it exists) and enters the app.
  // Empty fields start an anonymous, device-bound user; adding an email later upgrades the
  // same user to an account.
  const enter = async () => {
    if (busy) return;
    const guest = !email.trim() && !password;
    setBusy(true);
    setNote(null);
    try {
      const err = guest
        ? await signInAsGuest()
        : mode === 'in'
          ? await signIn(email.trim(), password)
          : await signUp(email.trim(), password, undefined);
      if (guest) {
        // Anonymous sign-in and the demo account both failed: enter anyway, nothing is kept.
        router.replace('/models');
        return;
      }
      if (err) {
        setNote(err);
        return;
      }
      router.replace('/models');
    } catch (e) {
      setNote(authMessage(String((e as Error).message ?? e)).toLowerCase());
    } finally {
      setBusy(false);
    }
  };

  // Apple: only on an iPhone, beside Google (App Review 4.8).
  const [apple, setApple] = useState(false);
  useEffect(() => {
    appleAvailable().then(setApple);
  }, []);

  // Google and Apple: one door for both sign-up and sign-in; first visit continues to
  // the handle step.
  const google = () => provider(signInWithGoogle);
  const provider = async (signInWith: () => Promise<boolean>) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const inside = await signInWith();
      if (!inside) return; // window closed
      router.replace('/models');
    } catch (e) {
      setNote(authMessage(String((e as Error).message ?? e)).toLowerCase());
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.root}>
      <StatusBar style="dark" />
      <EdgeBack />
      <KeyboardAvoidingView behavior="padding" style={styles.body}>
        {/* Bottom padding lives here: the keyboard wrapper overrides its own paddingBottom. */}
        <View style={{ paddingBottom: insets.bottom + 24 }}>
        <View style={styles.heading}>
          <Text style={styles.line}>{withAccount ? (mode === 'up' ? t('signup.up.line1') : t('signup.in.line1')) : t('signup.demo.line1')}</Text>
          <Text style={styles.line}>{withAccount ? (mode === 'up' ? t('signup.up.line2') : t('signup.in.line2')) : t('signup.demo.line2')}</Text>
        </View>
        {!withAccount ? (
          <View style={styles.form}>
            <Text style={styles.note}>{t('signup.demo.why')}</Text>
            <Button label={busy ? t('word.moment') : t('signup.demo.go')} onPress={enter} kind="red" />
            {note && <Text style={styles.note}>{note}</Text>}
            <Pressable hitSlop={8} onPress={() => setWithAccount(true)}>
              <Text style={styles.small}>{t('signup.demo.account')}</Text>
            </Pressable>
            <BackButton inline />
          </View>
        ) : (
        <View style={styles.form}>
          <Pressable onPress={google} disabled={busy} accessibilityRole="button" accessibilityLabel={t('signup.google')} style={({ pressed }) => [styles.google, pressed && styles.pressed]}>
            <GoogleMark />
            <Text style={styles.googleText}>{t('signup.google')}</Text>
          </Pressable>
          {apple ? (
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={mode === 'up' ? AppleAuthentication.AppleAuthenticationButtonType.SIGN_UP : AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
              buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE_OUTLINE}
              cornerRadius={radius.md}
              style={styles.apple}
              onPress={() => provider(signInWithApple)}
            />
          ) : null}
          <View style={styles.or}>
            <View style={styles.orLine} />
            <Text style={styles.orText}>{t('signup.or')}</Text>
            <View style={styles.orLine} />
          </View>
          <Input
            placeholder={t('signup.email')}
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            textContentType="emailAddress"
            returnKeyType="next"
          />
          <Input
            placeholder={t('signup.password')}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            textContentType="newPassword"
            returnKeyType="go"
            onSubmitEditing={enter}
          />
          {note && <Text style={styles.note}>{note}</Text>}
          <View style={styles.gap} />
          <Button label={busy ? t('word.moment') : mode === 'up' ? t('signup.create') : t('word.signin')} onPress={enter} />
          <Pressable hitSlop={8} onPress={() => setMode((m) => (m === 'up' ? 'in' : 'up'))}>
            <Text style={styles.small}>{mode === 'up' ? t('signup.toIn') : t('signup.toUp')}</Text>
          </Pressable>
          <Pressable
            hitSlop={8}
            onPress={async () => {
              const err = await resetPassword(email);
              setNote(err ?? t('signup.sent'));
            }}
          >
            <Text style={styles.small}>{t('signup.forgot')}</Text>
          </Pressable>
          {note === t('auth.confirm') ? (
            <Pressable
              onPress={async () => {
                try { await resendConfirmation(email); setNote(t('signup.resent')); } catch (e) { setNote(serverText(e)); }
              }}
            >
              <Text style={styles.small}>{t('signup.resend')}</Text>
            </Pressable>
          ) : null}
          <Pressable hitSlop={8} onPress={() => setWithAccount(false)}>
            <Text style={styles.small}>{t('signup.demo.back')}</Text>
          </Pressable>
          <BackButton inline />
        </View>
        )}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  body: { flex: 1, paddingHorizontal: brand.left, justifyContent: 'flex-end' },
  heading: { marginBottom: 36 },
  line: { fontFamily: fonts.medium, fontSize: 34, lineHeight: 40, letterSpacing: -0.8, color: colors.paper },
  form: { gap: 16 },
  gap: { height: 8 },
  note: { fontFamily: fonts.regular, fontSize: 13, color: colors.paper2, opacity: 0.8 },
  small: { fontFamily: fonts.regular, fontSize: 12, color: colors.mute, marginTop: 6 },
  // Google: outlined button (paper border) with Google's own mark on the left.
  google: { height: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 12, borderWidth: 1.5, borderColor: colors.paper, borderRadius: radius.md },
  apple: { height: 52 },
  googleText: { fontFamily: fonts.medium, fontSize: 16, letterSpacing: -0.2, color: colors.paper },
  pressed: { opacity: 0.7 },
  or: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  orLine: { flex: 1, height: 1, backgroundColor: colors.ink3 },
  orText: { fontFamily: fonts.regular, fontSize: 12, color: colors.mute },
});
