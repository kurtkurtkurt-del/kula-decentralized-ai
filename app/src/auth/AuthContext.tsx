import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import * as Linking from 'expo-linking';
import { supabase } from '@/lib/supabase';
import { forgetCache, isNetworkError } from '@/lib/offline';
import { LargeSecureStore } from '@/lib/secureStorage';
import { unregisterPush } from '@/lib/push';
import { mergeGuest, rememberGuest } from '@/data/safety';
import { serverText } from '@/lib/serverText';
import { t } from '@/i18n/core';
import type { Key } from '@/i18n/dict';

// The links in kula's emails (confirm the sign-up, reset the password) come back into the
// app, to auth-callback, which takes the session from the link (as Google sign-in does).
// Until 21.10.2026 they opened afterhours' website. In kula's Supabase project the address
// must be listed under Authentication → URL Configuration → Redirect URLs
// (pasaport://auth-callback; exp://** for Expo Go).
const RESET_URL = Linking.createURL('auth-callback');
const CONFIRM_URL = Linking.createURL('auth-callback');

type Auth = {
  session: Session | null;
  ready: boolean;
  isAnonymous: boolean;
  // Creates an account; signs in if it exists; upgrades an anonymous session in place.
  // Returns an error message, or null on success.
  signUp: (email: string, password: string, city?: string) => Promise<string | null>;
  signIn: (email: string, password: string) => Promise<string | null>;
  // Browsing without an account: a device-bound anonymous user whose swipes are upgraded later.
  signInAsGuest: () => Promise<string | null>;
  resetPassword: (email: string) => Promise<string | null>;
  signOut: (everywhere?: boolean) => Promise<void>;
};

const Ctx = createContext<Auth>({
  session: null,
  ready: false,
  isAnonymous: false,
  signUp: async () => t('auth.notready'),
  signIn: async () => t('auth.notready'),
  signInAsGuest: async () => t('auth.notready'),
  resetPassword: async () => t('auth.notready'),
  signOut: async () => {},
});

// Form validation before calling Supabase, with the same strings.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function checkEmail(email: string) {
  return EMAIL.test(email.trim()) ? null : t('auth.email');
}
function checkPassword(password: string) {
  if (password.length < 8) return t('auth.password.short');
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return t('auth.password.mix');
  return null;
}

// Identity, same as the website: email + password. On sign-up a database trigger
// (handle_new_user) creates the profile, for anonymous users too.
// A stored session without a user (a local server that answered a refresh without one,
// or a user the server no longer has) cannot be used: treat it as signed out and drop it
// from this phone, instead of crashing on session.user.
let dropping = false;
function usable(s: Session | null): Session | null {
  if (!s || s.user?.id) return s;
  if (!dropping) {
    dropping = true;
    supabase.auth.signOut({ scope: 'local' }).catch(() => {}).finally(() => (dropping = false));
  }
  return null;
}

