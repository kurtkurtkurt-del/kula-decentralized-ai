import { Platform } from 'react-native';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import Storage from 'expo-sqlite/kv-store';
import { supabase } from '@/lib/supabase';
import { invalidate, outbox, send } from '@/lib/offline';
import type { Profile } from '@/data/profile';

// The settings a person may change (settings_set, 04): one object with the keys sent.
export type Settings = Pick<Profile, 'kept_visibility' | 'discoverable' | 'locale' | 'night_from' | 'night_to' | 'wifi_only' | 'notify_friends' | 'notify_calls' | 'notify_coops' | 'notify_dms' | 'notify_cards'>;
export type SettingsPatch = Partial<Settings & { display_name: string; bio: string; city_slug: string | null }>;

outbox(
  'settings',
  async (j) => {
    const { error } = await supabase.rpc('settings_set', { p_patch: j.patch });
    if (error) throw error;
  },
  ['profile'],
);
// Switch changes are queued while offline. The night window is also kept on the phone,
// where the worker reads it without the network (night/NightWorker.ts).
export async function saveSettings(patch: SettingsPatch) {
  if (patch.night_from) Storage.setItemSync('night.from', patch.night_from);
  if (patch.night_to) Storage.setItemSync('night.to', patch.night_to);
  if (patch.wifi_only !== undefined) Storage.setItemSync('night.wifi', patch.wifi_only ? '1' : '0');
  await send({ kind: 'settings', patch });
  invalidate('profile');
}
export const nightWindow = () => ({ from: Storage.getItemSync('night.from') ?? '23:00', to: Storage.getItemSync('night.to') ?? '07:30', wifiOnly: Storage.getItemSync('night.wifi') !== '0' });

// The rest of the night's rules live only on the phone (night-2, 5.11.2026): the server's
// settings_set does not know them yet. Defaults: on charge only, battery at least 30 %.
export type NightRules = { from: string; to: string; wifiOnly: boolean; chargeOnly: boolean; minBattery: number };
export const MIN_BATTERY_CHOICES = [20, 30, 50, 80];
export function nightRules(): NightRules {
  const n = Number(Storage.getItemSync('night.minBattery'));
  return { ...nightWindow(), chargeOnly: Storage.getItemSync('night.charge') !== '0', minBattery: n > 0 && n <= 100 ? n : 30 };
}
export function saveNightRules(patch: Partial<Pick<NightRules, 'chargeOnly' | 'minBattery'>>) {
  if (patch.chargeOnly !== undefined) Storage.setItemSync('night.charge', patch.chargeOnly ? '1' : '0');
  if (patch.minBattery !== undefined) Storage.setItemSync('night.minBattery', String(patch.minBattery));
}

// ok · empty · format · taken · yours
export async function handleStatus(handle: string): Promise<string> {
  const { data, error } = await supabase.rpc('handle_status', { p_handle: handle });
  if (error) throw error;
  return String(data);
}
// Finishes registration / updates the profile. Returns 'ok' or an error code.
export async function saveProfile(p: { handle: string; name: string; city: string | null; bio: string }): Promise<string> {
  const { data, error } = await supabase.rpc('profile_setup', { p_handle: p.handle, p_display_name: p.name, p_city_slug: p.city, p_bio: p.bio });
  if (error) throw error;
  invalidate('profile');
  return String(data);
}

export async function exportMe(): Promise<string> {
  const { data, error } = await supabase.rpc('export_me');
  if (error) throw error;
  return JSON.stringify(data, null, 2);
}
// "download my data": the export as a file in your hands. On the phone it is written
// to the cache and handed to the share sheet; in the browser it downloads.
export async function exportToFile(): Promise<string> {
  const json = await exportMe();
  const name = `pasaport-${new Date().toISOString().slice(0, 10)}.json`;
  if (Platform.OS === 'web') {
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return name;
  }
  const file = new File(Paths.cache, name);
  file.write(json);
  await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: name, UTI: 'public.json' });
  return name;
}
