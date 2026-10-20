-- afterhours — people profiles
-- In 01 a profile was only "who you are + are you an admin". The real
-- profile, the one that appears after signing up, is defined here.
--
-- Split in two, because the two are not the same thing:
--
--   profiles           the PUBLIC card — handle, name, one line, city.
--                      This is what a friend and a stranger both see.
--   profile_settings   YOURS ALONE — who may see what, whether we may
--                      email you. Not even an admin can read it.
--
-- Without the split, the "everyone reads" rule on profiles would have

-- ------------------------------------------------------- the public card

alter table public.profiles
  add column if not exists bio          text,
  add column if not exists city_id      uuid references public.cities on delete set null,
  -- Registration is not finished yet: the account opens, and choosing a
  -- handle is what finishes it.
  add column if not exists onboarded_at timestamptz,
  add column if not exists last_seen_at timestamptz;

alter table public.profiles
  drop constraint if exists profiles_bio_uzunluk;
alter table public.profiles
  drop constraint if exists profiles_bio_length;
alter table public.profiles
  add constraint profiles_bio_length
  check (bio is null or length(btrim(bio)) between 1 and 160);

alter table public.profiles
  drop constraint if exists profiles_ad_uzunluk;
alter table public.profiles
  drop constraint if exists profiles_name_length;
alter table public.profiles
  add constraint profiles_name_length
  check (display_name is null or length(btrim(display_name)) between 1 and 40);

create index if not exists profiles_city_idx on public.profiles (city_id);

-- ------------------------------------------------------ per-person settings

create table if not exists public.profile_settings (
  user_id         uuid primary key references public.profiles on delete cascade,
  -- Who may see what you kept: confirmed friends, or nobody.
  -- What you threw left is shown under no setting at all.
  kept_visibility text not null default 'friends'
                  check (kept_visibility in ('friends', 'private')),
  -- Whether a stranger who knows your handle sees your card. Turn it off
  -- and the card is hidden; but someone who knows the handle can still
  -- send a request, or nobody could ever add you.
  discoverable    boolean not null default true,
  -- For friend requests, the odd reminder about a night, that sort of thing.
  notify_email    boolean not null default true,
  locale          text not null default 'en' check (locale in ('en', 'de', 'tr')),
  updated_at      timestamptz not null default now()
);

alter table public.profile_settings enable row level security;

-- Yours alone. Nobody, admin included, can read another person row.
drop policy if exists settings_read_own on public.profile_settings;
create policy settings_read_own on public.profile_settings for select
  using (user_id = auth.uid());

drop policy if exists settings_write_own on public.profile_settings;
create policy settings_write_own on public.profile_settings for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists settings_insert_own on public.profile_settings;
create policy settings_insert_own on public.profile_settings for insert
  with check (user_id = auth.uid());

drop trigger if exists settings_touch on public.profile_settings;
create trigger settings_touch
  before update on public.profile_settings
  for each row execute function public.touch_updated_at();

-- ------------------------------- signing up: the profile appears by itself

-- This replaces the trigger from 01. Two differences:
--   · the settings row is opened too (without it nobody sees their settings)
--   · if the register form sent a handle/city they are tried; a taken
--     handle is quietly left empty and picked later
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  wanted text := lower(btrim(coalesce(new.raw_user_meta_data ->> 'handle', '')));
  city_slug_in   text := lower(btrim(coalesce(new.raw_user_meta_data ->> 'city', '')));
  city_uuid uuid;
