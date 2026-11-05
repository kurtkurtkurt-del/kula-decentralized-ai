import { useState } from 'react';
import { useAuth } from '@/auth/AuthContext';
import { DEMO, supabase } from '@/lib/supabase';
import { invalidate } from '@/lib/offline';
import { setTestSwitch, testSwitch } from './testPeople';

// Are the test people here? The switch in connect when someone chose; otherwise yes on the
// demo account (demo@kula.app) and in a demo build, no on a real account.
const DEMO_EMAIL = 'demo@kula.app';
export const testDefault = (isDemoAccount: boolean) => DEMO || isDemoAccount;

export async function testPeopleOn(): Promise<boolean> {
  const chosen = testSwitch();
  if (chosen !== null) return chosen;
  if (DEMO) return true;
  const { data } = await supabase.auth.getSession().catch(() => ({ data: { session: null } }));
  return data.session?.user?.email === DEMO_EMAIL;
}

export function useTestPeople(): [boolean, (on: boolean) => void] {
  const { isDemo } = useAuth();
  const [chosen, setChosen] = useState(testSwitch);
  const on = chosen ?? testDefault(isDemo);
  const set = (next: boolean) => {
    setTestSwitch(next);
    setChosen(next);
    invalidate('friends', 'suggested', 'dms', 'coops');
  };
  return [on, set];
}
