-- afterhours — trust (53, after 42 to 52)
--
--   dj pages       a page someone makes for themselves is checked by the staff before
--                  anyone else sees it (djs.verified); renaming it asks again; going back
--                  to normal user takes it down. staff_djs_waiting(), staff_dj_verify().
--   admins         an admin makes or unmakes another admin in the panel (admin_set_admin);
--                  the last admin can never be taken away, so the panel cannot end up
--                  without one.
--   notices        the other side is told: a hidden comment or post, a removed message,
--                  spark or group, a cleared profile, a new role, a dj page let through
--                  or taken down. my_notices(), notices_seen(). Written by triggers, so
--                  every path that does it (panel, reports, bans) says so.
--   limits         a ceiling on everything a person can write in a burst: requests,
--                  comments, room and group messages, groups, sparks, invite codes.
--   groups         nobody joins or is added to a group where a block stands between
--                  them and a member.

-- ------------------------------------------------------------ notices

create table if not exists public.notices (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles on delete cascade,
  kind        text not null check (kind in ('comment_hidden', 'post_hidden', 'removed', 'profile_cleared',
                                            'role', 'dj_verified', 'dj_hidden')),
  data        jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  seen_at     timestamptz
);
create index if not exists notices_user on public.notices (user_id, created_at desc) where seen_at is null;
alter table public.notices enable row level security;
revoke all on public.notices from public, anon, authenticated;

