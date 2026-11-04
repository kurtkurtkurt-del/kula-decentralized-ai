import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { must, remember } from '@/lib/offline';

export type City = { id: string; name: string; country: string; phones: number };

// Cities from the network (network_nodes): the place picker in sign-up and the profile.
const fallback: City[] = [
  { id: 'istanbul', name: 'istanbul', country: 'tr', phones: 0 },
  { id: 'ankara', name: 'ankara', country: 'tr', phones: 0 },
  { id: 'izmir', name: 'izmir', country: 'tr', phones: 0 },
  { id: 'munchen', name: 'münchen', country: 'de', phones: 0 },
  { id: 'berlin', name: 'berlin', country: 'de', phones: 0 },
];
type Node = { city_slug: string; city_name: string; country: string; phones: number };
export async function loadCities(): Promise<City[]> {
  const data = await remember('cities', '', () => must(supabase.rpc('network_nodes')), 1, { ttl: 10 * 60_000 }).catch(() => null);
  if (!data) return [];
  return (data as Node[]).map((r) => ({ id: r.city_slug, name: r.city_name, country: r.country, phones: Number(r.phones) }));
}
export function useCities() {
  const [cities, setCities] = useState<City[]>(fallback);
  useEffect(() => {
    let cancelled = false;
    loadCities().then((rows) => {
      if (!cancelled && rows.length) setCities(rows);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return { cities };
}
