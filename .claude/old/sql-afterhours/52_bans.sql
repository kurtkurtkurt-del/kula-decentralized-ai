-- afterhours — closing an account (52, after 42 to 51)
--
--   profiles.banned_at / banned_reason / banned_by
--   staff_ban(user, reason)   the staff close an account: nothing more can be
--                             written from it, its card disappears for everyone,
--                             its comments and posts are hidden, its upcoming
--                             sparks are called off, and its reports are settled.
--                             Staff cannot be banned (an admin takes the role first).
--   staff_unban(user)         opens it again; hidden content stays hidden.
--   account_status()          the app asks once at start: banned or not, and why.
--   admin_people_by(q, role)  as in 49, plus banned, and banned as a role filter.
--   admin_role_counts()       as in 49, plus banned.
--
-- The block is in the database, not only in the app: a trigger on every table a
-- person writes to refuses a banned author.

alter table public.profiles add column if not exists banned_at timestamptz;
alter table public.profiles add column if not exists banned_reason text;
alter table public.profiles add column if not exists banned_by uuid references public.profiles on delete set null;

create or replace function public.is_banned(p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select p.banned_at is not null from public.profiles p where p.id = p_user), false);
$$;
revoke execute on function public.is_banned(uuid) from public, anon;
grant execute on function public.is_banned(uuid) to authenticated;

-- ------------------------------------------------------------ the guard

create or replace function public.guard_banned()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and public.is_banned(auth.uid()) then
    raise exception 'this account is closed' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['comments', 'room_posts', 'group_messages', 'posts', 'sparks', 'groups', 'group_photos',
                           'group_members', 'group_invites', 'friendships', 'profile_links', 'profile_photos',
                           'rsvps', 'reports', 'events']
  loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop trigger if exists guard_banned on public.%I', t);
    execute format('create trigger guard_banned before insert or update on public.%I for each row execute function public.guard_banned()', t);
  end loop;
end $$;

-- The profile: a closed account cannot change its own words (the staff still can,
-- and seen() still stamps the clock).
create or replace function public.guard_banned_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.id = auth.uid() and old.banned_at is not null
     and (new.handle, new.display_name, new.bio, new.about) is distinct from (old.handle, old.display_name, old.bio, old.about) then
    raise exception 'this account is closed' using errcode = '42501';
  end if;
  -- Only the staff move the ban itself.
  if (new.banned_at, new.banned_reason, new.banned_by) is distinct from (old.banned_at, old.banned_reason, old.banned_by)
     and coalesce(current_setting('afterhours.ban', true), '') <> 'on' then
    raise exception 'only the staff close an account' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_banned_profile on public.profiles;
create trigger guard_banned_profile before update on public.profiles
  for each row execute function public.guard_banned_profile();

-- ------------------------------------------------------------ what others see

