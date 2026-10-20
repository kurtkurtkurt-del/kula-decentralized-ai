-- pasaport — direct messages
--   dm_threads                 one row per pair of friends who wrote each other (a < b),
--                              with the last line each side has seen
--   dm_messages                the lines, 1000 characters at most; client_id so a line sent
--                              twice from the outbox is stored once
--   dm_start(handle)           opens (or finds) the thread with a friend you can reach
--   dm_send(thread, body, client_id) · dm_unsay(id)
--   dm_thread(thread, after)   the lines after a given id (0: the last 80), oldest first
--   dm_list()                  your threads, newest first, with the unread count
--   dm_seen(thread, id)        "I have read up to here"
-- Friends only, and only while neither has blocked the other and neither is banned.

create table if not exists public.dm_threads (
  id          uuid primary key default gen_random_uuid(),
  a           uuid not null references public.profiles on delete cascade,
  b           uuid not null references public.profiles on delete cascade,
  created_at  timestamptz not null default now(),
  last_at     timestamptz not null default now(),
  seen_a      bigint not null default 0,
  seen_b      bigint not null default 0,
  check (a < b),
  unique (a, b)
);
create table if not exists public.dm_messages (
  id          bigserial primary key,
  thread_id   uuid not null references public.dm_threads on delete cascade,
  user_id     uuid not null references public.profiles on delete cascade,
  body        text not null check (length(body) between 1 and 1000),
  client_id   uuid,
  created_at  timestamptz not null default now()
);
create index if not exists dm_messages_thread on public.dm_messages (thread_id, id);
create unique index if not exists dm_messages_client_idx on public.dm_messages (user_id, client_id);
alter table public.dm_threads enable row level security;
alter table public.dm_messages enable row level security;
revoke all on public.dm_threads, public.dm_messages from public, anon, authenticated;
drop trigger if exists guard_banned on public.dm_messages;
create trigger guard_banned before insert or update on public.dm_messages for each row execute function public.guard_banned();

create or replace function public.dm_other(p_thread uuid, p_me uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select case when t.a = p_me then t.b when t.b = p_me then t.a end from public.dm_threads t where t.id = p_thread;
$$;
revoke execute on function public.dm_other(uuid, uuid) from public, anon, authenticated;

create or replace function public.dm_start(p_handle text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  other uuid := public.handle_to_id(p_handle);
  t uuid;
begin
  if other is null or other = me then raise exception 'no such person'; end if;
  if not public.are_friends(me, other) then raise exception 'friends only'; end if;
  if not public.reachable(me, other) then raise exception 'no such person'; end if;
  insert into public.dm_threads (a, b) values (least(me, other), greatest(me, other))
  on conflict (a, b) do update set last_at = public.dm_threads.last_at returning id into t;
  return t;
end;
$$;

create or replace function public.dm_send(p_thread uuid, p_body text, p_client_id uuid default null)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  other uuid := public.dm_other(p_thread, me);
  r bigint;
begin
  if p_client_id is not null then
    select id into r from public.dm_messages where user_id = me and client_id = p_client_id;
    if r is not null then return r; end if;
  end if;
  if other is null or not public.are_friends(me, other) or not public.reachable(me, other) then raise exception 'no such conversation'; end if;
  if length(btrim(coalesce(p_body, ''))) not between 1 and 1000 then raise exception '1 to 1000 characters'; end if;
  if (select count(*) from public.dm_messages m where m.user_id = me and m.created_at > now() - interval '1 minute') >= 20 then
    raise exception 'slow down' using errcode = '53400';
  end if;
  insert into public.dm_messages (thread_id, user_id, body, client_id) values (p_thread, me, btrim(p_body), p_client_id) returning id into r;
  update public.dm_threads set last_at = now() where id = p_thread;
  if to_regprocedure('public.push_enqueue(uuid, text, text, jsonb)') is not null then
    perform public.push_enqueue(other, 'dm', format('dm:%s', r), jsonb_build_object('name', public.push_name(me), 'url', '/dm/' || p_thread));
  end if;
  return r;
end;
$$;

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

drop function if exists public.dm_thread(uuid, bigint);
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
    order by m.id desc limit case when p_after = 0 then 80 else 500 end) last order by last.id;
end;
$$;

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
  select t.id, o.id, o.handle, coalesce(o.display_name, o.handle), l.body, l.user_id = me, l.id, t.last_at,
         (select count(*)::int from public.dm_messages u where u.thread_id = t.id and u.user_id <> me
            and u.id > case when t.a = me then t.seen_a else t.seen_b end)
  from public.dm_threads t
  join public.profiles o on o.id = case when t.a = me then t.b else t.a end
  left join lateral (select m.id, m.body, m.user_id from public.dm_messages m where m.thread_id = t.id order by m.id desc limit 1) l on true
  where me in (t.a, t.b) and public.reachable(me, o.id)
  order by t.last_at desc;
end;
$$;

create or replace function public.dm_seen(p_thread uuid, p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  update public.dm_threads
     set seen_a = case when a = me then greatest(seen_a, p_id) else seen_a end,
         seen_b = case when b = me then greatest(seen_b, p_id) else seen_b end
   where id = p_thread and me in (a, b);
end;
$$;

revoke execute on function public.dm_start(text), public.dm_send(uuid, text, uuid), public.dm_unsay(bigint), public.dm_thread(uuid, bigint),
  public.dm_list(), public.dm_seen(uuid, bigint) from public, anon;
grant execute on function public.dm_start(text), public.dm_send(uuid, text, uuid), public.dm_unsay(bigint), public.dm_thread(uuid, bigint),
  public.dm_list(), public.dm_seen(uuid, bigint) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('11_dms.sql', '545884dc84790eadbb55e9d6f6a1324354fb787cdbe9dcca93482e0ee54c3589');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('11_dms.sql');
  end if;
end $$;
