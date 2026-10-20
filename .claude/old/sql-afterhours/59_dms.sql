-- afterhours — direct messages (59)
--
--   dm_threads            one row per pair of friends who wrote each other (a < b)
--   dm_messages           the lines, 1000 characters at most, 20 a minute a person
--   dm_start(handle)      opens (or finds) the thread with a confirmed friend you can reach
--   dm_send(thread, body) a line; dm_unsay(id) takes your own back
--   dm_thread(thread, after)  the lines after a given id (0: the last 80), oldest first
--   dm_list()             your threads, newest first: the other person, the last line
--   push dm               the name of the sender and a fixed sentence (58), switch notify_dms
-- Friends only, and only while neither has blocked the other and neither is banned
-- (reachable, 57). The tables are closed; these calls are the only way in. Who has
-- seen what is the business of the phone (data/messages.ts), as for rooms and groups.

create table if not exists public.dm_threads (
  id          uuid primary key default gen_random_uuid(),
  a           uuid not null references public.profiles(id) on delete cascade,
  b           uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  last_at     timestamptz not null default now(),
  check (a < b),
  unique (a, b)
);
create table if not exists public.dm_messages (
  id          bigserial primary key,
  thread_id   uuid not null references public.dm_threads(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  body        text not null check (length(body) between 1 and 1000),
  created_at  timestamptz not null default now()
);
create index if not exists dm_messages_thread on public.dm_messages (thread_id, id);
create index if not exists dm_threads_a on public.dm_threads (a, last_at desc);
create index if not exists dm_threads_b on public.dm_threads (b, last_at desc);
alter table public.dm_threads enable row level security;
alter table public.dm_messages enable row level security;
revoke all on public.dm_threads from public, anon, authenticated;
revoke all on public.dm_messages from public, anon, authenticated;

-- a banned author writes nothing (52), and nobody writes twenty lines a minute (53)
drop trigger if exists guard_banned on public.dm_messages;
create trigger guard_banned before insert or update on public.dm_messages for each row execute function public.guard_banned();
drop trigger if exists guard_rate on public.dm_messages;
create trigger guard_rate before insert on public.dm_messages for each row execute function public.guard_rate('user_id', '1 minute', '20');

-- the other end of a thread
create or replace function public.dm_other(p_thread uuid, p_me uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select case when t.a = p_me then t.b when t.b = p_me then t.a end
  from public.dm_threads t where t.id = p_thread;
$$;
revoke execute on function public.dm_other(uuid, uuid) from public, anon, authenticated;

create or replace function public.dm_start(p_handle text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me    uuid := public.assert_member();
  other uuid;
  t     uuid;
begin
  if public.is_guest() then raise exception 'sign up to write to someone'; end if;
  select p.id into other from public.profiles p where p.handle = lower(btrim(regexp_replace(coalesce(p_handle, ''), '^@', '')));
  if other is null or other = me then raise exception 'no such person'; end if;
  if not public.are_friends(me, other) then raise exception 'friends only'; end if;
  if not public.reachable(me, other) then raise exception 'no such person'; end if;
  insert into public.dm_threads (a, b) values (least(me, other), greatest(me, other))
  on conflict (a, b) do update set last_at = public.dm_threads.last_at
  returning id into t;
  return t;
end;
$$;
revoke execute on function public.dm_start(text) from public, anon;
grant execute on function public.dm_start(text) to authenticated;

create or replace function public.dm_send(p_thread uuid, p_body text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  me    uuid := public.assert_member();
  other uuid := public.dm_other(p_thread, me);
  r     bigint;
begin
  if other is null then raise exception 'no such conversation'; end if;
  if not public.are_friends(me, other) or not public.reachable(me, other) then raise exception 'no such conversation'; end if;
  if length(btrim(coalesce(p_body, ''))) not between 1 and 1000 then raise exception '1 to 1000 characters'; end if;
  insert into public.dm_messages (thread_id, user_id, body) values (p_thread, me, btrim(p_body)) returning id into r;
  update public.dm_threads set last_at = now() where id = p_thread;
  if to_regprocedure('public.push_enqueue(uuid, text, text, jsonb)') is not null then
    perform public.push_enqueue(other, 'dm', format('dm:%s', r),
      jsonb_build_object('name', public.push_name(me), 'url', '/dm/' || p_thread));
  end if;
  return r;
end;
$$;
revoke execute on function public.dm_send(uuid, text) from public, anon;
grant execute on function public.dm_send(uuid, text) to authenticated;

create or replace function public.dm_unsay(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.dm_messages where id = p_id and user_id = public.assert_member();
end;
$$;
revoke execute on function public.dm_unsay(bigint) from public, anon;
grant execute on function public.dm_unsay(bigint) to authenticated;

create or replace function public.dm_thread(p_thread uuid, p_after bigint default 0)
returns table (id bigint, user_id uuid, name text, body text, created_at timestamptz, mine boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  if public.dm_other(p_thread, me) is null then raise exception 'no such conversation'; end if;
  return query
  select * from (
    select m.id, m.user_id, coalesce(p.display_name, p.handle), m.body, m.created_at, m.user_id = me
    from public.dm_messages m join public.profiles p on p.id = m.user_id
    where m.thread_id = p_thread and m.id > p_after
    order by m.id desc
    limit case when p_after = 0 then 80 else 500 end
  ) last order by last.id;
end;
$$;
revoke execute on function public.dm_thread(uuid, bigint) from public, anon;
grant execute on function public.dm_thread(uuid, bigint) to authenticated;

-- 90 adds a column to what this returns; a re-run must not trip on the old shape
drop function if exists public.dm_list();
create or replace function public.dm_list()
returns table (id uuid, other_id uuid, handle text, name text, last_body text, last_mine boolean, last_id bigint, last_at timestamptz)
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
         l.body, l.user_id = me, l.id, t.last_at
  from public.dm_threads t
  join public.profiles o on o.id = case when t.a = me then t.b else t.a end
  left join lateral (select m.id, m.body, m.user_id from public.dm_messages m where m.thread_id = t.id order by m.id desc limit 1) l on true
  where me in (t.a, t.b)
    and public.reachable(me, o.id)
  order by t.last_at desc;
end;
$$;
revoke execute on function public.dm_list() from public, anon;
grant execute on function public.dm_list() to authenticated;

-- the push: its own switch, its kind on the outbox
alter table public.profile_settings add column if not exists notify_dms boolean not null default true;
alter table public.push_outbox drop constraint if exists push_outbox_kind_check;
alter table public.push_outbox add constraint push_outbox_kind_check check (kind in (
  'friend_request', 'friend_accepted', 'match', 'friend_live',
  'night_soon', 'room_open', 'room_closing', 'room_message', 'reply',
  'digest', 'dj_live', 'wave', 'spark', 'spark_in',
  'group_added', 'group_joined', 'group_match', 'group_round', 'group_won', 'group_plan',
  'group_message', 'group_live', 'group_ticket', 'post',
  'staff', 'post_like', 'post_comment',
  'dm'));

create or replace function public.push_wants(p_user uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select case
             when p_kind = 'friend_request'  then s.notify_requests
             when p_kind = 'friend_accepted' then s.notify_accepts
             when p_kind = 'match'           then s.notify_matches
             when p_kind = 'friend_live'     then s.notify_live
             when p_kind = 'night_soon'      then s.notify_nights
             when p_kind in ('room_open', 'room_closing', 'room_message') then s.notify_rooms
             when p_kind = 'reply'           then s.notify_replies
             when p_kind = 'digest'          then s.notify_digest
             when p_kind = 'dj_live'         then s.notify_djs
             when p_kind = 'wave'            then s.notify_waves
             when p_kind in ('spark', 'spark_in') then s.notify_sparks
             when p_kind like 'group\_%' then s.notify_groups
             when p_kind in ('post', 'post_like', 'post_comment') then s.notify_posts
             when p_kind = 'dm'              then s.notify_dms
           end
    from public.profile_settings s where s.user_id = p_user), true);
$$;

-- what leaves with the account: the threads go with the profile (cascade); the export
-- (14) does not list them yet — a line in promises.md says so.

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('59_dms.sql', 'ff42a3de133b25de321f261391abc791c6ff92c428165841787a6f7a24d1032e');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('59_dms.sql');
  end if;
end $$;
