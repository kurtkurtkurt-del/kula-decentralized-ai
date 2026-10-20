-- pasaport — the door: who is asking, who may be seen
-- Two questions every function would otherwise answer in its own words. From here they
-- have one answer each, so a new function cannot forget a case the others remember.
--
--   is_admin()                   the owner's account (the panel)
--   is_banned(user)              a closed account (bans): it reads nothing, writes nothing
--   assert_member()              who is asking: a signed-in account that is not banned,
--                                else an exception (42501). Every read and write asks it
--                                first, in plpgsql, at declaration.
--   are_friends(a, b)            a confirmed friendship, either direction
--   reachable(viewer, other)     no block either way, the other not banned
--   visible_to(viewer, other)    reachable, and a friend or discoverable
--   waves(me)                    everyone within three confirmed steps, with the hops;
--                                a call (10) travels along it
--
-- The tables are closed; these are definer functions and the only way in.

create table if not exists public.bans (
  user_id    uuid primary key references public.profiles on delete cascade,
  reason     text,
  by_user    uuid references public.profiles on delete set null,
  created_at timestamptz not null default now()
);
create table if not exists public.blocks (
  blocker_id  uuid not null references public.profiles on delete cascade,
  blocked_id  uuid not null references public.profiles on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
alter table public.bans enable row level security;
alter table public.blocks enable row level security;
revoke all on public.bans, public.blocks from public, anon, authenticated;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

create or replace function public.is_banned(p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.bans b where b.user_id = p_user);
$$;

create or replace function public.assert_member()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  u uuid := auth.uid();
begin
  if u is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if public.is_banned(u) then
    raise exception 'this account is closed' using errcode = '42501';
  end if;
  return u;
end;
$$;

create or replace function public.need_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  u uuid := public.assert_member();
begin
  if not public.is_admin() then
    raise exception 'admins only' using errcode = '42501';
  end if;
  return u;
end;
$$;

create or replace function public.are_friends(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester_id = p_a and f.addressee_id = p_b) or (f.requester_id = p_b and f.addressee_id = p_a)));
$$;

create or replace function public.reachable(p_viewer uuid, p_other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_viewer is not null and p_other is not null
     and not public.is_banned(p_other)
     and not exists (select 1 from public.blocks b
                     where (b.blocker_id = p_viewer and b.blocked_id = p_other)
                        or (b.blocker_id = p_other and b.blocked_id = p_viewer));
$$;

create or replace function public.visible_to(p_viewer uuid, p_other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_viewer is not null and p_other is not null
     and (p_other = p_viewer
          or (public.reachable(p_viewer, p_other)
              and (public.are_friends(p_viewer, p_other)
                   or coalesce((select s.discoverable from public.profile_settings s where s.user_id = p_other), true))));
$$;

-- Everyone within three confirmed steps of p_me, with the fewest steps it takes; the
-- walk stops where p_me could not reach the person. p_me is not in it.
create or replace function public.waves(p_me uuid)
returns table (person uuid, hops int)
language sql
stable
security definer
set search_path = public
as $$
  with recursive f as (
    select requester_id as a, addressee_id as b from public.friendships where status = 'accepted'
    union all
    select addressee_id, requester_id from public.friendships where status = 'accepted'
  ),
  walk(person, hops) as (
    select b, 1 from f where a = p_me and public.reachable(p_me, b)
    union
    select f.b, w.hops + 1 from walk w join f on f.a = w.person
    where w.hops < 3 and public.reachable(p_me, f.b)
  )
  select w.person, min(w.hops)::int from walk w where w.person <> p_me group by w.person;
$$;

-- The helpers are oracles on somebody's data: callable by the functions, not the API.
revoke execute on function public.is_banned(uuid) from public, anon, authenticated;
revoke execute on function public.are_friends(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.reachable(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.visible_to(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.waves(uuid) from public, anon, authenticated;
revoke execute on function public.need_admin() from public, anon, authenticated;
revoke execute on function public.assert_member() from public, anon;
grant execute on function public.assert_member() to authenticated;
grant execute on function public.is_admin() to anon, authenticated;

-- A banned account writes nothing: the trigger every writable table carries.
create or replace function public.guard_banned()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_banned(auth.uid()) then
    raise exception 'this account is closed' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Nobody may make themselves an admin.
create or replace function public.guard_is_admin()
returns trigger
language plpgsql
as $$
begin
  if new.is_admin is distinct from old.is_admin and auth.uid() is not null and not public.is_admin() then
    raise exception 'is_admin can only be changed by an admin';
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_guard_admin on public.profiles;
create trigger profiles_guard_admin before update on public.profiles
  for each row execute function public.guard_is_admin();

-- ------------------------------------------------------- blocking someone
create or replace function public.block_user(p_other uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  if p_other is null or p_other = me then return false; end if;
  insert into public.blocks (blocker_id, blocked_id) values (me, p_other) on conflict do nothing;
  -- a block ends the friendship and the requests both ways
  delete from public.friendships where (requester_id = me and addressee_id = p_other) or (requester_id = p_other and addressee_id = me);
  return true;
end;
$$;
create or replace function public.unblock_user(p_other uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  delete from public.blocks where blocker_id = me and blocked_id = p_other;
  return found;
end;
$$;
create or replace function public.my_blocks()
returns table (id uuid, handle text, display_name text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  select p.id, p.handle, p.display_name, b.created_at
  from public.blocks b join public.profiles p on p.id = b.blocked_id
  where b.blocker_id = me order by b.created_at desc;
end;
$$;
revoke execute on function public.block_user(uuid), public.unblock_user(uuid), public.my_blocks() from public, anon;
grant execute on function public.block_user(uuid), public.unblock_user(uuid), public.my_blocks() to authenticated;

-- ---------------------------------------------------------- the staff ban
create or replace function public.staff_ban(p_user uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.need_admin();
begin
  if p_user = me then raise exception 'not yourself'; end if;
  insert into public.bans (user_id, reason, by_user) values (p_user, p_reason, me)
  on conflict (user_id) do update set reason = excluded.reason, by_user = me, created_at = now();
end;
$$;
create or replace function public.staff_unban(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_admin();
  delete from public.bans where user_id = p_user;
end;
$$;
-- What the app asks after a refusal: am I closed, and why.
create or replace function public.account_status()
returns table (banned boolean, reason text, at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.bans b where b.user_id = auth.uid()),
         (select b.reason from public.bans b where b.user_id = auth.uid()),
         (select b.created_at from public.bans b where b.user_id = auth.uid());
$$;
revoke execute on function public.staff_ban(uuid, text), public.staff_unban(uuid), public.account_status() from public, anon;
grant execute on function public.staff_ban(uuid, text), public.staff_unban(uuid), public.account_status() to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('02_doors.sql', '80e68d6bc30a89843264cb1357e1d38b23c1b1032d1d59b8d804340e8b2156a0');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('02_doors.sql');
  end if;
end $$;