const DEMO_EMAIL = 'demo@kula.app';
const DEMO_PASSWORD = 'kula-demo-2026';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data, error }) => {
      let s = data.session;
      // Expired token and no network: Supabase cannot refresh and returns an empty
      // session, which looked like a sign-out. The session is still in storage,
      // so use it; Supabase refreshes once the connection is back.
      if (!s && error && isNetworkError(error)) s = await storedSession();
      setSession(usable(s));
      setReady(true);
    });
    // Accept an empty session only on a real sign-out; an offline refresh
    // failure also reports "no session".
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      if (s || event === 'SIGNED_OUT') setSession(usable(s));
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const isAnonymous = !!session?.user?.is_anonymous;

  const signIn = useCallback(async (email: string, password: string) => {
    const bad = checkEmail(email);
    if (bad) return bad;
    const { data, error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (error) return plain(error.message);
    // Swipes made as a guest before this sign-in come along (80_guest_merge.sql).
    if (data.user) mergeGuest(data.user.id).catch(() => {});
    return null;
  }, []);

  const signUp = useCallback(
    async (email: string, password: string, city?: string) => {
      const bad = checkEmail(email) ?? checkPassword(password);
      if (bad) return bad;
      const { data: cur } = await supabase.auth.getSession();
      if (cur.session?.user.is_anonymous) {
        // The anonymous session becomes an account: swipes and profile stay on the same user.
        // With email confirmation on, the user stays anonymous until they click the link.
        const { data, error } = await supabase.auth.updateUser({ email: email.trim(), password }, { emailRedirectTo: CONFIRM_URL });
        if (error) {
          if (/already|registered|exists/i.test(error.message)) {
            // Sign-in will replace this session; the guest id survives on the phone (80_guest_merge.sql).
            rememberGuest(cur.session.user.id);
            return t('auth.exists');
          }
          return plain(error.message);
        }
        if (data.user?.is_anonymous || data.user?.new_email) return t('auth.confirm');
        return null;
      }
      const { data, error } = await supabase.auth.signUp({ email: email.trim(), password, options: { data: city ? { city } : {}, emailRedirectTo: CONFIRM_URL } });
      if (error) {
        if (/already|registered|exists/i.test(error.message)) return signIn(email, password);
        return plain(error.message);
      }
      // With confirmation on, an existing email returns a fake user without identities: the account exists, so sign in.
      if (data.user && (data.user.identities?.length ?? 0) === 0) return signIn(email, password);
      if (!data.session) return t('auth.confirm');
      return null;
    },
    [signIn],
  );

  const signInAsGuest = useCallback(async () => {
    const { data: cur } = await supabase.auth.getSession();
    if (cur.session) return null; // already signed in
    const { error } = await supabase.auth.signInAnonymously();
    if (!error) return null;
    // Anonymous sign-ins off on the server (5.11.2026): one shared demo account instead, so
    // the app can be tried without a password. Made on first use; nothing personal in it.
    const demo = { email: DEMO_EMAIL, password: DEMO_PASSWORD };
    const tryIn = await supabase.auth.signInWithPassword(demo);
    if (!tryIn.error) return null;
    const made = await supabase.auth.signUp(demo);
    if (made.error) return plain(made.error.message);
    if (!made.data.session) return t('auth.confirm');
    return null;
  }, []);

  const resetPassword = useCallback(async (email: string) => {
    const bad = checkEmail(email);
    if (bad) return bad;
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: RESET_URL });
    return error ? plain(error.message) : null;
  }, []);

  // everywhere: every phone and browser signed in to the account loses its session (F19).
  const signOut = useCallback(async (everywhere = false) => {
    const { data } = await supabase.auth.getSession();
    // Stop this phone receiving the account's notifications while the session still works.
    await unregisterPush();
    await supabase.auth.signOut(everywhere ? { scope: 'global' } : undefined);
    // Drop this account's cached copies from the phone (someone else may use it).
    if (data.session) forgetCache(data.session.user.id);
  }, []);

  return <Ctx.Provider value={{ session, ready, isAnonymous, signUp, signIn, signInAsGuest, resetPassword, signOut }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);

async function storedSession(): Promise<Session | null> {
  try {
    const key = (supabase.auth as unknown as { storageKey: string }).storageKey;
    const raw = await new LargeSecureStore().getItem(key);
    const s = raw ? (JSON.parse(raw) as Session) : null;
    return s?.user?.id ? s : null;
  } catch {
    return null;
  }
}

// Known English Supabase messages → string keys. Order matters: first match wins.
const known: [RegExp, Key][] = [
  [/invalid login credentials/i, 'auth.error.credentials'],
  [/email not confirmed/i, 'auth.error.unconfirmed'],
  [/already (been )?registered|already exists/i, 'auth.error.registered'],
  [/rate limit|too many requests|for security purposes/i, 'auth.error.rate'],
  [/should be different from the old password/i, 'auth.error.same'],
  [/password should be|weak password|password is known to be weak/i, 'auth.error.weak'],
  [/anonymous sign-?ins are disabled/i, 'auth.error.noguest'],
  [/signups? (are )?not allowed|signups? (are )?disabled/i, 'auth.error.closed'],
  [/unable to validate email|email address .* is invalid|invalid email/i, 'auth.error.invalid'],
  [/network request failed|failed to fetch/i, 'auth.error.network'],
];

// Known messages are translated; unknown ones keep the server's wording,
// lower-cased to match the interface.
export function authMessage(m: string) {
  const hit = known.find(([re]) => re.test(m));
  return hit ? t(hit[1]) : serverText(m);
}
const plain = authMessage;
