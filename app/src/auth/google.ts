import { Platform } from 'react-native';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { supabase } from '@/lib/supabase';

// Sign in with Google through Supabase's Google provider, in an in-app browser
// window: the user approves at Google, Supabase redirects to pasaport://auth-callback,
// and the session is built from that URL.
//
// Pressed as a guest, Google is linked to the same user (the keeps stay).
// If "manual linking" is off in the Supabase dashboard linking is refused; then a
// normal sign-in happens and the guest's keeps stay with the guest.
// pasaport://auth-callback in a real build; in Expo Go the app has no scheme of its
// own, so the return address is Expo Go's exp://…/--/auth-callback (allowed in Supabase
// with the redirect pattern exp://**).
const REDIRECT = Linking.createURL('auth-callback');

WebBrowser.maybeCompleteAuthSession();

// Session from the redirect URL: #access_token=… (implicit) or ?code=… (PKCE).
export async function sessionFromUrl(url: string) {
  const [, query = ''] = url.split('?');
  const [, hash = ''] = url.split('#');
  const q = new URLSearchParams(query.split('#')[0]);
  const h = new URLSearchParams(hash);
  const failed = h.get('error_description') ?? q.get('error_description') ?? h.get('error') ?? q.get('error');
  if (failed) throw new Error(failed.replace(/\+/g, ' '));
  const code = q.get('code');
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) throw error;
    return true;
  }
  const access_token = h.get('access_token');
  const refresh_token = h.get('refresh_token');
  if (!access_token || !refresh_token) return false;
  const { error } = await supabase.auth.setSession({ access_token, refresh_token });
  if (error) throw error;
  return true;
}

// true: signed in · false: cancelled · throws with a message on error
export async function signInWithGoogle(): Promise<boolean> {
  if (Platform.OS === 'web') return signInWithGoogleWeb();
  const options = { redirectTo: REDIRECT, skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } };
  const { data: current } = await supabase.auth.getSession();
  let url: string | null = null;
  if (current.session?.user.is_anonymous) {
    const linked = await supabase.auth.linkIdentity({ provider: 'google', options });
    if (!linked.error) url = linked.data.url ?? null;
  }
  if (!url) {
    const { data, error } = await supabase.auth.signInWithOAuth({ provider: 'google', options });
    if (error) throw error;
    url = data.url;
  }
  if (!url) throw new Error('no url');
  const result = await WebBrowser.openAuthSessionAsync(url, REDIRECT);
  if (result.type !== 'success') return false;
  return sessionFromUrl(result.url);
}

// Web (the PWA): the whole page goes to Google and comes back to where it was;
// detectSessionInUrl (lib/supabase.ts) builds the session from the returning URL.
async function signInWithGoogleWeb(): Promise<boolean> {
  const options = { redirectTo: window.location.href.split(/[?#]/)[0], queryParams: { prompt: 'select_account' } };
  const { data: current } = await supabase.auth.getSession();
  if (current.session?.user.is_anonymous) {
    const linked = await supabase.auth.linkIdentity({ provider: 'google', options });
    if (!linked.error) return false;
  }
  const { error } = await supabase.auth.signInWithOAuth({ provider: 'google', options });
  if (error) throw error;
  // The page is leaving; nothing to report here.
  return false;
}
