import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { must, remember, useShelf } from '@/lib/offline';
import { useAuth } from '@/auth/AuthContext';

// profile_me(): your card + counts + settings in one call (04_profiles.sql).
export type Profile = {
  id: string;
  handle: string | null;
  display_name: string | null;
  bio: string | null;
  city_slug: string | null;
  city_name: string | null;
  is_admin: boolean;
  onboarded: boolean;
  created_at: string;
  kept_count: number;
  friend_count: number;
  night_count: number;
  credits: number;
  kept_visibility: 'friends' | 'private';
  discoverable: boolean;
  locale: 'en' | 'de' | 'tr';
  night_from: string;
  night_to: string;
  wifi_only: boolean;
  notify_friends: boolean;
  notify_calls: boolean;
  notify_coops: boolean;
  notify_dms: boolean;
  notify_cards: boolean;
};

// Also used by data/warm.ts to fill the shelf before the passport page is opened.
export const loadProfile = () => remember('profile', '', async () => (((await must(supabase.rpc('profile_me'))) ?? []) as Profile[])[0] ?? null);

// tick: refetch the profile when it changes (on returning to the page).
export function useProfile(tick = 0) {
  const { session } = useAuth();
  const uid = session?.user.id;
  const [profile, setProfile] = useState<Profile | null>(null);
  const fresh = useShelf('profile');
  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    loadProfile().catch(() => null).then((row) => {
      if (!cancelled && row) setProfile(row);
    });
    return () => {
      cancelled = true;
    };
  }, [uid, tick, fresh]);
  return session ? profile : null;
}
