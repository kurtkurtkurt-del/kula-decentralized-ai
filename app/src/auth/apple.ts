import { Platform } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';
import * as Crypto from 'expo-crypto';
import { supabase } from '@/lib/supabase';

// Sign in with Apple (iOS only). App Review rule 4.8: an app that offers Google
// sign-in must offer Apple too. Apple's own sheet hands back an identity token; Supabase's
// Apple provider turns it into a session. A nonce ties the token to this request: Apple
// gets its SHA-256, Supabase the raw value.
//
// Apple gives the name only on the very first sign-in, so it is stored then.
// Pressed as a guest it signs in normally (Supabase cannot link an id token to an
// anonymous user); the guest's keeps stay with the guest, as with Google when
// manual linking is off.

export async function appleAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  return AppleAuthentication.isAvailableAsync().catch(() => false);
}

// true: signed in · false: cancelled · throws with a message on error
export async function signInWithApple(): Promise<boolean> {
  const nonce = Crypto.randomUUID();
  const hashed = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, nonce);
  let credential: AppleAuthentication.AppleAuthenticationCredential;
  try {
    credential = await AppleAuthentication.signInAsync({
      requestedScopes: [AppleAuthentication.AppleAuthenticationScope.FULL_NAME, AppleAuthentication.AppleAuthenticationScope.EMAIL],
      nonce: hashed,
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_REQUEST_CANCELED') return false;
    throw e;
  }
  if (!credential.identityToken) throw new Error('apple sent no token');
  const { error } = await supabase.auth.signInWithIdToken({ provider: 'apple', token: credential.identityToken, nonce });
  if (error) throw error;
  const full = [credential.fullName?.givenName, credential.fullName?.familyName].filter(Boolean).join(' ');
  if (full) await supabase.auth.updateUser({ data: { full_name: full } }).catch(() => {});
  return true;
}