begin
  if wanted !~ '^[a-z0-9_]{3,20}$'
     or exists (select 1 from public.profiles where handle = wanted) then
    wanted := null;
  end if;

  if city_slug_in <> '' then
    select id into city_uuid from public.cities where slug = city_slug_in;
  end if;

  insert into public.profiles (id, display_name, handle, city_id, onboarded_at)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    wanted,
    city_uuid,
    case when wanted is null then null else now() end
  )
  on conflict (id) do nothing;

  insert into public.profile_settings (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Accounts opened earlier have no settings row; fill them in once.
insert into public.profile_settings (user_id)
select p.id from public.profiles p
left join public.profile_settings s on s.user_id = p.id
where s.user_id is null;

-- ------------------------------------------------ is the handle available

-- The register form asks on every keystroke. The returned values are not
-- shown as they are; the page writes its own sentence.
--   ok · empty · format · taken · yours
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
    else 'ok'
  end;
$$;

-- ------------------------------------------ the step that finishes signup

-- The one thing that must happen after the account opens: a handle. The
-- rest is optional. It all goes in one request so no profile is left half done.
-- security definer, because the direct UPDATE grant on profiles is
-- limited to the four fields a person may edit (see the privileges at
-- the bottom); onboarded_at is stamped only through here.
create or replace function public.profile_setup(
  p_handle       text,
  p_display_name text default null,
  p_city_slug    text default null,
  p_bio          text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  handle_state    text := public.handle_status(p_handle);
  city_uuid uuid;
begin
  if auth.uid() is null then return 'signedout'; end if;
  if handle_state not in ('ok', 'yours') then return handle_state; end if;

  if coalesce(btrim(p_city_slug), '') <> '' then
    select id into city_uuid from public.cities where slug = lower(btrim(p_city_slug));
    if city_uuid is null then return 'nocity'; end if;
  end if;

  update public.profiles set
    handle       = lower(btrim(p_handle)),
    display_name = coalesce(nullif(btrim(p_display_name), ''), display_name),
    city_id      = coalesce(city_uuid, city_id),
    bio          = case when p_bio is null then bio
                        else nullif(btrim(p_bio), '') end,
    onboarded_at = coalesce(onboarded_at, now())
  where id = auth.uid();

  insert into public.profile_settings (user_id)
  values (auth.uid()) on conflict (user_id) do nothing;

  return 'ok';
end;
$$;

-- ------------------------------------------------------------ your profile

-- The one place the settings page and the account page read. The counts
-- are gathered here so the front end does not make three requests.
drop function if exists public.profile_me();
create or replace function public.profile_me()
returns table (
  id              uuid,
  handle          text,
  display_name    text,
  bio             text,
  city_slug       text,
  city_name       text,
  is_admin        boolean,
  onboarded       boolean,
  created_at      timestamptz,
  last_seen_at    timestamptz,
  kept_count      int,
  friend_count    int,
  comment_count   int,
  kept_visibility text,
  discoverable    boolean,
  notify_email    boolean,
  locale          text
)
language sql
stable
as $$
  select p.id, p.handle, p.display_name, p.bio,
         c.slug, c.name,
         p.is_admin, p.onboarded_at is not null,
         p.created_at, p.last_seen_at,
         (select count(*)::int from public.swipes s
           where s.user_id = p.id and s.direction = 'right'),
         (select count(*)::int from public.friendships f
           where f.status = 'accepted'
             and (f.requester_id = p.id or f.addressee_id = p.id)),
         (select count(*)::int from public.comments m
           where m.author_id = p.id and not m.is_hidden),
         coalesce(s.kept_visibility, 'friends'),
         coalesce(s.discoverable, true),
         coalesce(s.notify_email, true),
         coalesce(s.locale, 'en')
  from public.profiles p
  left join public.cities c on c.id = p.city_id
  left join public.profile_settings s on s.user_id = p.id
  where p.id = auth.uid();
$$;

-- ------------------------------------------------------------- privacy

-- In 02 the profile table was "everyone reads": somebody without an
-- an account could pull down the whole member list in one request. The
-- read directly are your own, your confirmed friends, and anyone with a
-- request pending between you. Everything a stranger sees goes through
-- the functions below; each hands back only the field it owes.

-- A friend, or a request pending — in either direction.
create or replace function public.is_linked(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.friendships f
    where (f.requester_id = auth.uid() and f.addressee_id = other)
       or (f.addressee_id = auth.uid() and f.requester_id = other)
  );
$$;

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select
  using (
    id = auth.uid()
    or public.is_linked(id)
    or public.is_admin()
  );

-- Identity by handle. The rule now stops a stranger, so the lookup goes
-- through here; the only thing that leaks is whether such a person exists.
create or replace function public.handle_to_id(p_handle text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.profiles where handle = lower(btrim(p_handle));
$$;

-- Discoverability from the settings. You always see yourself and a friend.
create or replace function public.card_visible(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select other = auth.uid()
      or public.is_friend(other)
      or coalesce((select s.discoverable from public.profile_settings s
                   where s.user_id = other), true);
$$;

-- The name under a comment. comments_public no longer touches the profile
-- table any more: a signed-out reader should still see who wrote it.
create or replace function public.author_name(p_author uuid, p_fallback text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select coalesce(p.handle, p.display_name) from public.profiles p where p.id = p_author),
    p_fallback);
$$;

-- To read the setting for another person: only the owner can see
-- profile_settings, so this function steps around RLS. The only thing that
-- leaks is the yes or no of "is it visible".
create or replace function public.kept_visible(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select s.kept_visibility from public.profile_settings s
                   where s.user_id = other), 'friends') = 'friends';
$$;


-- --------------------------------------------- the profile of another

-- The card a stranger sees. Even the NUMBER of things you kept is only
-- to friends, and only when the setting allows it.
drop function if exists public.profile_card(text);
create or replace function public.profile_card(p_handle text)
returns table (
  handle        text,
  display_name  text,
  bio           text,
  city_name     text,
  created_at    timestamptz,
  last_seen_day date,
  is_friend     boolean,
  kept_count    int
)
language sql
stable
security definer
set search_path = public
as $$
  select p.handle, p.display_name, p.bio, c.name, p.created_at,
         -- Last seen goes to friends only, and only as a DAY. The hour and minute
         -- reach nobody: who is awake when should not be worked out from this.
         case when p.id = auth.uid() or public.is_friend(p.id)
              then p.last_seen_at::date end,
         public.is_friend(p.id),
         case
           when p.id = auth.uid()
             or (public.is_friend(p.id) and public.kept_visible(p.id))
           then (select count(*)::int from public.swipes w
                  where w.user_id = p.id and w.direction = 'right')
         end
  from public.profiles p
  left join public.cities c on c.id = p.city_id
  where p.handle = lower(btrim(p_handle))
    and public.card_visible(p.id);
$$;

-- ---------------------------------------------------------------- seen

-- For the "already on the app" list in friends&more. A person stamps
-- their own row only: the update is pinned to auth.uid(). Definer,
-- because last_seen_at is not in the direct UPDATE grant — the stamp
-- goes through here or not at all.
create or replace function public.seen()
returns void
language sql
volatile
security definer
set search_path = public
as $$
  update public.profiles set last_seen_at = now() where id = auth.uid();
$$;

-- ------------------------------- what you kept: a rule that obeys the setting

-- The rule in 02 said "a confirmed friend sees the RIGHT swipes". A
-- setting was added: say private and a friend cannot see them either. We
-- rewrite the rule here — run 02 on its own and the old one still applies.
drop policy if exists swipes_read on public.swipes;
create policy swipes_read on public.swipes for select
  using (
    user_id = auth.uid()
    or (direction = 'right'
        and public.is_friend(user_id)
        and public.kept_visible(user_id))
  );

-- ------------------------------ two older definitions the rule broke

-- comments_public used to join the profile table; once that rule closed,
-- table; a signed-out reader was getting an empty author. A definer
-- function hands back the name and the view never reaches for profiles.
create or replace view public.comments_public
with (security_invoker = true) as
select
  c.id,
  c.event_id,
  c.parent_id,
  c.body,
  c.time_text,
  c.created_at,
  public.author_name(c.author_id, c.author_name) as author,
  c.author_id is not null as is_real
from public.comments c
where not c.is_hidden;

-- friend_request looked identity up by handle; that lookup goes through
-- a definer helper. The function itself is NOT definer: it still writes
-- the friendship row with the rights of whoever called it.
create or replace function public.friend_request(p_handle text)
returns text
language plpgsql
as $$
declare
  target uuid;
begin
  target := public.handle_to_id(p_handle);

  if target is null then
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

-- ------------------------------------------------- deleting the account

-- The last button on the settings page. Deleting really deletes: the
-- account, profile, settings, swipes and friendships all cascade away.
--
-- Comments are the EXCEPTION, for two reasons: (1) comments.author_id is
-- "on delete set
-- null" and author_name cannot be empty - deleting without touching it
-- (2) deleting a topic would take the replies of OTHER PEOPLE with it.
-- So the text stays and the name goes: the comment becomes "someone".
-- The settings page says so before you press it.
create or replace function public.delete_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in first';
  end if;

  update public.comments
     set author_id = null, author_name = 'someone'
   where author_id = auth.uid();

  delete from auth.users where id = auth.uid();
end;
$$;

-- ----------------------------------------------------------- privileges

-- Supabase does not grant on a new table by itself; by hand, as in 02.
grant select, insert, update on public.profile_settings to authenticated;

-- The direct UPDATE on profiles covers exactly the four fields a person
-- edits about themselves. created_at, last_seen_at and onboarded_at are
-- the record’s own truth — writable only through seen() and
-- profile_setup(), which are definer and set them honestly. The old
-- table-wide grant from 02 is taken back first (grants pile up).
revoke update on public.profiles from authenticated;
grant update (handle, display_name, bio, city_id) on public.profiles to authenticated;

grant execute on function public.handle_status(text)                   to anon, authenticated;
grant execute on function public.profile_card(text)                    to anon, authenticated;
grant execute on function public.is_linked(uuid)                       to anon, authenticated;
grant execute on function public.kept_visible(uuid)                    to authenticated;
grant execute on function public.handle_to_id(text)                    to authenticated;
grant execute on function public.author_name(uuid, text)               to anon, authenticated;

-- The uuid→fact helpers exist for the rules and views that call them,
-- not as a public API — each one is a small oracle on somebody’s data.
-- Two have to stay callable by the browser roles: is_linked runs inside
-- the profiles read rule, author_name inside comments_public (both are
-- invoker, so the caller needs EXECUTE). The rest close: kept_visible
-- only serves the swipes rule (authenticated), handle_to_id only
-- friend_request (authenticated), and card_visible only profile_card,
-- which is definer and needs no grant at all.
revoke execute on function public.card_visible(uuid) from public, anon, authenticated;
revoke execute on function public.kept_visible(uuid) from public, anon;
revoke execute on function public.handle_to_id(text) from public, anon;
grant execute on function public.profile_setup(text, text, text, text) to authenticated;
grant execute on function public.profile_me()                          to authenticated;
grant execute on function public.seen()                                to authenticated;
grant execute on function public.delete_account()                      to authenticated;

-- Stamp the migration log, if it is there. Each numbered file still runs on
-- its own (the tests load them one at a time), so this cannot insist.
do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('12_profiles.sql', '52f6bf13db94ca027ad9b623bb532d4e4d5956db572c73382787ace80b4cf1b0');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('12_profiles.sql');
  end if;
end $$;