-- As in 50, plus: a closed account shows to nobody but itself.
create or replace function public.card_visible(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select other = auth.uid()
      or (not public.is_blocked(other)
          and not public.is_banned(other)
          and (public.is_friend(other)
               or coalesce((select s.discoverable from public.profile_settings s
                            where s.user_id = other), true)));
$$;
revoke execute on function public.card_visible(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ the staff

create or replace function public.staff_ban(p_user uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.profiles%rowtype;
begin
  perform public.need_staff();
  select * into p from public.profiles where id = p_user;
  if p.id is null then raise exception 'no such person'; end if;
  if p.id = auth.uid() then raise exception 'not yourself'; end if;
  if p.is_admin or p.account_type in ('admin', 'community_manager') then
    raise exception 'staff cannot be banned; take the role first';
  end if;
  perform set_config('afterhours.ban', 'on', true);
  update public.profiles
     set banned_at = coalesce(banned_at, now()), banned_reason = left(nullif(btrim(p_reason), ''), 300), banned_by = auth.uid()
   where id = p_user;
  perform set_config('afterhours.ban', '', true);
  update public.comments set is_hidden = true where author_id = p_user and not is_hidden;
  update public.posts set is_hidden = true where author_id = p_user and not is_hidden;
  delete from public.sparks where host_id = p_user and starts_at > now();
  delete from public.friendships where requester_id = p_user and status = 'pending';
  update public.reports set handled = true where not handled and public.report_author_any(kind, target) = p_user;
  perform public.staff_note('ban', 'person', p_user::text, p_reason);
end;
$$;

create or replace function public.staff_unban(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  perform set_config('afterhours.ban', 'on', true);
  update public.profiles set banned_at = null, banned_reason = null, banned_by = null where id = p_user;
  perform set_config('afterhours.ban', '', true);
  perform public.staff_note('unban', 'person', p_user::text, null);
end;
$$;

-- From the reports pile: close the account behind a reported thing, and take the thing away.
create or replace function public.staff_ban_author(p_kind text, p_target text, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a uuid := public.report_author_any(p_kind, p_target);
begin
  perform public.need_staff();
  if a is null then raise exception 'nobody to ban'; end if;
  perform public.staff_report_settle(p_kind, p_target, true);
  perform public.staff_ban(a, coalesce(nullif(btrim(p_reason), ''), 'report: ' || p_kind));
end;
$$;
revoke execute on function public.staff_ban_author(text, text, text) from public, anon;
grant execute on function public.staff_ban_author(text, text, text) to authenticated;

create or replace function public.account_status()
returns table (banned boolean, reason text, at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select p.banned_at is not null, p.banned_reason, p.banned_at from public.profiles p where p.id = auth.uid();
$$;

revoke execute on function public.staff_ban(uuid, text) from public, anon;
revoke execute on function public.staff_unban(uuid)     from public, anon;
revoke execute on function public.account_status()      from public, anon;
grant execute on function public.staff_ban(uuid, text)  to authenticated;
grant execute on function public.staff_unban(uuid)      to authenticated;
grant execute on function public.account_status()       to authenticated;

-- ------------------------------------------------------------ people in the panel

drop function if exists public.admin_people_by(text, text);
create or replace function public.admin_people_by(p_query text, p_role text)
returns table (id uuid, handle text, display_name text, role text, created_at timestamptz, nights int, groups int, banned boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  q text := lower(btrim(coalesce(p_query, '')));
begin
  perform public.need_admin();
  return query
    select p.id, p.handle, p.display_name,
           case when p.is_admin then 'admin' else p.account_type end, p.created_at,
           (select count(*)::int from public.swipes s where s.user_id = p.id and s.direction = 'right'),
           (select count(*)::int from public.group_members m where m.user_id = p.id),
           p.banned_at is not null
    from public.profiles p
    where (q = '' or lower(coalesce(p.handle, '')) like '%' || q || '%' or lower(coalesce(p.display_name, '')) like '%' || q || '%')
      and (coalesce(p_role, '') = ''
           or (p_role = 'new' and p.created_at > now() - interval '7 days')
           or (p_role = 'banned' and p.banned_at is not null)
           or (p_role = 'admin' and p.is_admin)
           or (p_role not in ('new', 'admin', 'banned') and not p.is_admin and p.account_type = p_role))
    order by (p.is_admin or p.account_type <> 'user') desc, p.created_at desc
    limit 80;
end;
$$;
revoke execute on function public.admin_people_by(text, text) from public, anon;
grant execute on function public.admin_people_by(text, text) to authenticated;

create or replace function public.admin_role_counts()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_admin();
  return json_build_object(
    'all', (select count(*) from public.profiles),
    'dj', (select count(*) from public.profiles where account_type = 'dj' and not is_admin),
    'community_manager', (select count(*) from public.profiles where account_type = 'community_manager' and not is_admin),
    'admin', (select count(*) from public.profiles where is_admin),
    'new', (select count(*) from public.profiles where created_at > now() - interval '7 days'),
    'banned', (select count(*) from public.profiles where banned_at is not null));
end;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('52_bans.sql', '41fce784b97a0db9d912cb83000e85fb052e5d4e7f0c8180de1c13c9d9dfde12');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('52_bans.sql');
  end if;
end $$;
