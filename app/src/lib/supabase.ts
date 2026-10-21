import 'expo-sqlite/localStorage/install';
import { AppState, Platform } from 'react-native';
import { createClient } from '@supabase/supabase-js';
import { LargeSecureStore } from '@/lib/secureStorage';
import { backendProblem } from '@/lib/backend';

// kula's own server: the local server (backend/tools/local-server.mjs) in development,
// kula's live Supabase project in a release build (app/.env, .env.production). Schema and
// rules live in backend/sql. Never afterhours' project.
const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const key = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

/** null when this build can reach a live server; else why not (shown by NoServer). */
export const BACKEND_PROBLEM = backendProblem(url, key, __DEV__);

// A placeholder keeps the client constructible when the build has no server; every call
// then fails like an offline one, and the root layout shows why instead of the app.
export const supabase = createClient(url || 'https://missing.invalid', key || 'missing', {
  auth: {
    // On the web supabase-js keeps the session in localStorage by itself.
    storage: Platform.OS === 'web' ? undefined : new LargeSecureStore(),
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: Platform.OS === 'web',
  },
});

// Refresh the session only while the app is in the foreground.
AppState.addEventListener('change', (state) => {
  if (state === 'active') supabase.auth.startAutoRefresh();
  else supabase.auth.stopAutoRefresh();
});
