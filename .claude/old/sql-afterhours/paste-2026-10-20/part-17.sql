-- paste 17/24: 86 87 88
create or replace function public.staff_person(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  out jsonb;
begin
  perform public.need_staff();
  select jsonb_build_object(
    'who', (select jsonb_build_object('id', p.id, 'handle', p.handle, 'name', p.display_name, 'role',
                     case when p.is_admin then 'admin' else p.account_type end, 'created_at', p.created_at,
                     'banned_at', p.banned_at, 'banned_reason', p.banned_reason,
                     'banned_by', (select coalesce(b.handle, b.display_name) from public.profiles b where b.id = p.banned_by),
                     'banned_by_admin', (select coalesce(b.is_admin or b.account_type = 'admin', false) from public.profiles b where b.id = p.banned_by))
            from public.profiles p where p.id = p_user),
    'reports_about', coalesce((select jsonb_agg(jsonb_build_object('kind', r.kind, 'target', r.target, 'text', r.snapshot ->> 'text',
                                 'reason', r.reason, 'handled', r.handled, 'at', r.created_at) order by r.created_at desc)
            from public.reports r where (r.snapshot ->> 'author_id') = p_user::text), '[]'::jsonb),
    'reports_made', coalesce((select jsonb_agg(jsonb_build_object('kind', r.kind, 'reason', r.reason, 'handled', r.handled, 'at', r.created_at) order by r.created_at desc)
            from public.reports r where r.reporter_id = p_user), '[]'::jsonb),
    'appeals', coalesce((select jsonb_agg(jsonb_build_object('body', a.body, 'outcome', a.outcome, 'at', a.created_at, 'settled_at', a.settled_at) order by a.created_at desc)
            from public.appeals a where a.user_id = p_user), '[]'::jsonb),
    'log', coalesce((select jsonb_agg(jsonb_build_object('action', l.action, 'note', l.note, 'at', l.at,
                                 'by', (select coalesce(x.handle, x.display_name) from public.profiles x where x.id = l.actor_id)) order by l.at desc)
            from public.staff_log l where l.target = 'person' and l.target_id = p_user::text), '[]'::jsonb)
  ) into out;
  return out;
end;
$$;

grant execute on function public.staff_person(uuid) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('86_person_file.sql', 'c4ec3d2800b5dc808a1b3a53e9fa2a380fdea01912c699317cd69b9aa1ed7649');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('86_person_file.sql');
  end if;
end $$;

create or replace function public.cron_health()
returns table (jobs int, last_ok timestamptz, last_failed timestamptz, failed_24h int)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if to_regclass('cron.job') is null or to_regclass('cron.job_run_details') is null then
    return query select 0, null::timestamptz, null::timestamptz, 0;
    return;
  end if;
  return query execute $q$
    select (select count(*)::int from cron.job where active),
           (select max(end_time) from cron.job_run_details where status = 'succeeded'),
           (select max(end_time) from cron.job_run_details where status = 'failed'),
           (select count(*)::int from cron.job_run_details where status = 'failed' and end_time > now() - interval '24 hours')
  $q$;
end;
$$;

grant execute on function public.cron_health() to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('87_cron_health.sql', '66855abff143fb2e064f228a9169eda723792c65e627a10e8998c1f8813e3715');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('87_cron_health.sql');
  end if;
end $$;

alter table public.checkins add column if not exists lat double precision;

alter table public.checkins add column if not exists lng double precision;

alter table public.checkins add column if not exists live boolean not null default true;

create or replace function public.km_between(a_lat double precision, a_lng double precision, b_lat double precision, b_lng double precision)
returns double precision
language sql
immutable
as $$
  select 2 * 6371 * asin(sqrt(
    power(sin(radians(b_lat - a_lat) / 2), 2)
    + cos(radians(a_lat)) * cos(radians(b_lat)) * power(sin(radians(b_lng - a_lng) / 2), 2)));
$$;

create or replace function public.check_in(
  p_slug text,
  p_lat  double precision default null,
  p_lng  double precision default null,
  p_at   timestamptz default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  e     public.events%rowtype;
  n     bigint;
  at    timestamptz := least(coalesce(p_at, now()), now());
  there double precision;
  x_lat double precision;
  x_lng double precision;
  live  boolean := true;
begin
  if auth.uid() is null or public.is_guest() then raise exception 'signedout'; end if;
  select * into e from public.events where slug = p_slug and is_published;
  if not found then raise exception 'nonight'; end if;

  select card_no into n from public.checkins where user_id = auth.uid() and event_id = e.id;
  if found then return n; end if;

  if at < now() - interval '12 hours' then at := now(); end if;

  if e.starts_at is not null and (at < e.starts_at - interval '6 hours' or at > e.starts_at + interval '8 hours') then
    live := false;
  end if;
  select coalesce(e.lat, v.lat), coalesce(e.lng, v.lng) into x_lat, x_lng
    from (select 1) one left join public.venues v on v.id = e.venue_id;
  if live and p_lat is not null and p_lng is not null and x_lat is not null and x_lng is not null then
    there := public.km_between(p_lat, p_lng, x_lat, x_lng);
    if there > 2 then live := false; end if;
  end if;

  insert into public.checkins (user_id, event_id, checked_at, lat, lng, live)
  values (auth.uid(), e.id, at, p_lat, p_lng, live) returning card_no into n;
  return n;
end;
$$;
