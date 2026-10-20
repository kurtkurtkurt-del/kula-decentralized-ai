-- afterhours — what a guest kept comes along (80)
--
-- A guest who signs up with an email that already has an account is sent to sign in,
-- and the anonymous session is replaced: the swipes made as a guest stayed behind on
-- a user nobody could reach again (F31, 20.10.2026). The app now remembers the guest
-- id across that sign-in and calls guest_merge once: the swipes move to the account
-- (a night already swiped there keeps the answer of the account), and the guest user is
-- deleted. Only an anonymous user with no email can be taken over, and only by a
-- signed-in account; the id is the one thing the device knows about its guest.
--
--   guest_merge(guest_id)   returns how many swipes came along

create or replace function public.guest_merge(p_guest uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  n  int;
begin
  if me is null or public.is_guest() then raise exception 'sign in first'; end if;
  if p_guest is null or p_guest = me then return 0; end if;
  if not exists (select 1 from auth.users u where u.id = p_guest and coalesce(u.is_anonymous, false) and u.email is null) then
    raise exception 'not a guest';
  end if;
  insert into public.swipes (user_id, event_id, direction, created_at)
  select me, s.event_id, s.direction, s.created_at from public.swipes s where s.user_id = p_guest
  on conflict (user_id, event_id) do nothing;
  get diagnostics n = row_count;
  delete from auth.users where id = p_guest;
  return n;
end;
$$;
grant execute on function public.guest_merge(uuid) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('80_guest_merge.sql', 'd053253ca69f493d9d74c7f94056bef8327b61d0a65d7ba9beaf129d90b5e3d0');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('80_guest_merge.sql');
  end if;
end $$;
