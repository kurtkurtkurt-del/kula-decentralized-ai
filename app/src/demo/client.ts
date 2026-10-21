// A stand-in for the Supabase client in a build with no live server (lib/supabase.ts decides).
// rpc() is answered by the demo server (server.ts); auth always has the demo user signed in
// (deniz, from the example world); realtime and edge functions do nothing. The world the
// user changes is saved on the phone under demo.state and survives a restart; deleting the
// account starts it over.
import Storage from 'expo-sqlite/kv-store';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { demoRpc, freshState, ME, SNAPSHOT, type DemoState } from './server';

const KEY = 'demo.state';

function load(): DemoState {
  try {
    const raw = Storage.getItemSync(KEY);
    if (raw) {
      const s = JSON.parse(raw) as DemoState;
      if (s.generated_at === SNAPSHOT.generated_at) return s; // a new example world replaces the old one
    }
  } catch {}
  return freshState();
}
function save(s: DemoState) {
  try {
    Storage.setItemSync(KEY, JSON.stringify(s));
  } catch {}
}

const user = {
  id: ME.id, email: ME.email, aud: 'authenticated', role: 'authenticated', is_anonymous: false,
  app_metadata: { provider: 'email' }, user_metadata: {}, created_at: '2026-10-21T00:00:00Z',
};
const demoSession = (): Session => ({
  access_token: 'demo', refresh_token: 'demo', token_type: 'bearer', expires_in: 315360000,
  expires_at: Math.floor(Date.now() / 1000) + 315360000, user: user as Session['user'],
});

export function createDemoClient(): SupabaseClient {
  const state = load();
  let session: Session | null = demoSession();
  const listeners = new Set<(event: string, s: Session | null) => void>();
  const emit = (event: string) => listeners.forEach((fn) => setTimeout(() => fn(event, session), 0));
  const signedIn = async () => {
    session = demoSession();
    emit('SIGNED_IN');
    return { data: { session, user: session.user }, error: null };
  };

  const channel: any = {
    on: () => channel,
    subscribe: (cb?: (status: string) => void) => {
      cb?.('SUBSCRIBED');
      return channel;
    },
    send: async () => 'ok',
    unsubscribe: async () => 'ok',
  };

  const client = {
    rpc: (name: string, args?: Record<string, unknown>) => {
      const answer = demoRpc(state, name, args ?? {});
      save(state);
      return Promise.resolve(answer);
    },
    channel: () => channel,
    removeChannel: async () => 'ok',
    functions: { invoke: async () => ({ data: null, error: { message: 'demo: no functions' } }) },
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      getUser: async () => ({ data: { user: session?.user ?? null }, error: null }),
      onAuthStateChange: (fn: (event: string, s: Session | null) => void) => {
        listeners.add(fn);
        setTimeout(() => fn('INITIAL_SESSION', session), 0);
        return { data: { subscription: { unsubscribe: () => listeners.delete(fn) } } };
      },
      signInWithPassword: signedIn,
      signUp: signedIn,
      signInAnonymously: signedIn,
      signInWithIdToken: signedIn,
      signInWithOAuth: async () => ({ data: { provider: 'google', url: null }, error: { message: 'demo: example data, no sign-in needed' } }),
      exchangeCodeForSession: signedIn,
      setSession: signedIn,
      linkIdentity: async () => ({ data: null, error: { message: 'demo: example data' } }),
      updateUser: async () => ({ data: { user: session?.user ?? null }, error: null }),
      resend: async () => ({ data: null, error: null }),
      resetPasswordForEmail: async () => ({ data: null, error: null }),
      signOut: async () => {
        session = null;
        emit('SIGNED_OUT');
        return { error: null };
      },
      startAutoRefresh: () => {},
      stopAutoRefresh: () => {},
    },
  };
  return client as unknown as SupabaseClient;
}
