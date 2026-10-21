-- pasaport — the device passport, on the server
--   passport_save(data, client_id)   the phone's measurement (passport/0.x); a retry with the
--                                    same client_id finds the first and changes nothing.
--                                    Every one is kept (21.10.2026: every test is recorded;
--                                    16_devices.sql reads them all for the device catalog).
--   passport_mine(limit)             your measurements, newest first (at most 200 a call)
--   passport_last()                  the newest one, what the night worker reads
--   network_nodes()                  the network tab: per city, how many phones measured in
--                                    the last 30 days and the sum of their rough tokens/s;
--                                    per project, where its phones are. Numbers only.
-- The data stays what the phone sent (schema, device, soc, ram, cores, bandwidth, gflops,
-- storage, battery, largest_model_q4, est_tps, measured_at); the server checks the shape
-- and the one field it relies on, est_tps.

create or replace function public.passport_save(p_data jsonb, p_client_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  found_id uuid;
  at timestamptz;
begin
  select id into found_id from public.passports where user_id = me and client_id = p_client_id;
  if found_id is not null then return found_id; end if;
  if coalesce(p_data ->> 'schema', '') !~ '^passport/0\.' then raise exception 'unknown passport schema' using errcode = '22023'; end if;
  if (p_data ->> 'est_tps') is null or (p_data ->> 'est_tps')::numeric < 0 then raise exception 'est_tps missing' using errcode = '22023'; end if;
  at := least(coalesce((p_data ->> 'measured_at')::timestamptz, now()), now());
  insert into public.passports (user_id, client_id, data, measured_at) values (me, p_client_id, p_data, at) returning id into found_id;
  return found_id;
end;
$$;

create or replace function public.passport_mine(p_limit int default 10)
returns table (id uuid, data jsonb, measured_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query select p.id, p.data, p.measured_at from public.passports p where p.user_id = me
  order by p.measured_at desc limit least(greatest(coalesce(p_limit, 10), 1), 200);
end;
$$;

create or replace function public.passport_last()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select p.data from public.passports p where p.user_id = public.assert_member() order by p.measured_at desc limit 1;
$$;

-- The clusters: a city, how many phones, their summed rough speed, and the projects that
-- run there (those the phones of that city keep). Anyone may read it: counts, never who.
drop function if exists public.network_nodes();
create or replace function public.network_nodes()
returns table (city_slug text, city_name text, country text, lat double precision, lng double precision,
               phones int, tps numeric, nights int, projects text[])
language sql
stable
security definer
set search_path = public
as $$
  with last as (
    select distinct on (p.user_id) p.user_id, p.data from public.passports p
    where p.measured_at > now() - interval '30 days' order by p.user_id, p.measured_at desc)
  select c.slug, c.name, c.country, c.lat, c.lng,
         (select count(*)::int from last l join public.profiles pr on pr.id = l.user_id where pr.city_id = c.id),
         coalesce((select round(sum((l.data ->> 'est_tps')::numeric), 1) from last l join public.profiles pr on pr.id = l.user_id where pr.city_id = c.id), 0),
         (select count(*)::int from public.contributions k join public.profiles pr on pr.id = k.user_id
           where pr.city_id = c.id and k.card_no is not null and k.ended_at > now() - interval '30 days'),
         coalesce((select array_agg(distinct r.slug) from public.joins j join public.profiles pr on pr.id = j.user_id
                   join public.projects r on r.id = j.project_id
                   where pr.city_id = c.id and j.direction = 'right' and r.is_published), '{}')
  from public.cities c order by c.sort_order;
$$;
grant execute on function public.network_nodes() to anon, authenticated;

revoke execute on function public.passport_save(jsonb, uuid), public.passport_mine(int), public.passport_last() from public, anon;
grant execute on function public.passport_save(jsonb, uuid), public.passport_mine(int), public.passport_last() to authenticated;

-- the export carries the passports too
create or replace function public.export_me()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) - 'is_admin' from public.profiles p where p.id = me),
    'settings', (select to_jsonb(s) from public.profile_settings s where s.user_id = me),
    'joins', (select coalesce(jsonb_agg(jsonb_build_object('project', r.slug, 'direction', j.direction, 'at', j.created_at)), '[]')
              from public.joins j join public.projects r on r.id = j.project_id where j.user_id = me),
    'friends', (select coalesce(jsonb_agg(jsonb_build_object('handle', p.handle, 'status', f.status)), '[]')
                from public.friendships f join public.profiles p on p.id = case when f.requester_id = me then f.addressee_id else f.requester_id end
                where me in (f.requester_id, f.addressee_id)),
    'passports', (select coalesce(jsonb_agg(p.data order by p.measured_at desc), '[]') from public.passports p where p.user_id = me));
end;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('07_passports.sql', 'ee32d493d83dd98215578882eee5b83f8b07d029c9d442192496991b20e454a0');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('07_passports.sql');
  end if;
end $$;
