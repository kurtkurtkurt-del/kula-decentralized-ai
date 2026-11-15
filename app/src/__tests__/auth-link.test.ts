// security review 4.4: pasaport://auth-callback with tokens in it is taken only right after this
// phone started a sign-in; any app or web page could otherwise swap the signed-in account
/* eslint-disable import/first -- jest.mock calls are hoisted above the imports anyway */
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockSetSession = jest.fn(async (_s: unknown) => ({ error: null }));
jest.mock('@/lib/supabase', () => ({ supabase: { auth: { setSession: (s: unknown) => mockSetSession(s), exchangeCodeForSession: async () => ({ error: null }) } } }));
jest.mock('expo-linking', () => ({ createURL: () => 'pasaport://auth-callback' }));
jest.mock('expo-web-browser', () => ({ maybeCompleteAuthSession: () => {}, openAuthSessionAsync: async () => ({ type: 'cancel' }) }));

import { markSignInPending, sessionFromUrl, SIGN_IN_WINDOW_MS } from '@/auth/google';

const link = 'pasaport://auth-callback#access_token=AT&refresh_token=RT';

describe('auth-callback tokens', () => {
  beforeEach(() => { mockSetSession.mockClear(); });

  it('are refused when no sign-in was started here', async () => {
    expect(await sessionFromUrl(link)).toBe(false);
    expect(mockSetSession).not.toHaveBeenCalled();
  });

  it('are taken once right after a sign-in started, then refused again', async () => {
    markSignInPending();
    expect(await sessionFromUrl(link)).toBe(true);
    expect(mockSetSession).toHaveBeenCalledTimes(1);
    expect(await sessionFromUrl(link)).toBe(false);
    expect(mockSetSession).toHaveBeenCalledTimes(1);
  });

  it('are refused after the window', async () => {
    markSignInPending(Date.now() - SIGN_IN_WINDOW_MS - 1000);
    expect(await sessionFromUrl(link)).toBe(false);
  });
});
