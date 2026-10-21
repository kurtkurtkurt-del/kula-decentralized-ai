import { supabase } from '@/lib/supabase';
import { must, remember } from '@/lib/offline';

// 07_passports.sql network_nodes: per city, how many phones measured in the last 30
// days, their summed rough tokens/s, the nights done there, and the projects they keep.
// Numbers only, never who. Saved on the phone; refreshed in the background.
export type NetworkNode = { city_slug: string; city_name: string; country: string; lat: number; lng: number; phones: number; tps: number; nights: number; projects: string[] };

export async function networkNodes(): Promise<NetworkNode[]> {
  return remember('network', '', async () => (((await must(supabase.rpc('network_nodes'))) ?? []) as NetworkNode[]).map((n) => ({ ...n, tps: Number(n.tps) })), 1, { ttl: 5 * 60_000 });
}

// 16_devices.sql network_estimate: what the network could do tonight — each person's
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

// 16_devices.sql device_catalog: one row per device model from every passport ever saved.
export type DeviceModel = { device: string; soc: string; phones: number; passports: number; native: number; ram_free_gb: number | null; mem_bw_read_gbs: number | null; best_threads: number | null; tps_low: number | null; tps_high: number | null };
export async function deviceCatalog(): Promise<DeviceModel[]> {
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return remember('deviceCatalog', '', async () =>
    (((await must(supabase.rpc('device_catalog'))) ?? []) as DeviceModel[]).map((d) => ({ ...d, ram_free_gb: num(d.ram_free_gb), mem_bw_read_gbs: num(d.mem_bw_read_gbs), tps_low: num(d.tps_low), tps_high: num(d.tps_high) })), 1, { ttl: 5 * 60_000 });
}
