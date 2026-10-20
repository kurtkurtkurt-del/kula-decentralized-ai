-- paste 20/24: 89 90 91 92
do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('89_export_all.sql', '7b31143e846e9a6f8410a1175e128cdacca2128dd437e2119333721d6c5127fb');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('89_export_all.sql');
  end if;
end $$;

alter table public.dm_threads add column if not exists seen_a bigint not null default 0;

alter table public.dm_threads add column if not exists seen_b bigint not null default 0;

create or replace function public.dm_seen(p_thread uuid, p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'sign in first'; end if;
  update public.dm_threads
     set seen_a = case when a = me then greatest(seen_a, p_id) else seen_a end,
         seen_b = case when b = me then greatest(seen_b, p_id) else seen_b end
   where id = p_thread and me in (a, b);
end;
$$;

grant execute on function public.dm_seen(uuid, bigint) to authenticated;

drop function if exists public.dm_list();

create or replace function public.dm_list()
returns table (id uuid, other_id uuid, handle text, name text, last_body text, last_mine boolean, last_id bigint, last_at timestamptz, unread int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  select t.id, o.id, o.handle, coalesce(o.display_name, o.handle),
         l.body, l.user_id = me, l.id, t.last_at,
         (select count(*)::int from public.dm_messages u
           where u.thread_id = t.id and u.user_id <> me
             and u.id > case when t.a = me then t.seen_a else t.seen_b end)
  from public.dm_threads t
  join public.profiles o on o.id = case when t.a = me then t.b else t.a end
  left join lateral (select m.id, m.body, m.user_id from public.dm_messages m where m.thread_id = t.id order by m.id desc limit 1) l on true
  where me in (t.a, t.b)
    and public.reachable(me, o.id)
  order by t.last_at desc;
end;
$$;

grant execute on function public.dm_list() to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('90_dm_seen.sql', 'ffd942a2cb07ce815b8c3df126b045187574293773a33b312af376f731811fe5');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('90_dm_seen.sql');
  end if;
end $$;

alter table public.migrations add column if not exists hash text;

create or replace function public.migration_done(p_name text, p_hash text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.migrations (name, hash) values (p_name, p_hash)
  on conflict (name) do update set applied_at = now(), hash = excluded.hash;
$$;

drop function if exists public.migrations_applied();

create or replace function public.migrations_applied()
returns table (name text, applied_at timestamptz, hash text)
language sql
stable
security definer
set search_path = public
as $$
  select m.name, m.applied_at, m.hash from public.migrations m order by m.name;
$$;

grant execute on function public.migrations_applied() to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('91_checksums.sql', '3e2d52d795b47a138cfdb605bf8c6d50fc8ebe393292a64f26aafb56e41061f0');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('91_checksums.sql');
  end if;
end $$;

alter table public.cities add column if not exists tz text not null default 'Europe/Berlin';

update public.cities set tz = case country_slug
    when 'de' then 'Europe/Berlin'
    when 'at' then 'Europe/Vienna'
    when 'ch' then 'Europe/Zurich'
    when 'nl' then 'Europe/Amsterdam'
    when 'be' then 'Europe/Brussels'
    when 'fr' then 'Europe/Paris'
    when 'es' then 'Europe/Madrid'
    when 'it' then 'Europe/Rome'
    when 'pl' then 'Europe/Warsaw'
    when 'cz' then 'Europe/Prague'
    when 'hu' then 'Europe/Budapest'
    when 'dk' then 'Europe/Copenhagen'
    when 'se' then 'Europe/Stockholm'
    when 'no' then 'Europe/Oslo'
    when 'fi' then 'Europe/Helsinki'
    when 'gr' then 'Europe/Athens'
    when 'tr' then 'Europe/Istanbul'
    when 'gb' then 'Europe/London'
    when 'ie' then 'Europe/Dublin'
    when 'pt' then 'Europe/Lisbon'
    when 'ae' then 'Asia/Dubai'
    when 'hk' then 'Asia/Hong_Kong'
    when 'sg' then 'Asia/Singapore'
    when 'jp' then 'Asia/Tokyo'
    when 'kr' then 'Asia/Seoul'
    when 'tw' then 'Asia/Taipei'
    when 'id' then 'Asia/Jakarta'
    when 'au' then 'Australia/Sydney'
    when 'nz' then 'Pacific/Auckland'
    when 'fj' then 'Pacific/Fiji'
    when 'ke' then 'Africa/Nairobi'
    when 'ma' then 'Africa/Casablanca'
    when 'ng' then 'Africa/Lagos'
    else 'Europe/Berlin' end;

alter table public.events add column if not exists tz text;

do $$ begin
  if not exists (select 1 from public.migrations where name = '92_timezones.sql') then
    update public.events e
       set starts_at = ((e.starts_at at time zone 'UTC') at time zone c.tz)
      from public.cities c
     where c.id = e.city_id and e.source = 'ticketmaster' and e.starts_at is not null and e.tz is null
       and substring(e.date_text from '([0-9]{2}:[0-9]{2})') is not null
       and to_char(e.starts_at at time zone 'UTC', 'HH24:MI') = substring(e.date_text from '([0-9]{2}:[0-9]{2})')
       and to_char(e.starts_at at time zone c.tz, 'HH24:MI') <> substring(e.date_text from '([0-9]{2}:[0-9]{2})');
    update public.events e set tz = c.tz
      from public.cities c
     where c.id = e.city_id and e.source = 'ticketmaster' and e.tz is null;
  end if;
end $$;
