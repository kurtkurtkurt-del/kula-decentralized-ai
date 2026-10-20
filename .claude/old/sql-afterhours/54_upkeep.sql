-- afterhours — upkeep (54, after 48 and 51 to 53)
--
--   guests        a guest account nobody has opened for 30 days is deleted, every night
--                 (guests_prune). Their comments stay, signed "someone", as on delete.
--   staff alerts  when something starts waiting in the panel (a report, a reported post,
--                 a night sent in, a dj page), every admin and community manager gets a
--                 push (kind staff, in 48) with how many things wait; at most one an hour
--                 each, so the 24-hour promise in the terms can be kept.
--   staff_waiting()  the same count, for the panel and the push.

-- ------------------------------------------------------------ guests

create or replace function public.guests_prune(p_days int default 30)
returns int
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  gone int := 0;
begin
  -- Supabase marks guests in auth.users.is_anonymous; without that column there is nothing to do.
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'auth' and table_name = 'users' and column_name = 'is_anonymous') then
    return 0;
  end if;
  create temp table if not exists _guests_gone (id uuid) on commit drop;
  truncate _guests_gone;
  execute format($q$
    insert into _guests_gone
    select u.id from auth.users u left join public.profiles p on p.id = u.id
    where u.is_anonymous
      and greatest(u.created_at, coalesce(u.last_sign_in_at, u.created_at), coalesce(p.last_seen_at, u.created_at)) < now() - interval '%s days'
  $q$, greatest(coalesce(p_days, 30), 7));
  update public.comments set author_id = null, author_name = 'someone'
   where author_id in (select id from _guests_gone);
  delete from auth.users where id in (select id from _guests_gone);
  get diagnostics gone = row_count;
  return gone;
end;
$$;
revoke all on function public.guests_prune(int) from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'afterhours-guests-prune';
    perform cron.schedule('afterhours-guests-prune', '50 4 * * *', $q$select public.guests_prune(30)$q$);
  end if;
end $$;

-- ------------------------------------------------------------ what waits for the staff

create or replace function public.staff_waiting_count()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select (select count(distinct (kind, target))::int from public.reports where not handled)
       + coalesce((select count(distinct post_id)::int from public.post_reports where not handled), 0)
       + (select count(*)::int from public.events where review = 'pending')
       + (select count(*)::int from public.djs d join public.profiles p on p.id = d.owner_id where not d.verified and p.account_type = 'dj');
$$;
revoke all on function public.staff_waiting_count() from public, anon, authenticated;

create or replace function public.staff_waiting()
returns int
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  return public.staff_waiting_count();
end;
$$;
revoke execute on function public.staff_waiting() from public, anon;
grant execute on function public.staff_waiting() to authenticated;

-- One push an hour at most per staff member, saying how many things wait.
create or replace function public.staff_ping()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
  n int;
begin
  if to_regprocedure('public.push_enqueue(uuid, text, text, jsonb)') is null then return; end if;
  n := public.staff_waiting_count();
  if n = 0 then return; end if;
  for s in select id from public.profiles where (is_admin or account_type = 'community_manager') and banned_at is null loop
    perform public.push_enqueue(s.id, 'staff', 'staff:' || s.id || ':' || to_char(date_trunc('hour', now()), 'YYYYMMDDHH24'),
                                jsonb_build_object('n', n::text, 'url', '/panel'));
  end loop;
end;
$$;
revoke all on function public.staff_ping() from public, anon, authenticated;

create or replace function public.staff_alert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.staff_ping();
  return null;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['reports', 'post_reports', 'djs'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop trigger if exists staff_alert on public.%I', t);
    execute format('create trigger staff_alert after insert on public.%I for each statement execute function public.staff_alert()', t);
  end loop;
end $$;

-- Nights sent in: only those that arrive waiting.
create or replace function public.staff_alert_night()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.review = 'pending' then
    perform public.staff_ping();
  end if;
  return null;
end;
$$;
drop trigger if exists staff_alert on public.events;
create trigger staff_alert after insert on public.events
  for each row execute function public.staff_alert_night();

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('54_upkeep.sql', '35d51a2f27242654fd57902d539828ad9875c0449af11b552f8f498c59e5ff0f');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('54_upkeep.sql');
  end if;
end $$;
