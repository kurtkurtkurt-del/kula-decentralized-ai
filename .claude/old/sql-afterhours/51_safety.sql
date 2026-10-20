-- afterhours — what the stores require (51, after 42 to 50)
--
--   the terms     profiles.terms_version / terms_at / adult: accept_terms(version, adult),
--                 terms_status(). The app asks once, before anything else, and again
--                 when the terms change (a higher version).
--   reports       one table for everything but posts (45 keeps its own): comments,
--                 room messages, group messages, profiles, groups, sparks.
--                 report(kind, target, reason) for anyone with an account;
--                 staff_reports() and staff_report_settle(kind, target, remove)
--                 for the staff. Removing takes the content away (a comment is hidden,
--                 a message or spark or group deleted, a profile cleared of its words,
--                 links and photo); either way the reports are settled and logged.
--   client errors what crashed in the app: log_error() from any phone, admin_errors()
--                 and admin_errors_clear() for the admin.

-- ------------------------------------------------------------ the terms

alter table public.profiles add column if not exists terms_version int;
alter table public.profiles add column if not exists terms_at timestamptz;
alter table public.profiles add column if not exists adult boolean not null default false;

create or replace function public.accept_terms(p_version int, p_adult boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if not coalesce(p_adult, false) then raise exception 'eighteen or older only'; end if;
  if p_version is null or p_version < 1 then raise exception 'which terms?'; end if;
  update public.profiles
     set terms_version = greatest(coalesce(terms_version, 0), p_version), terms_at = now(), adult = true
   where id = auth.uid();
end;
$$;

create or replace function public.terms_status()
returns table (version int, adult boolean, at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select p.terms_version, p.adult, p.terms_at from public.profiles p where p.id = auth.uid();
$$;

revoke execute on function public.accept_terms(int, boolean) from public, anon;
revoke execute on function public.terms_status()             from public, anon;
grant execute on function public.accept_terms(int, boolean)  to authenticated;
grant execute on function public.terms_status()              to authenticated;

-- ------------------------------------------------------------ reports

create table if not exists public.reports (
  id           bigserial primary key,
  reporter_id  uuid not null references public.profiles on delete cascade,
  kind         text not null check (kind in ('comment', 'room_post', 'group_message', 'profile', 'group', 'spark', 'post_comment')),
  target       text not null check (length(target) between 1 and 64),
  reason       text check (reason is null or length(reason) <= 300),
  handled      boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (reporter_id, kind, target)
);
create index if not exists reports_open on public.reports (kind, target) where not handled;
alter table public.reports enable row level security;
revoke all on public.reports from public, anon, authenticated;

-- Comments on posts live in 55; until it ran these answer null.
create or replace function public.post_comment_body(p_id text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare r text;
begin
  if to_regclass('public.post_comments') is null then return null; end if;
  execute 'select body from public.post_comments where id::text = $1' into r using p_id;
  return r;
end;
$$;
create or replace function public.post_comment_author(p_id text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare r uuid;
begin
  if to_regclass('public.post_comments') is null then return null; end if;
  execute 'select author_id from public.post_comments where id::text = $1' into r using p_id;
  return r;
end;
$$;
revoke all on function public.post_comment_body(text) from public, anon, authenticated;
revoke all on function public.post_comment_author(text) from public, anon, authenticated;

-- Who wrote it, and whether it exists for you: null when it does not.
create or replace function public.report_author(p_kind text, p_target text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  a uuid;
begin
  if p_kind = 'comment' then
    select author_id into a from public.comments where id::text = p_target;
  elsif p_kind = 'room_post' then
    select user_id into a from public.room_posts where id::text = p_target;
  elsif p_kind = 'group_message' then
    select m.user_id into a from public.group_messages m
     where m.id::text = p_target and m.kind = 'say' and public.in_group(m.group_id);
  elsif p_kind = 'profile' then
    select id into a from public.profiles where id::text = p_target or handle = lower(p_target);
  elsif p_kind = 'group' then
    select g.created_by into a from public.groups g where g.id::text = p_target;
  elsif p_kind = 'spark' then
    select host_id into a from public.sparks where id::text = p_target;
  elsif p_kind = 'post_comment' and to_regclass('public.post_comments') is not null then
    execute 'select c.author_id from public.post_comments c join public.posts p on p.id = c.post_id
             where c.id::text = $1 and public.can_see_post(p.author_id)' into a using p_target;
  end if;
  return a;
end;
$$;
revoke all on function public.report_author(text, text) from public, anon, authenticated;

create or replace function public.report(p_kind text, p_target text, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a uuid;
  t text := btrim(coalesce(p_target, ''));
begin
  if auth.uid() is null or public.is_guest() then raise exception 'make an account first'; end if;
  a := public.report_author(p_kind, t);
  if a is null then raise exception 'nothing to report'; end if;
  if a = auth.uid() then raise exception 'that is yours'; end if;
  -- A profile is stored by its id, whichever way it was named.
  if p_kind = 'profile' then t := a::text; end if;
  if (select count(*) from public.reports where reporter_id = auth.uid() and created_at > now() - interval '1 day') >= 30 then
    raise exception 'thirty today is enough; the staff are on it';
  end if;
  insert into public.reports (reporter_id, kind, target, reason)
  values (auth.uid(), p_kind, t, left(nullif(btrim(p_reason), ''), 300))
  on conflict (reporter_id, kind, target) do update set reason = coalesce(excluded.reason, public.reports.reason), handled = false;
end;
$$;
revoke execute on function public.report(text, text, text) from public, anon;
grant execute on function public.report(text, text, text) to authenticated;

-- The open reports, one row per thing, most reported first. preview is what the
-- staff need to decide: the words, the name, the title.
drop function if exists public.staff_reports();
create or replace function public.staff_reports()
returns table (kind text, target text, preview text, author text, reports int, reasons text[], first_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  return query
    with open as (
      select r.kind, r.target, count(*)::int as n, array_remove(array_agg(r.reason order by r.created_at), null) as why, min(r.created_at) as first_at
      from public.reports r where not r.handled
      group by r.kind, r.target
    )
    select o.kind, o.target,
           case o.kind
             when 'comment'       then (select c.body from public.comments c where c.id::text = o.target)
             when 'room_post'     then (select x.body from public.room_posts x where x.id::text = o.target)
             when 'group_message' then (select x.body from public.group_messages x where x.id::text = o.target)
             when 'profile'       then (select concat_ws(' · ', p.display_name, p.bio, p.about) from public.profiles p where p.id::text = o.target)
             when 'group'         then (select g.name from public.groups g where g.id::text = o.target)
             when 'spark'         then (select concat_ws(' · ', s.title, s.place) from public.sparks s where s.id::text = o.target)
             when 'post_comment'  then public.post_comment_body(o.target)
           end,
           (select coalesce(p.handle, p.display_name) from public.profiles p where p.id = public.report_author_any(o.kind, o.target)),
           o.n, o.why, o.first_at
    from open o
    order by o.n desc, o.first_at;
end;
$$;

-- As report_author, without the "is it yours to see" test: for the staff.
create or replace function public.report_author_any(p_kind text, p_target text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select case p_kind
    when 'comment'       then (select author_id from public.comments where id::text = p_target)
    when 'room_post'     then (select user_id from public.room_posts where id::text = p_target)
    when 'group_message' then (select user_id from public.group_messages where id::text = p_target)
    when 'profile'       then (select id from public.profiles where id::text = p_target)
    when 'group'         then (select created_by from public.groups where id::text = p_target)
    when 'spark'         then (select host_id from public.sparks where id::text = p_target)
    when 'post_comment'  then public.post_comment_author(p_target)
  end;
$$;
revoke all on function public.report_author_any(text, text) from public, anon, authenticated;

create or replace function public.staff_report_settle(p_kind text, p_target text, p_remove boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  if coalesce(p_remove, false) then
    if p_kind = 'comment' then
      update public.comments set is_hidden = true where id::text = p_target;
    elsif p_kind = 'room_post' then
      delete from public.room_posts where id::text = p_target;
    elsif p_kind = 'group_message' then
      delete from public.group_messages where id::text = p_target;
    elsif p_kind = 'spark' then
      delete from public.sparks where id::text = p_target;
    elsif p_kind = 'group' then
      delete from public.groups where id::text = p_target;
    elsif p_kind = 'post_comment' then
      execute 'update public.post_comments set is_hidden = true where id::text = $1' using p_target;
    elsif p_kind = 'profile' then
      update public.profiles set bio = null, about = null where id::text = p_target;
      delete from public.profile_links where user_id::text = p_target;
      delete from public.profile_photos where user_id::text = p_target;
    else
      raise exception 'which kind?';
    end if;
  end if;
  update public.reports set handled = true where kind = p_kind and target = p_target and not handled;
  perform public.staff_note(case when coalesce(p_remove, false) then 'remove' else 'keep' end, 'report:' || p_kind, p_target, null);
end;
$$;

revoke execute on function public.staff_reports()                          from public, anon;
revoke execute on function public.staff_report_settle(text, text, boolean) from public, anon;
grant execute on function public.staff_reports()                           to authenticated;
grant execute on function public.staff_report_settle(text, text, boolean)  to authenticated;

-- ------------------------------------------------------------ client errors

create table if not exists public.client_errors (
  id          bigserial primary key,
  user_id     uuid references public.profiles on delete set null,
  message     text not null,
  stack       text,
  where_      text,
  platform    text,
  version     text,
  fatal       boolean not null default false,
  at          timestamptz not null default now()
);
create index if not exists client_errors_at on public.client_errors (at desc);
alter table public.client_errors enable row level security;
revoke all on public.client_errors from public, anon, authenticated;

-- Anyone may write one (a crash can come before sign-in); short, and at most
-- a hundred an hour across everyone, so a loop cannot fill the table.
create or replace function public.log_error(p_message text, p_stack text, p_where text, p_platform text, p_version text, p_fatal boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.client_errors where at > now() - interval '1 hour') >= 100 then return; end if;
  insert into public.client_errors (user_id, message, stack, where_, platform, version, fatal)
  values (auth.uid(), left(coalesce(nullif(btrim(p_message), ''), 'unknown'), 500), left(p_stack, 4000), left(p_where, 200),
          left(p_platform, 20), left(p_version, 40), coalesce(p_fatal, false));
end;
$$;

create or replace function public.admin_errors(p_limit int default 100)
returns table (id bigint, message text, stack text, where_ text, platform text, version text, fatal boolean, at timestamptz, who text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  return query
    select e.id, e.message, e.stack, e.where_, e.platform, e.version, e.fatal, e.at, p.handle
    from public.client_errors e left join public.profiles p on p.id = e.user_id
    order by e.at desc
    limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;

create or replace function public.admin_errors_clear()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  delete from public.client_errors;
end;
$$;

revoke execute on function public.log_error(text, text, text, text, text, boolean) from public;
grant execute on function public.log_error(text, text, text, text, text, boolean)  to anon, authenticated;
revoke execute on function public.admin_errors(int)    from public, anon;
revoke execute on function public.admin_errors_clear() from public, anon;
grant execute on function public.admin_errors(int)     to authenticated;
grant execute on function public.admin_errors_clear()  to authenticated;

-- A month of errors is enough.
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'client-errors-prune';
    perform cron.schedule('client-errors-prune', '40 4 * * *', $q$delete from public.client_errors where at < now() - interval '30 days'$q$);
  end if;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('51_safety.sql', '3b7465d17ddd94f12c1f8c5c38634997f605813c88d9784ca30e976d01104883');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('51_safety.sql');
  end if;
end $$;
