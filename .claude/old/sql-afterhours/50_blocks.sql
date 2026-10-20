-- afterhours — blocking someone (50, after 07, 12, 25, 28)
--
--   blocks                 who blocked whom; a closed table, read through my_blocks()
--   block_user(other)      blocks: the friendship or a pending request between you
--                          is gone, and neither side can ask again
--   unblock_user(other)    takes it back (the friendship does not come back)
--   my_blocks()            the people you blocked, for the list in settings
--   is_blocked(other)      true when either of you blocked the other
--
-- What a block does, in both directions: the card is not shown (card_visible,
-- so profile_card, people_search and people_suggested), no friend request can
-- be sent (friend_request answers notfound, a direct insert is refused), and the
-- wave of a spark does not reach across it. Everything that is for friends only
-- (posts, photos, links, kept nights, push) closes with the friendship.
-- The blocked person is not told.

create table if not exists public.blocks (
  blocker_id  uuid not null references public.profiles(id) on delete cascade,
  blocked_id  uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists blocks_blocked on public.blocks (blocked_id);

alter table public.blocks enable row level security;
revoke all on public.blocks from public, anon, authenticated;

create or replace function public.is_blocked(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.blocks b
                 where (b.blocker_id = auth.uid() and b.blocked_id = other)
                    or (b.blocker_id = other and b.blocked_id = auth.uid()));
$$;
revoke execute on function public.is_blocked(uuid) from public, anon;
grant execute on function public.is_blocked(uuid) to authenticated;

create or replace function public.block_user(p_other uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if p_other is null or p_other = auth.uid() then raise exception 'not yourself'; end if;
  if not exists (select 1 from public.profiles where id = p_other) then raise exception 'no such person'; end if;
  insert into public.blocks (blocker_id, blocked_id) values (auth.uid(), p_other)
  on conflict do nothing;
  delete from public.friendships
  where (requester_id = auth.uid() and addressee_id = p_other)
     or (addressee_id = auth.uid() and requester_id = p_other);
  return true;
end;
$$;

create or replace function public.unblock_user(p_other uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  with gone as (
    delete from public.blocks where blocker_id = auth.uid() and blocked_id = p_other returning 1
  )
  select exists (select 1 from gone);
$$;

drop function if exists public.my_blocks();
create or replace function public.my_blocks()
returns table (id uuid, handle text, display_name text, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.handle, p.display_name, b.created_at
  from public.blocks b join public.profiles p on p.id = b.blocked_id
  where b.blocker_id = auth.uid()
  order by b.created_at desc;
$$;

revoke execute on function public.block_user(uuid)   from public, anon;
revoke execute on function public.unblock_user(uuid) from public, anon;
revoke execute on function public.my_blocks()        from public, anon;
grant execute on function public.block_user(uuid)    to authenticated;
grant execute on function public.unblock_user(uuid)  to authenticated;
grant execute on function public.my_blocks()         to authenticated;

-- ------------------------------------------------------------ the card

-- As in 12, plus: nobody on either side of a block sees the card of the other.
create or replace function public.card_visible(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select other = auth.uid()
      or (not public.is_blocked(other)
          and (public.is_friend(other)
               or coalesce((select s.discoverable from public.profile_settings s
                            where s.user_id = other), true)));
$$;
revoke execute on function public.card_visible(uuid) from public, anon, authenticated;

-- ------------------------------------------------------- friend requests

-- As in 12, plus: across a block the handle does not exist.
create or replace function public.friend_request(p_handle text)
returns text
language plpgsql
as $$
declare
  target uuid;
begin
  target := public.handle_to_id(p_handle);

  if target is null or public.is_blocked(target) then
    return 'notfound';
  end if;
  if target = auth.uid() then
    return 'yourself';
  end if;

  if exists (select 1 from public.friendships
             where requester_id = target and addressee_id = auth.uid()) then
    update public.friendships set status = 'accepted'
    where requester_id = target and addressee_id = auth.uid();
    return 'accepted';
  end if;

  insert into public.friendships (requester_id, addressee_id)
  values (auth.uid(), target)
  on conflict do nothing;
  return 'sent';
end;
$$;

-- A row written straight into friendships (the column grant allows it) is
-- held to the same rule.
create or replace function public.friendships_not_blocked()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.blocks b
             where (b.blocker_id = new.requester_id and b.blocked_id = new.addressee_id)
                or (b.blocker_id = new.addressee_id and b.blocked_id = new.requester_id)) then
    raise exception 'not possible';
  end if;
  return new;
end;
$$;
drop trigger if exists friendships_not_blocked on public.friendships;
create trigger friendships_not_blocked before insert on public.friendships
  for each row execute function public.friendships_not_blocked();

-- ------------------------------------------------------------ the waves

-- As in 28, minus anyone on either side of a block with the host.
create or replace function public.spark_waves(p_me uuid)
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
    select b, 1 from f where a = p_me
    union
    select f.b, w.hops + 1 from walk w join f on f.a = w.person where w.hops < 3
  )
  select w.person, min(w.hops)::int from walk w
  where w.person <> p_me
    and not exists (select 1 from public.blocks b
                    where (b.blocker_id = p_me and b.blocked_id = w.person)
                       or (b.blocker_id = w.person and b.blocked_id = p_me))
  group by w.person;
$$;
revoke execute on function public.spark_waves(uuid) from public, anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('50_blocks.sql', '89faa1b9187bc4632d01445a2664e4058e074ad8389e82bb2496c5ff04988c61');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('50_blocks.sql');
  end if;
end $$;
