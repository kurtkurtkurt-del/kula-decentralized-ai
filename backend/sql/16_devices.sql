-- kula — every device in detail, and the network's night estimated from them (21.10.2026)
--   device_catalog()           one row per device model (device + soc) from every passport
--                              ever saved: how many phones and measurements, the medians
--                              of what they measured (bandwidth only from native
--                              measurements, never the JS fallback), the speed range.
--                              Counts and medians, never who.
--   network_estimate(hours)    what the network could do tonight: per person their newest
--                              passport of the last 30 days, or what their finished nights
--                              really ran at when there are any (observed beats estimated),
--                              summed. The sum assumes every phone runs its own copy of a
--                              model on its own jobs; one model split across phones is far
--                              slower (wifi split test, 11.10.2026) and is not counted here.
-- The passports are device-passport's passport/0.x json; 0.3 brings estimate.tps_low /
-- tps_high and budget.ram_gb, older ones only est_tps (then low = high = est_tps).

drop function if exists public.device_catalog();
create or replace function public.device_catalog()
returns table (device text, soc text, phones int, passports int, native int,
               ram_total_gb numeric, ram_free_gb numeric, ram_free_min numeric, ram_free_max numeric,
               mem_bw_gbs numeric, mem_bw_read_gbs numeric, best_threads int,
               budget_ram_gb numeric, tps_low numeric, tps_high numeric, last_measured timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  with p as (
    select p.user_id, p.measured_at, p.data,
           coalesce(p.data ->> 'approx', 'false') = 'true' as approx,
           (p.data ->> 'ram_total_gb')::numeric as ram_total,
           (p.data ->> 'ram_free_gb')::numeric as ram_free,
           (p.data ->> 'mem_bw_gbs')::numeric as bw,
           nullif((p.data ->> 'mem_bw_read_gbs')::numeric, 0) as bw_read,
           nullif((p.data ->> 'best_threads')::int, 0) as threads,
           (p.data -> 'budget' ->> 'ram_gb')::numeric as budget_ram,
           coalesce((p.data -> 'estimate' ->> 'tps_low')::numeric, (p.data ->> 'est_tps')::numeric) as low,
           coalesce((p.data -> 'estimate' ->> 'tps_high')::numeric, (p.data ->> 'est_tps')::numeric) as high
    from public.passports p
  )
  select coalesce(nullif(data ->> 'device', ''), 'unknown'), coalesce(nullif(data ->> 'soc', ''), 'unknown'),
         count(distinct user_id)::int, count(*)::int, count(*) filter (where not approx)::int,
         round((percentile_cont(0.5) within group (order by ram_total))::numeric, 1),
         round((percentile_cont(0.5) within group (order by ram_free))::numeric, 1),
         round(min(ram_free), 1), round(max(ram_free), 1),
         round((percentile_cont(0.5) within group (order by bw) filter (where not approx))::numeric, 2),
         round((percentile_cont(0.5) within group (order by bw_read) filter (where not approx))::numeric, 2),
         mode() within group (order by threads),
         round((percentile_cont(0.5) within group (order by budget_ram))::numeric, 2),
         round((percentile_cont(0.5) within group (order by low) filter (where not approx))::numeric, 1),
         round((percentile_cont(0.5) within group (order by high) filter (where not approx))::numeric, 1),
         max(measured_at)
  from p
  group by 1, 2
  order by 3 desc, 4 desc, 1;
$$;

drop function if exists public.network_estimate(numeric);
create or replace function public.network_estimate(p_hours numeric default 8.5)
returns table (phones int, observed int, tps_low numeric, tps_high numeric,
               tokens_night_low bigint, tokens_night_high bigint, hours numeric, by_device jsonb)
language sql
stable
security definer
set search_path = public
as $$
  with h as (select least(greatest(coalesce(p_hours, 8.5), 0.5), 24) as hours),
  last as (
    select distinct on (p.user_id) p.user_id, p.data from public.passports p
    where p.measured_at > now() - interval '30 days' order by p.user_id, p.measured_at desc),
  seen as ( -- what finished nights really ran at, per person, last 30 days
    select k.user_id, (percentile_cont(0.5) within group (order by k.tokens::numeric / k.seconds))::numeric as tps
    from public.contributions k
    where k.card_no is not null and k.seconds > 0 and k.ended_at > now() - interval '30 days'
    group by k.user_id),
  per as (
    select l.user_id, coalesce(nullif(l.data ->> 'device', ''), 'unknown') as device, s.tps is not null as observed,
           coalesce(s.tps, (l.data -> 'estimate' ->> 'tps_low')::numeric, (l.data ->> 'est_tps')::numeric, 0) as low,
           coalesce(s.tps, (l.data -> 'estimate' ->> 'tps_high')::numeric, (l.data ->> 'est_tps')::numeric, 0) as high
    from last l left join seen s on s.user_id = l.user_id)
  select count(*)::int, (count(*) filter (where e.observed))::int,
         round(coalesce(sum(e.low), 0), 1), round(coalesce(sum(e.high), 0), 1),
         round(coalesce(sum(e.low), 0) * 3600 * (select hours from h))::bigint,
         round(coalesce(sum(e.high), 0) * 3600 * (select hours from h))::bigint,
         (select hours from h),
         coalesce((select jsonb_agg(jsonb_build_object('device', d.device, 'phones', d.n, 'tps_low', d.low, 'tps_high', d.high) order by d.n desc, d.device)
                   from (select device, count(*) n, round(sum(low), 1) low, round(sum(high), 1) high from per group by device) d), '[]')
  from per e;
$$;

grant execute on function public.device_catalog(), public.network_estimate(numeric) to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('16_devices.sql', 'a51bcb721c6957399458fc0af33c4bb23daf54d3523e75024a85b3d2137a8796');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('16_devices.sql');
  end if;
end $$;
