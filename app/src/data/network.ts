import { supabase } from '@/lib/supabase';
import { must, remember } from '@/lib/offline';

// 07_passports.sql network_nodes: per city, how many phones measured in the last 30
// days, their summed rough tokens/s, the nights done there, and the projects they keep.
// Numbers only, never who. Saved on the phone; refreshed in the background.
export type NetworkNode = { city_slug: string; city_name: string; country: string; lat: number; lng: number; phones: number; tps: number; nights: number; projects: string[] };

export async function networkNodes(): Promise<NetworkNode[]> {
  return remember('network', '', async () => (((await must(supabase.rpc('network_nodes'))) ?? []) as NetworkNode[]).map((n) => ({ ...n, tps: Number(n.tps) })), 1, { ttl: 5 * 60_000 });
}
