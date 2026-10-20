-- pasaport — what the stores require
--   the terms       accept_terms(version) · terms_status(): asked once, before anything
--                   else, and again when the version rises
--   reports         report(kind, target, reason) for profiles, dm lines, coops, calls;
--                   staff_reports() · staff_report_settle(kind, target, remove) for the
--                   admin. Removing takes the content away (a line deleted, a call or coop
--                   deleted, a profile cleared of its words); either way the report is settled.
--   client errors   log_error() from any phone; admin_errors() · admin_errors_clear()
--   the floor       min_app_version() · set_min_app_version(v): the oldest app that still works
--   feedback        feedback_send(subject, body, contact) from anyone; feedback_list() for the admin
--   retention       retention_prune(): abandoned nights older than a day, errors older than
--                   30 days, passports older than 90 days (the last one stays)

create or replace function public.accept_terms(p_version int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  if p_version is null or p_version < 1 then raise exception 'which terms?'; end if;
  update public.profiles set terms_version = greatest(coalesce(terms_version, 0), p_version), terms_at = now() where id = me;
end;
$$;
create or replace function public.terms_status()
returns table (version int, at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select p.terms_version, p.terms_at from public.profiles p where p.id = auth.uid();
$$;

create table if not exists public.reports (
  id          bigserial primary key,
  kind        text not null check (kind in ('profile', 'dm', 'coop', 'call')),
  target      text not null,
  reporter_id uuid references public.profiles on delete set null,
  reason      text check (reason is null or length(reason) <= 400),
  snapshot    text,
  created_at  timestamptz not null default now(),
  settled_at  timestamptz,
  removed     boolean
);
create index if not exists reports_open_idx on public.reports (kind, target) where settled_at is null;
alter table public.reports enable row level security;
revoke all on public.reports from public, anon, authenticated;

create or replace function public.report(p_kind text, p_target text, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  snap text;
begin
  if p_kind not in ('profile', 'dm', 'coop', 'call') then raise exception 'what kind of thing?'; end if;
  if (select count(*) from public.reports r where r.reporter_id = me and r.created_at > now() - interval '1 day') >= 20 then raise exception 'slow down'; end if;
  snap := case p_kind
    when 'profile' then (select concat_ws(' · ', p.handle, p.display_name, p.bio) from public.profiles p where p.id::text = p_target or p.handle = p_target)
    when 'dm' then (select m.body from public.dm_messages m where m.id::text = p_target)
    when 'coop' then (select c.name from public.coops c where c.id::text = p_target)
    when 'call' then (select r.title || ' · ' || coalesce(c.note, '') from public.calls c join public.projects r on r.id = c.project_id where c.id::text = p_target) end;
  insert into public.reports (kind, target, reporter_id, reason, snapshot) values (p_kind, p_target, me, nullif(btrim(coalesce(p_reason, '')), ''), left(snap, 400));
end;
$$;
drop function if exists public.staff_reports();
create or replace function public.staff_reports()
returns table (kind text, target text, snapshot text, reports int, reasons text[], first_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_admin();
  return query
  select r.kind, r.target, max(r.snapshot), count(*)::int, array_remove(array_agg(distinct r.reason), null), min(r.created_at)
  from public.reports r where r.settled_at is null group by r.kind, r.target order by min(r.created_at);
end;
$$;
create or replace function public.staff_report_settle(p_kind text, p_target text, p_remove boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_admin();
  if p_remove then
    case p_kind
      when 'profile' then update public.profiles set bio = null, display_name = handle where id::text = p_target or handle = p_target;
      when 'dm' then delete from public.dm_messages where id::text = p_target;
      when 'coop' then delete from public.coops where id::text = p_target;
      when 'call' then delete from public.calls where id::text = p_target;
      else null;
    end case;
  end if;
  update public.reports set settled_at = now(), removed = p_remove where kind = p_kind and target = p_target and settled_at is null;
end;
$$;

create table if not exists public.client_errors (
  id         bigserial primary key,
  user_id    uuid references public.profiles on delete set null,
  message    text not null,
  stack      text,
  where_     text,
  platform   text,
  version    text,
  fatal      boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.client_errors enable row level security;
revoke all on public.client_errors from public, anon, authenticated;
create or replace function public.log_error(p_message text, p_stack text, p_where text, p_platform text, p_version text, p_fatal boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.client_errors e where e.created_at > now() - interval '1 minute') >= 60 then return; end if;
  insert into public.client_errors (user_id, message, stack, where_, platform, version, fatal)
  values (auth.uid(), left(coalesce(p_message, '?'), 500), left(p_stack, 4000), left(p_where, 120), left(p_platform, 20), left(p_version, 20), coalesce(p_fatal, false));
end;
$$;
drop function if exists public.admin_errors(int);
create or replace function public.admin_errors(p_limit int default 100)
returns table (id bigint, message text, stack text, where_ text, platform text, version text, fatal boolean, at timestamptz, who text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_admin();
  return query select e.id, e.message, e.stack, e.where_, e.platform, e.version, e.fatal, e.created_at, p.handle
  from public.client_errors e left join public.profiles p on p.id = e.user_id order by e.id desc limit least(coalesce(p_limit, 100), 500);
end;
$$;
create or replace function public.admin_errors_clear()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_admin();
  delete from public.client_errors;
end;
$$;

create table if not exists public.app_floor (
  id         boolean primary key default true check (id),
  version    text not null,
  note       text,
  set_at     timestamptz not null default now()
);
alter table public.app_floor enable row level security;
revoke all on public.app_floor from public, anon, authenticated;
insert into public.app_floor (version) values ('0.1.0') on conflict (id) do nothing;
create or replace function public.version_lt(a text, b text)
returns boolean
language sql
immutable
as $$
  select string_to_array(a, '.')::int[] < string_to_array(b, '.')::int[];
$$;
create or replace function public.min_app_version()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select version from public.app_floor where id;
$$;
create or replace function public.set_min_app_version(p_version text, p_note text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_admin();
  if p_version !~ '^\d+\.\d+\.\d+$' then raise exception 'a version looks like 0.2.0'; end if;
  update public.app_floor set version = p_version, note = p_note, set_at = now() where id;
  return p_version;
end;
$$;

create table if not exists public.feedback (
  id         bigserial primary key,
  user_id    uuid references public.profiles on delete set null,
  subject    text not null check (length(subject) between 1 and 120),
  body       text not null check (length(body) between 1 and 4000),
  contact    text check (contact is null or length(contact) <= 200),
  created_at timestamptz not null default now()
);
alter table public.feedback enable row level security;
revoke all on public.feedback from public, anon, authenticated;
create or replace function public.feedback_send(p_subject text, p_body text, p_contact text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.feedback f where f.created_at > now() - interval '1 hour') >= 100 then return; end if;
  insert into public.feedback (user_id, subject, body, contact) values (auth.uid(), btrim(p_subject), btrim(p_body), nullif(btrim(coalesce(p_contact, '')), ''));
end;
$$;
drop function if exists public.feedback_list(int);
create or replace function public.feedback_list(p_limit int default 100)
returns table (id bigint, subject text, body text, contact text, who text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_admin();
  return query select f.id, f.subject, f.body, f.contact, p.handle, f.created_at from public.feedback f left join public.profiles p on p.id = f.user_id
  order by f.id desc limit least(coalesce(p_limit, 100), 500);
end;
$$;

create or replace function public.retention_prune()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
  m int;
begin
  delete from public.contributions where card_no is null and ended_at is not null and started_at < now() - interval '1 day'; get diagnostics m = row_count; n := n + m;
  delete from public.client_errors where created_at < now() - interval '30 days'; get diagnostics m = row_count; n := n + m;
  delete from public.passports p where p.measured_at < now() - interval '90 days'
    and p.id <> (select q.id from public.passports q where q.user_id = p.user_id order by q.measured_at desc limit 1); get diagnostics m = row_count; n := n + m;
  delete from public.push_outbox where sent_at < now() - interval '7 days'; get diagnostics m = row_count; n := n + m;
  return n;
end;
$$;
revoke execute on function public.retention_prune() from public, anon, authenticated;

-- staff: people by handle, for the panel
drop function if exists public.admin_people(text);
create or replace function public.admin_people(p_query text)
returns table (id uuid, handle text, display_name text, created_at timestamptz, nights int, banned boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  q text := lower(btrim(coalesce(p_query, '')));
begin
  perform public.need_admin();
  return query select p.id, p.handle, p.display_name, p.created_at,
    (select count(*)::int from public.contributions k where k.user_id = p.id and k.card_no is not null), public.is_banned(p.id)
  from public.profiles p where q = '' or p.handle like q || '%' or lower(coalesce(p.display_name, '')) like '%' || q || '%'
  order by p.created_at desc limit 100;
end;
$$;

revoke execute on function public.accept_terms(int), public.terms_status(), public.report(text, text, text), public.staff_reports(), public.staff_report_settle(text, text, boolean),
  public.admin_errors(int), public.admin_errors_clear(), public.set_min_app_version(text, text), public.feedback_list(int), public.admin_people(text) from public, anon;
grant execute on function public.accept_terms(int), public.terms_status(), public.report(text, text, text), public.staff_reports(), public.staff_report_settle(text, text, boolean),
  public.admin_errors(int), public.admin_errors_clear(), public.set_min_app_version(text, text), public.feedback_list(int), public.admin_people(text) to authenticated;
grant execute on function public.log_error(text, text, text, text, text, boolean), public.min_app_version(), public.feedback_send(text, text, text) to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('14_safety.sql', '37de2d1e61fb5b30666accd67e058b2ce248db563229f6add9884b142ed4f22d');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('14_safety.sql');
  end if;
end $$;
