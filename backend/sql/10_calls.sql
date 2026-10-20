-- pasaport — calls: a friend starts a project night, it travels in waves
-- Nobody is written down in advance: the host picks a project, a night and how far it
-- travels (1 = friends, 2 = and their friends, 3 = one step further); everyone inside the
-- wave finds it on top of their deck and answers with the same swipe (right = in, left =
-- out). An answer row appears the moment someone answers.
--   call_audience()                         how many people each wave holds
--   call_create(slug, night, reach, note)   start one; returns the id
--   call_inbox()                            open calls for you, with the wave the host is in
--   call_answer(call, in|out|waiting)       answer (waiting = undo)
--   call_mine()                             yours, with the answers so far
--   call_cancel(call)                       the host calls it off
--   call_people(call)                       the host, and whoever is in: who said in

create table if not exists public.calls (
  id          uuid primary key default gen_random_uuid(),
  host_id     uuid not null references public.profiles on delete cascade,
  project_id  uuid not null references public.projects on delete cascade,
  night       date not null,
  reach       smallint not null check (reach between 1 and 3),
  note        text check (note is null or length(note) <= 140),
  created_at  timestamptz not null default now()
);
create index if not exists calls_host_idx on public.calls (host_id, night);
create table if not exists public.call_answers (
  call_id      uuid not null references public.calls on delete cascade,
  user_id      uuid not null references public.profiles on delete cascade,
  answer       text not null default 'waiting' check (answer in ('waiting', 'in', 'out')),
  answered_at  timestamptz,
  primary key (call_id, user_id)
);
create index if not exists call_answers_user_idx on public.call_answers (user_id, answer);
alter table public.calls enable row level security;
alter table public.call_answers enable row level security;
revoke all on public.calls, public.call_answers from public, anon, authenticated;

create or replace function public.call_audience()
returns table (wave1 int, wave2 int, wave3 int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query select count(*) filter (where w.hops <= 1)::int, count(*) filter (where w.hops <= 2)::int, count(*)::int from public.waves(me) w;
end;
$$;

create or replace function public.call_create(p_slug text, p_night date, p_reach int, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  pid uuid;
  new_id uuid;
begin
  if p_night is null or p_night < public.night_of() then raise exception 'that night has passed' using errcode = '22023'; end if;
  if p_reach is null or p_reach not between 1 and 3 then raise exception 'the wave is 1, 2 or 3' using errcode = '22023'; end if;
  select id into pid from public.projects where slug = p_slug and is_published and status = 'open';
  if pid is null then raise exception 'no such project' using errcode = '22023'; end if;
  if (select count(*) from public.calls where host_id = me and night >= public.night_of()) >= 5 then raise exception 'five open calls at most' using errcode = '22023'; end if;
  insert into public.calls (host_id, project_id, night, reach, note) values (me, pid, p_night, p_reach, nullif(btrim(coalesce(p_note, '')), ''))
  returning id into new_id;
  -- the host keeps the project too: a call is a keep
  insert into public.joins (user_id, project_id, direction) values (me, pid, 'right') on conflict (user_id, project_id) do update set direction = 'right';
  return new_id;
end;
$$;

drop function if exists public.call_inbox();
create or replace function public.call_inbox()
returns table (id uuid, slug text, title text, model text, night date, note text, host_handle text, host_name text, going int, wave int, mine text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  with near as (select w.person, w.hops from public.waves(me) w)
  select c.id, r.slug, r.title, r.model, c.night, c.note, p.handle, p.display_name,
         (select count(*)::int from public.call_answers g where g.call_id = c.id and g.answer = 'in'),
         n.hops, coalesce(a.answer, 'waiting')
  from public.calls c
  join public.projects r on r.id = c.project_id
  join public.profiles p on p.id = c.host_id
  join near n on n.person = c.host_id
  left join public.call_answers a on a.call_id = c.id and a.user_id = me
  where c.night >= public.night_of() and n.hops <= c.reach and coalesce(a.answer, 'waiting') = 'waiting'
  order by c.night, c.created_at;
end;
$$;

create or replace function public.call_answer(p_call uuid, p_answer text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  pid uuid;
begin
  if p_answer not in ('in', 'out', 'waiting') then raise exception 'answer is in, out or waiting' using errcode = '22023'; end if;
  select c.project_id into pid from public.calls c join public.waves(me) w on w.person = c.host_id
  where c.id = p_call and w.hops <= c.reach and c.night >= public.night_of();
  if pid is null then raise exception 'no such call' using errcode = '42501'; end if;
  insert into public.call_answers (call_id, user_id, answer, answered_at) values (p_call, me, p_answer, case when p_answer = 'waiting' then null else now() end)
  on conflict (call_id, user_id) do update set answer = excluded.answer, answered_at = excluded.answered_at;
  -- saying in keeps the project: the night can start on it
  if p_answer = 'in' then
    insert into public.joins (user_id, project_id, direction) values (me, pid, 'right') on conflict (user_id, project_id) do update set direction = 'right';
  end if;
end;
$$;

drop function if exists public.call_mine();
create or replace function public.call_mine()
returns table (id uuid, slug text, title text, model text, night date, reach int, note text, going int, not_going int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  select c.id, r.slug, r.title, r.model, c.night, c.reach::int, c.note,
         count(*) filter (where a.answer = 'in')::int, count(*) filter (where a.answer = 'out')::int
  from public.calls c join public.projects r on r.id = c.project_id left join public.call_answers a on a.call_id = c.id
  where c.host_id = me and c.night >= public.night_of() - 1
  group by c.id, r.slug, r.title, r.model order by c.night;
end;
$$;

create or replace function public.call_cancel(p_call uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  delete from public.calls where id = p_call and host_id = me;
  if not found then raise exception 'not yours' using errcode = '42501'; end if;
end;
$$;

-- Who said in: for the host every name; for someone who is in, the names they can see.
drop function if exists public.call_people(uuid);
create or replace function public.call_people(p_call uuid)
returns table (handle text, display_name text, host boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  h uuid;
begin
  select host_id into h from public.calls where id = p_call;
  if h is null then return; end if;
  if h <> me and not exists (select 1 from public.call_answers a where a.call_id = p_call and a.user_id = me and a.answer = 'in') then return; end if;
  return query
  select p.handle, p.display_name, true from public.profiles p where p.id = h and public.reachable(me, h)
  union all
  select p.handle, p.display_name, false from public.call_answers a join public.profiles p on p.id = a.user_id
  where a.call_id = p_call and a.answer = 'in' and a.user_id <> me and public.visible_to(me, a.user_id)
  order by 3 desc, 1;
end;
$$;

revoke execute on function public.call_audience(), public.call_create(text, date, int, text), public.call_inbox(), public.call_answer(uuid, text),
  public.call_mine(), public.call_cancel(uuid), public.call_people(uuid) from public, anon;
grant execute on function public.call_audience(), public.call_create(text, date, int, text), public.call_inbox(), public.call_answer(uuid, text),
  public.call_mine(), public.call_cancel(uuid), public.call_people(uuid) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('10_calls.sql', '0bfb5001f16164e569784c99568bf8ac68e565547eaedf18ced5866fb9605c84');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('10_calls.sql');
  end if;
end $$;
