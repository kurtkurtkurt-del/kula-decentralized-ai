import { supabase } from '@/lib/supabase';
import { must, remember } from '@/lib/offline';

// 16_devices.sql network_estimate (the brain tab's wider network): what the network could do tonight — each person's
// newest passport (or what their finished nights really ran at), summed. The sum means
// every phone runs its own copy on its own jobs, not one model split across phones.
export type DeviceShare = { device: string; phones: number; tps_low: number; tps_high: number };
export type NetworkEstimate = { phones: number; observed: number; tps_low: number; tps_high: number; tokens_night_low: number; tokens_night_high: number; hours: number; by_device: DeviceShare[] };
export async function networkEstimate(): Promise<NetworkEstimate | null> {
  return remember('networkEstimate', '', async () => {
    const r = (((await must(supabase.rpc('network_estimate'))) ?? []) as NetworkEstimate[])[0];
    return r ? { ...r, tps_low: Number(r.tps_low), tps_high: Number(r.tps_high), tokens_night_low: Number(r.tokens_night_low), tokens_night_high: Number(r.tokens_night_high), hours: Number(r.hours) } : null;
  }, 1, { ttl: 5 * 60_000 });
}
