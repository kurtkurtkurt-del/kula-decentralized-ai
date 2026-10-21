import 'expo-sqlite/localStorage/install';
import { AppState, Platform } from 'react-native';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createDemoClient } from '@/demo/client';
import { LargeSecureStore } from '@/lib/secureStorage';
import { backendProblem } from '@/lib/backend';

// kula's own server: the local server (backend/tools/local-server.mjs) in development,
// kula's live Supabase project in a release build (app/.env, .env.production). Schema and
// rules live in backend/sql. Never afterhours' project.
const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

/**
 * No server set (an empty .env.production, 21.10.2026: "no Supabase for now, just random
 * examples"), or EXPO_PUBLIC_DEMO=1: the app runs on the example world in src/demo, on the
 * phone, with the demo user signed in. Everything works; nothing leaves the phone.
 */
export const DEMO = !url || process.env.EXPO_PUBLIC_DEMO === '1';

/** null when this build can reach its server; else why not (shown by NoServer). */
export const BACKEND_PROBLEM = DEMO ? null : backendProblem(url, key, __DEV__);

const live = () => createClient(url!, key || 'missing', {
  auth: {
    // On the web supabase-js keeps the session in localStorage by itself.
    storage: Platform.OS === 'web' ? undefined : new LargeSecureStore(),
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: Platform.OS === 'web',
  },
});
export const supabase: SupabaseClient = DEMO ? createDemoClient() : live();

// Refresh the session only while the app is in the foreground.
AppState.addEventListener('change', (state) => {
  if (state === 'active') supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});