create or replace function public.notice(p_user uuid, p_kind text, p_data jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.notices (user_id, kind, data)
  select p_user, p_kind, coalesce(p_data, '{}') where p_user is not null;
$$;
revoke all on function public.notice(uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.my_notices()
returns table (id bigint, kind text, data jsonb, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select n.id, n.kind, n.data, n.created_at from public.notices n
  where n.user_id = auth.uid() and n.seen_at is null
  order by n.created_at desc
  limit 20;
$$;

create or replace function public.notices_seen()
returns void
language sql
security definer
set search_path = public
as $$
  update public.notices set seen_at = now() where user_id = auth.uid() and seen_at is null;
$$;

revoke execute on function public.my_notices()   from public, anon;
revoke execute on function public.notices_seen() from public, anon;
grant execute on function public.my_notices()    to authenticated;
grant execute on function public.notices_seen()  to authenticated;

-- Hidden by someone else (the staff): the author is told, with the first words.
create or replace function public.notice_hidden()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  author uuid := new.author_id;
begin
  if new.is_hidden and not old.is_hidden and auth.uid() is distinct from author then
    perform public.notice(author, case when TG_TABLE_NAME in ('comments', 'post_comments') then 'comment_hidden' else 'post_hidden' end,
                          jsonb_build_object('text', left(new.body, 80)));
  end if;
  return new;
end;
$$;
drop trigger if exists notice_hidden on public.comments;
create trigger notice_hidden after update of is_hidden on public.comments for each row execute function public.notice_hidden();
drop trigger if exists notice_hidden on public.posts;
create trigger notice_hidden after update of is_hidden on public.posts for each row execute function public.notice_hidden();

-- Deleted by the staff (not by the author, not by a cascade from a deleted night or group).
create or replace function public.notice_removed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  author uuid;
  what text;
begin
  if auth.uid() is null or not public.is_staff() then return old; end if;
  if TG_TABLE_NAME = 'room_posts' then author := old.user_id; what := left(old.body, 80);
  elsif TG_TABLE_NAME = 'group_messages' then
    if old.kind <> 'say' then return old; end if;
    author := old.user_id; what := left(old.body, 80);
  elsif TG_TABLE_NAME = 'sparks' then author := old.host_id; what := old.title;
  elsif TG_TABLE_NAME = 'groups' then author := old.created_by; what := old.name;
  end if;
  if author is not null and author <> auth.uid() then
    perform public.notice(author, 'removed', jsonb_build_object('what', TG_TABLE_NAME, 'text', what));
  end if;
  return old;
end;
$$;
do $$
declare t text;
begin
  foreach t in array array['room_posts', 'group_messages', 'sparks', 'groups'] loop
    execute format('drop trigger if exists notice_removed on public.%I', t);
    execute format('create trigger notice_removed after delete on public.%I for each row execute function public.notice_removed()', t);
  end loop;
end $$;

-- The profile: words cleared by the staff, or a new role given.
create or replace function public.notice_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or auth.uid() = new.id then return new; end if;
  if (old.bio is not null or old.about is not null) and new.bio is null and new.about is null then
    perform public.notice(new.id, 'profile_cleared', '{}');
  end if;
  if new.account_type is distinct from old.account_type or new.is_admin is distinct from old.is_admin then
    perform public.notice(new.id, 'role', jsonb_build_object('role', case when new.is_admin then 'admin' else new.account_type end));
  end if;
  return new;
end;
$$;
drop trigger if exists notice_profile on public.profiles;
create trigger notice_profile after update on public.profiles for each row execute function public.notice_profile();

-- ------------------------------------------------------------ dj pages

alter table public.djs add column if not exists verified boolean not null default true;
alter table public.djs add column if not exists verified_at timestamptz;

-- A page made or renamed by its owner waits for the staff.
create or replace function public.guard_dj_verified()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_staff() then return new; end if;
  if TG_OP = 'INSERT' then
    if new.owner_id is not null then new.verified := false; new.verified_at := null; end if;
  elsif new.verified is distinct from old.verified
        or (new.owner_id is not null and new.name is distinct from old.name) then
    new.verified := false;
    new.verified_at := null;
  end if;
  return new;
end;
$$;
drop trigger if exists guard_dj_verified on public.djs;
create trigger guard_dj_verified before insert or update on public.djs
  for each row execute function public.guard_dj_verified();

-- Readers see checked pages; the owner and the staff see theirs too.
drop policy if exists djs_read on public.djs;
create policy djs_read on public.djs for select
  using (verified or owner_id = auth.uid() or public.is_staff());
drop policy if exists dj_sets_read on public.dj_sets;
create policy dj_sets_read on public.dj_sets for select
  using (exists (select 1 from public.djs d where d.id = dj_sets.dj_id and (d.verified or d.owner_id = auth.uid() or public.is_staff())));

-- Back to normal user: the page goes down with the role.
create or replace function public.dj_role_gone()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.account_type = 'dj' and new.account_type <> 'dj' then
    update public.djs set verified = false, verified_at = null where owner_id = new.id and verified;
  end if;
  return new;
end;
$$;
drop trigger if exists dj_role_gone on public.profiles;
create trigger dj_role_gone after update of account_type on public.profiles
  for each row execute function public.dj_role_gone();

create or replace function public.staff_djs_waiting()
returns table (id uuid, slug text, name text, genre text, bio text, photo_url text, owner text, owner_role text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  return query
    select d.id, d.slug, d.name, d.genre, d.bio, d.photo_url, coalesce(p.handle, p.display_name), p.account_type, d.created_at
    from public.djs d join public.profiles p on p.id = d.owner_id
    where not d.verified and p.account_type = 'dj'
    order by d.created_at;
end;
$$;

create or replace function public.staff_dj_verify(p_dj uuid, p_ok boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.djs%rowtype;
begin
  perform public.need_staff();
  select * into d from public.djs where id = p_dj;
  if d.id is null then raise exception 'no such dj'; end if;
  update public.djs set verified = coalesce(p_ok, false), verified_at = case when p_ok then now() end where id = p_dj;
  perform public.notice(d.owner_id, case when p_ok then 'dj_verified' else 'dj_hidden' end, jsonb_build_object('name', d.name));
  perform public.staff_note(case when p_ok then 'verify' else 'turn down' end, 'dj', p_dj::text, d.name);
end;
$$;

revoke execute on function public.staff_djs_waiting()              from public, anon;
revoke execute on function public.staff_dj_verify(uuid, boolean)   from public, anon;
grant execute on function public.staff_djs_waiting()               to authenticated;
grant execute on function public.staff_dj_verify(uuid, boolean)    to authenticated;

-- ------------------------------------------------------------ admins

-- ok · self (not on yourself) · last (the last admin stays) · none
create or replace function public.admin_set_admin(p_user uuid, p_on boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  who public.profiles%rowtype;
begin
  perform public.need_admin();
  select * into who from public.profiles where id = p_user;
  if who.id is null then return 'none'; end if;
  if who.id = auth.uid() then return 'self'; end if;
  if who.banned_at is not null then return 'banned'; end if;
  if not coalesce(p_on, false) and (select count(*) from public.profiles where is_admin) <= 1 then return 'last'; end if;
  perform set_config('afterhours.account_type', 'on', true);
  update public.profiles
     set is_admin = coalesce(p_on, false),
         account_type = case when p_on then 'admin' when account_type = 'admin' then 'user' else account_type end
   where id = p_user;
  perform set_config('afterhours.account_type', '', true);
  perform public.staff_note(case when p_on then 'make admin' else 'unmake admin' end, 'person', p_user::text, coalesce(who.handle, who.display_name));
  return 'ok';
end;
$$;
revoke execute on function public.admin_set_admin(uuid, boolean) from public, anon;
grant execute on function public.admin_set_admin(uuid, boolean) to authenticated;

-- Whatever path it takes, the last admin is never taken away.
create or replace function public.guard_last_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.is_admin and not new.is_admin
     and not exists (select 1 from public.profiles where is_admin and id <> old.id) then
    raise exception 'the last admin stays an admin';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_last_admin on public.profiles;
create trigger guard_last_admin before update of is_admin on public.profiles
  for each row execute function public.guard_last_admin();

-- ------------------------------------------------------------ limits

-- TG_ARGV: the column holding the author, the window, the most in it.
create or replace function public.guard_rate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  col  text := TG_ARGV[0];
  win  interval := TG_ARGV[1]::interval;
  most int := TG_ARGV[2]::int;
  who  uuid;
  n    int;
begin
  if auth.uid() is null or public.is_staff() then return new; end if;
  execute format('select ($1).%I', col) using new into who;
  if who is distinct from auth.uid() then return new; end if;
  execute format('select count(*) from public.%I where %I = $1 and created_at > now() - $2', TG_TABLE_NAME, col)
    using who, win into n;
  if n >= most then
    raise exception 'slow down: too many in a short time' using errcode = '54000';
  end if;
  return new;
end;
$$;

do $$
declare
  r record;
begin
  for r in select * from (values
    ('friendships',    'requester_id', '1 day',  '40'),
    ('comments',       'author_id',    '1 hour', '30'),
    ('room_posts',     'user_id',      '1 hour', '60'),
    ('group_messages', 'user_id',      '1 hour', '120'),
    ('groups',         'created_by',   '1 day',  '10'),
    ('sparks',         'host_id',      '1 day',  '10'),
    ('group_invites',  'created_by',   '1 day',  '20')
  ) v(tbl, col, win, most)
  loop
    if to_regclass('public.' || r.tbl) is null then continue; end if;
    if not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = r.tbl and column_name in (r.col))
       or not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = r.tbl and column_name = 'created_at') then
      continue;
    end if;
    execute format('drop trigger if exists guard_rate on public.%I', r.tbl);
    execute format('create trigger guard_rate before insert on public.%I for each row execute function public.guard_rate(%L, %L, %L)',
                   r.tbl, r.col, r.win, r.most);
  end loop;
end $$;

-- ------------------------------------------------------------ groups and blocks

create or replace function public.guard_group_blocks()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.group_members m join public.blocks b
               on (b.blocker_id = m.user_id and b.blocked_id = new.user_id)
               or (b.blocker_id = new.user_id and b.blocked_id = m.user_id)
             where m.group_id = new.group_id) then
    raise exception 'not possible in this group' using errcode = '42501';
  end if;
  return new;
end;
$$;
do $$ begin
  if to_regclass('public.blocks') is not null then
    drop trigger if exists guard_group_blocks on public.group_members;
    create trigger guard_group_blocks before insert on public.group_members
      for each row execute function public.guard_group_blocks();
  end if;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('53_trust.sql', '7ca0c1158caa08eb1d7cedbee17494dd4ef718ff69080160e0af324f71bea7ae');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('53_trust.sql');
  end if;
end $$;
