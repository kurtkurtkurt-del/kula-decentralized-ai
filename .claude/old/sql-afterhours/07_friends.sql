-- afterhours — the friendship calls
-- The table and the rules live in 01/02; these are the day-to-day calls.

-- The handle: friendship is built on it, so the shape is enforced.
-- Lower case, digits, underscore; 3-20 characters.
alter table public.profiles
  drop constraint if exists profiles_handle_bicim;
alter table public.profiles
  drop constraint if exists profiles_handle_format;
alter table public.profiles
  add constraint profiles_handle_format
  check (handle is null or handle ~ '^[a-z0-9_]{3,20}$');

-- Your friends and the pending requests, in one list.
-- direction: outgoing = you asked for it, incoming = they asked you.
-- create or replace is not enough when the return type changes; drop first.
drop function if exists public.friends_list();
create or replace function public.friends_list()
returns table (
  other_id      uuid,
  handle        text,
  display_name  text,
  status        text,
  direction     text
)
language sql
stable
as $$
  select f.addressee_id, p.handle, p.display_name, f.status, 'outgoing'
  from public.friendships f
  join public.profiles p on p.id = f.addressee_id
  where f.requester_id = auth.uid()
  union all
  select f.requester_id, p.handle, p.display_name, f.status, 'incoming'
  from public.friendships f
  join public.profiles p on p.id = f.requester_id
  where f.addressee_id = auth.uid()
  order by 4, 2;
$$;

-- Send a request by handle. If the other side
-- has already sent you one, this accepts it: no need to ask twice.
create or replace function public.friend_request(p_handle text)
returns text
language plpgsql
as $$
declare
  target uuid;
begin
  select id into target from public.profiles where handle = lower(btrim(p_handle));

  if target is null then
    return 'notfound';
  end if;
  if target = auth.uid() then
    return 'yourself';
  end if;

  -- If a request is pending in the other direction, accept that one
  if exists (select 1 from public.friendships
             where requester_id = target and addressee_id = auth.uid()) then
    update public.friendships set status = 'accepted'
    where requester_id = target and addressee_id = auth.uid();
    return 'accepted';
  end if;

  insert into public.friendships (requester_id, addressee_id)
  values (auth.uid(), target)
  on conflict (requester_id, addressee_id) do nothing;

  return 'sent';
end;
$$;

-- Accept a request that came to you.
create or replace function public.friend_accept(p_other uuid)
returns boolean
language sql
as $$
  update public.friendships set status = 'accepted'
  where requester_id = p_other and addressee_id = auth.uid()
  returning true;
$$;

-- End a friendship / take a request back. Works in both directions.
create or replace function public.friend_remove(p_other uuid)
returns boolean
language sql
as $$
  with removed as (
    delete from public.friendships
    where (requester_id = auth.uid() and addressee_id = p_other)
       or (addressee_id = auth.uid() and requester_id = p_other)
    returning 1
  )
  select exists (select 1 from removed);
$$;

grant execute on function public.friends_list()          to authenticated;
grant execute on function public.friend_request(text)    to authenticated;
grant execute on function public.friend_accept(uuid)     to authenticated;
grant execute on function public.friend_remove(uuid)     to authenticated;

-- Stamp the migration log, if it is there. Each numbered file still runs on
-- its own (the tests load them one at a time), so this cannot insist.
do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('07_friends.sql', 'a27ad77fe80fb499aac823f74e4bfa2038b774990cae105e839c926571a277cc');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('07_friends.sql');
  end if;
end $$;
