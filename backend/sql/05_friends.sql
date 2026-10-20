-- pasaport — the friendship calls
--   friends_list()           your friends and the pending requests, both directions
--   friend_request(handle)   sent · accepted (they had asked you) · notfound · yourself · blocked
--   friend_accept(other)     a request that came to you
--   friend_remove(other)     ends a friendship or takes a request back, either direction
-- A request never reaches someone who blocked you, or whom you blocked; it says 'notfound'
-- either way, so the call cannot be used to find out who blocked whom.

drop function if exists public.friends_list();
create or replace function public.friends_list()
returns table (other_id uuid, handle text, display_name text, status text, direction text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  select f.addressee_id, p.handle, p.display_name, f.status, 'outgoing'::text
  from public.friendships f join public.profiles p on p.id = f.addressee_id
  where f.requester_id = me and public.reachable(me, f.addressee_id)
  union all
  select f.requester_id, p.handle, p.display_name, f.status, 'incoming'::text
  from public.friendships f join public.profiles p on p.id = f.requester_id
  where f.addressee_id = me and public.reachable(me, f.requester_id)
  order by 4, 2;
end;
$$;

create or replace function public.friend_request(p_handle text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  target uuid := public.handle_to_id(p_handle);
begin
  if target is null then return 'notfound'; end if;
  if target = me then return 'yourself'; end if;
  if not public.reachable(me, target) then return 'notfound'; end if;
  if exists (select 1 from public.friendships where requester_id = target and addressee_id = me) then
    update public.friendships set status = 'accepted' where requester_id = target and addressee_id = me;
    return 'accepted';
  end if;
  insert into public.friendships (requester_id, addressee_id) values (me, target) on conflict do nothing;
  return 'sent';
end;
$$;

create or replace function public.friend_accept(p_other uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  update public.friendships set status = 'accepted' where requester_id = p_other and addressee_id = me and public.reachable(me, p_other);
  return found;
end;
$$;

create or replace function public.friend_remove(p_other uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  delete from public.friendships
  where (requester_id = me and addressee_id = p_other) or (addressee_id = me and requester_id = p_other);
  return found;
end;
$$;

revoke execute on function public.friends_list(), public.friend_request(text), public.friend_accept(uuid), public.friend_remove(uuid) from public, anon;
grant execute on function public.friends_list(), public.friend_request(text), public.friend_accept(uuid), public.friend_remove(uuid) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('05_friends.sql', 'b7475273e62b992289603bdfc3cdf747daa2876debd2939f6929b8f07f29202c');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('05_friends.sql');
  end if;
end $$;
