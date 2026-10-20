-- afterhours — a ban stays (74)
--
-- A banned person could delete the account, sign up again with the same address, take
-- the same handle and be back in ten minutes; and the room lines of a banned account
-- stayed on the wall (F13, 20.10.2026). Three things:
--   banned_marks   a hash of the email (md5, lowercased) and the handle of a banned
--                  account that deleted itself; closed table, written only by
--                  delete_account(), read only by the two below
--   ban_returns    a new profile whose email is marked is banned at birth
--   handle_status  a handle in the marks is taken
-- and room_list leaves out what a banned account wrote, as comments and posts
-- already do (52). delete_account() is that of 73 with the mark written.

create table if not exists public.banned_marks (
  mark    text primary key,
  handle  text,
  at      timestamptz not null default now()
);
alter table public.banned_marks enable row level security;
revoke all on public.banned_marks from public, anon, authenticated;

create or replace function public.delete_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  g  uuid;
begin
  if me is null then
    raise exception 'sign in first';
  end if;

  if exists (select 1 from public.profiles where id = me and is_admin)
     and not exists (select 1 from public.profiles where is_admin and id <> me) then
    raise exception 'the last admin stays an admin';
  end if;

  for g in select group_id from public.group_members where user_id = me loop
    delete from public.group_members where group_id = g and user_id = me;
    if not exists (select 1 from public.group_members where group_id = g) then
      delete from public.groups where id = g;
    elsif not exists (select 1 from public.group_members where group_id = g and role = 'owner') then
      update public.group_members set role = 'owner'
       where group_id = g and user_id = (select user_id from public.group_members
                                          where group_id = g order by joined_at, user_id limit 1);
    end if;
  end loop;

  -- what the person said in rooms and groups leaves with them
  delete from public.room_posts where user_id = me;
  delete from public.group_messages where user_id = me;

  update public.comments
     set author_id = null, author_name = 'someone'
   where author_id = me;

  -- a banned person who deletes their account is remembered by a hash of the email
  -- and keeps their handle: the same address comes back banned, the name stays taken
  if exists (select 1 from public.profiles where id = me and banned_at is not null) then
    insert into public.banned_marks (mark, handle)
    select md5(lower(u.email)), p.handle from auth.users u join public.profiles p on p.id = u.id
    where u.id = me and u.email is not null
    on conflict (mark) do nothing;
  end if;

  delete from auth.users where id = me;
end;
$$;

-- The profile is made by handle_new_user (12) on the auth row; this runs right after.
create or replace function public.ban_returns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  mail text;
begin
  select u.email into mail from auth.users u where u.id = new.id;
  if mail is not null and exists (select 1 from public.banned_marks where mark = md5(lower(mail))) then
    perform set_config('afterhours.ban', 'on', true);
    update public.profiles
       set banned_at = now(), banned_reason = 'banned before', banned_by = null
     where id = new.id;
    perform set_config('afterhours.ban', '', true);
  end if;
  return new;
end;
$$;
revoke execute on function public.ban_returns() from public, anon, authenticated;
drop trigger if exists ban_returns on public.profiles;
create trigger ban_returns
  after insert on public.profiles
  for each row execute function public.ban_returns();

create or replace function public.handle_status(p_handle text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when coalesce(btrim(p_handle), '') = ''            then 'empty'
    when lower(btrim(p_handle)) !~ '^[a-z0-9_]{3,20}$' then 'format'
    when exists (select 1 from public.profiles
                 where handle = lower(btrim(p_handle)) and id = auth.uid()) then 'yours'
    when exists (select 1 from public.profiles
                 where handle = lower(btrim(p_handle))) then 'taken'
    when exists (select 1 from public.banned_marks
                 where handle = lower(btrim(p_handle))) then 'taken'
    else 'ok'
  end;
$$;

create or replace function public.room_list(p_slug text)
returns table (
  id          uuid,
  body        text,
  who         text,
  mine        boolean,
  created_at  timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select r.id, r.body, lower(left(coalesce(p.display_name, p.handle, 's'), 1)), r.user_id = auth.uid(), r.created_at
  from public.room_posts r
  join public.events e on e.id = r.event_id
  left join public.profiles p on p.id = r.user_id
  where e.slug = p_slug and public.checked_in(e.id)
    and not public.hidden_by_block(r.user_id)
    and not public.is_banned(r.user_id)
  order by r.created_at;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('74_ban_stays.sql', '4a96d6ee01aed02a6fa04804d57c7446838fa3ca7cfc4d88f00caca26d26268a');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('74_ban_stays.sql');
  end if;
end $$;
