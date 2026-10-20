-- ============================================================
--  afterhours — SETUP 1 / 2 : THE STRUCTURE
--  VERSION: 2026-10-20 16:49   ← if the editor shows this line, it is the right copy
--
--  In the Supabase panel: SQL Editor → New query → paste this file
--  IN FULL → Run.
--
--  When it finishes you should see "Success. No rows returned".
--  Then run setup-2-comments.sql the same way.
--
--  GENERATED FILE — source: backend/tools/build-setup.mjs
-- ============================================================


-- ============================================================
--  THE MIGRATION LOG — which files have been run   (00_migrations.sql)
-- ============================================================

-- afterhours — which of these files has actually been run
-- The setup is pasted into the Supabase editor by hand, so a project can
-- easily be a file or two behind without anything looking wrong: a page
-- just answers PGRST202 because the function it wants was never created.
-- This table is the record. Every numbered file stamps its own name at
-- the end, so the answer to "what is live" stops being a memory.
--
-- It has to come first. Everything after it writes into it.

create table if not exists public.migrations (
  name        text primary key,
  applied_at  timestamptz not null default now()
);

alter table public.migrations enable row level security;

-- RLS is on with no policy yet, so the table is closed to every browser
-- until 02_rls.sql opens it to the admin. is_admin() does not exist this
-- early, which is why the policy lives there and not here. Nothing writes
-- to this table from a browser in any case: the stamps come from the SQL
-- editor, which is above RLS.

-- The list itself is only filenames and dates, so the health check may
-- read it with the public key. Nothing about the content leaks through it.
-- create or replace is not enough when the return type changes; drop first.
drop function if exists public.migrations_applied();
create or replace function public.migrations_applied()
returns table (name text, applied_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select m.name, m.applied_at from public.migrations m order by m.name;
$$;

grant execute on function public.migrations_applied() to anon, authenticated;

-- Used by every file below to stamp itself.
create or replace function public.migration_done(p_name text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.migrations (name) values (p_name)
  on conflict (name) do update set applied_at = now();
$$;

-- The stamps come from the SQL editor, which runs as the table owner.
-- Postgres hands EXECUTE on a new function to everyone by default, and
-- through the API that would let any visitor forge the log — including
-- stamping a file as applied that never ran, which is exactly the lie
-- the health check exists to catch.
revoke execute on function public.migration_done(text) from public, anon, authenticated;

select public.migration_done('00_migrations.sql');


-- ============================================================
--  TABLES   (01_schema.sql)
-- ============================================================

-- afterhours — the tables
-- Run them in order in the Supabase SQL editor: 01 → 02 → 03 → ...
-- Authentication comes from the auth schema Supabase provides; what is
-- here is only the public schema that hangs off it.

-- gen_random_uuid() has been core since Postgres 13; no extension needed.

-- The two ordering columns were called `sira` before the code moved to
-- English. On a fresh database this does nothing; on one that already
-- exists it renames them, so the rest of this file lines up either way.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'cities'
               and column_name = 'sira') then
    alter table public.cities rename column sira to sort_order;
  end if;
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'event_types'
               and column_name = 'sira') then
    alter table public.event_types rename column sira to sort_order;
  end if;
end
$$;

-- ---------------------------------------------------------------- city

create table if not exists public.cities (
  id      uuid primary key default gen_random_uuid(),
  slug    text unique not null,
  name    text not null,
  -- the honest city list on the landing page: live / soon / planned
  status  text not null default 'live' check (status in ('live', 'soon', 'planned')),
  sort_order    int  not null default 0,
  -- The filter picks a country first, then the cities in that country;
  -- and the countries themselves are grouped by continent
  country         text,
  country_slug    text,
  continent       text,
  continent_slug  text
);

create index if not exists cities_country_idx on public.cities (country_slug, sort_order);

-- ----------------------------------------------------------------- kind

create table if not exists public.event_types (
  id    uuid primary key default gen_random_uuid(),
  slug  text unique not null,
  name  text not null,
  -- the order from the spec itself: rave, club night, konzert, festival, meetup, hausparty
  sort_order  int  not null
);

-- ---------------------------------------------------------------- venue

create table if not exists public.venues (
  id          uuid primary key default gen_random_uuid(),
  city_id     uuid not null references public.cities on delete restrict,
  slug        text not null,
  name        text not null,
  -- for the globe and the map; the "rooms open" counter uses the hours
  map_x       int,
  map_y       int,
  opens_hour  numeric(4,1),
  open_hours  numeric(4,1),
  unique (city_id, slug)
);

-- ---------------------------------------------------------------- event

create table if not exists public.events (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,
  city_id       uuid not null references public.cities on delete restrict,
  type_id       uuid not null references public.event_types on delete restrict,
  venue_id      uuid references public.venues on delete set null,

  title         text not null,
  -- the line shown on screen word for word. This is the source; do not break it.
  meta          text not null,
  body          text not null default '',

  poster_no     int check (poster_no > 0),
  -- when set, the file in storage; when empty, posters/NN.svg is used
  poster_path   text,

  -- The data holds non-dates like "Sommer 2027", "Mittwochs" and "TBA",
  -- so this can be empty. meta is always right.
  starts_at     timestamptz,
  date_text     text,
  -- Most dates in the data carry no year ("05.09"). The year was filled in
  -- by inference; this flag means "not verified". It shows as a warning in
  -- the admin panel. Since meta is always right, the screen is unaffected.
  starts_at_estimated boolean not null default false,

  is_published  boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists events_city_idx    on public.events (city_id);
create index if not exists events_type_idx    on public.events (type_id);
create index if not exists events_starts_idx  on public.events (starts_at);
create index if not exists events_published_idx on public.events (is_published);

-- ---------------------------------------------------------------- people

-- auth.users stays private (the email lives there); this is the public part.
create table if not exists public.profiles (
  id            uuid primary key references auth.users on delete cascade,
  handle        text unique,
  display_name  text,
  -- the right to write events comes from here. True for owner only.
  is_admin      boolean not null default false,
  created_at    timestamptz not null default now()
);

-- --------------------------------------------------------------- swipes

-- Kept cards are not a separate table: they are the swipes going right.
create table if not exists public.swipes (
  id          uuid primary key default gen_random_uuid(),
  -- Defaults to the person in the session: the browser never sends
  -- never sends it, so it cannot be faked.
  user_id     uuid not null default auth.uid() references public.profiles on delete cascade,
  event_id    uuid not null references public.events on delete cascade,
  direction   text not null check (direction in ('left', 'right')),
  created_at  timestamptz not null default now(),
  unique (user_id, event_id)
);

create index if not exists swipes_event_idx on public.swipes (event_id);
create index if not exists swipes_user_dir_idx on public.swipes (user_id, direction);

-- ----------------------------------------------------------- beforehours

-- One table, two levels: empty parent_id means a topic, a set one a reply.
create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events on delete cascade,
  parent_id   uuid references public.comments on delete cascade,
  author_id   uuid default auth.uid() references public.profiles on delete set null,
  -- for the sample comments that have no real user behind them
  author_name text,
  body        text not null check (length(btrim(body)) > 0),
  is_hidden   boolean not null default false,
  created_at  timestamptz not null default now(),
  -- The time text shown for sample comments ("4 days ago", "Nov 2023").
  -- Empty on real comments; then it is worked out from created_at.
  time_text   text,
  constraint comments_author_var check (author_id is not null or author_name is not null)
);

-- The inline check above only says "not empty"; a ceiling matters just as
-- much, or one signed-in account can store megabytes per row. Named and
-- added separately so a database built before this line gets it too.
alter table public.comments
  drop constraint if exists comments_body_length;
alter table public.comments
  add constraint comments_body_length
  check (length(btrim(body)) between 1 and 2000);

create index if not exists comments_event_idx on public.comments (event_id, created_at);
create index if not exists comments_parent_idx on public.comments (parent_id);

-- There is no third level (the screen shows two) and a reply has to
-- belong to the same event as its topic.
-- security definer, because the SELECT below otherwise runs under the
-- caller’s read rule: a HIDDEN parent came back as no row at all, both
-- checks passed on NULL, and a reply could land on a hidden reply (a
-- third level) or carry the wrong event. The check has to see every
-- parent to mean anything.
create or replace function public.comments_check_depth()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent public.comments%rowtype;
begin
  if new.parent_id is null then
    return new;
  end if;

  select * into parent from public.comments where id = new.parent_id;

  if parent.parent_id is not null then
    raise exception 'a reply cannot be replied to (two levels only)';
  end if;

  if parent.event_id <> new.event_id then
    raise exception 'a reply must belong to the same event as its topic';
  end if;

  return new;
end;
$$;

drop trigger if exists comments_depth on public.comments;
create trigger comments_depth
  before insert or update on public.comments
  for each row execute function public.comments_check_depth();

-- ------------------------------------------------------------ friendship

create table if not exists public.friendships (
  requester_id  uuid not null default auth.uid() references public.profiles on delete cascade,
  addressee_id  uuid not null references public.profiles on delete cascade,
  status        text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at    timestamptz not null default now(),
  primary key (requester_id, addressee_id),
  constraint friendship_not_self check (requester_id <> addressee_id)
);

create index if not exists friendships_addressee_idx on public.friendships (addressee_id, status);

-- --------------------------------------------------------- updated_at

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists events_touch on public.events;
create trigger events_touch
  before update on public.events
  for each row execute function public.touch_updated_at();

-- ------------------------------- an automatic profile for a new user

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Stamp the migration log, if it is there. Each numbered file still runs on
-- its own (the tests load them one at a time), so this cannot insist.
do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('01_schema.sql', '6db5fb87381f3f6e526baafd27fe26de66e3c7cf07ab6f70b39c5c4df30c4aaf');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('01_schema.sql');
  end if;
end $$;


-- ============================================================
--  RULES — the security lives here   (02_rls.sql)
-- ============================================================

-- afterhours — who may read what, and who may write it
-- This file IS the security. Hiding a page is not security; the rule is here.

-- ------------------------------------------------------------- helpers

-- profiles has RLS on it; reading profiles from inside a policy loops for
-- ever. Hence security definer: the function steps around RLS.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

create or replace function public.is_friend(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester_id = auth.uid() and f.addressee_id = other)
        or (f.addressee_id = auth.uid() and f.requester_id = other))
  );
$$;

-- Nobody may make themselves an admin.
create or replace function public.guard_is_admin()
returns trigger
language plpgsql
as $$
begin
  -- An empty auth.uid() means the request came from the service role or the
  -- SQL editor; that is where the first admin is appointed. Anonymous never
  -- gets this far, because profiles_update_own already stops it.
  if new.is_admin is distinct from old.is_admin
     and auth.uid() is not null
     and not public.is_admin() then
    raise exception 'is_admin can only be changed by an admin';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_admin on public.profiles;
create trigger profiles_guard_admin
  before update on public.profiles
  for each row execute function public.guard_is_admin();

-- ------------------------------------------------------------------ RLS

alter table public.cities       enable row level security;
alter table public.event_types  enable row level security;
alter table public.venues       enable row level security;
alter table public.events       enable row level security;
alter table public.profiles     enable row level security;
alter table public.swipes       enable row level security;
alter table public.comments     enable row level security;
alter table public.friendships  enable row level security;

-- ------------------------------- the catalogue: everyone reads, the admin writes

drop policy if exists cities_read on public.cities;
create policy cities_read on public.cities for select using (true);
drop policy if exists cities_write on public.cities;
create policy cities_write on public.cities for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists types_read on public.event_types;
create policy types_read on public.event_types for select using (true);
drop policy if exists types_write on public.event_types;
create policy types_write on public.event_types for all
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists venues_read on public.venues;
create policy venues_read on public.venues for select using (true);
drop policy if exists venues_write on public.venues;
create policy venues_write on public.venues for all
  using (public.is_admin()) with check (public.is_admin());

-- ---------------------------------------------------------------- event

-- You can look around without signing in: published events are public.
drop policy if exists events_read on public.events;
create policy events_read on public.events for select
  using (is_published or public.is_admin());

drop policy if exists events_write on public.events;
create policy events_write on public.events for all
  using (public.is_admin()) with check (public.is_admin());

-- --------------------------------------------------------------- profile

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select using (true);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

-- ---------------------------------------------------------------- swipe

-- Your own swipes + what your confirmed friends swiped RIGHT.
-- What a friend swiped left concerns nobody but them.
drop policy if exists swipes_read on public.swipes;
create policy swipes_read on public.swipes for select
  using (
    user_id = auth.uid()
    or (direction = 'right' and public.is_friend(user_id))
  );

drop policy if exists swipes_insert_own on public.swipes;
create policy swipes_insert_own on public.swipes for insert
  with check (user_id = auth.uid());

drop policy if exists swipes_update_own on public.swipes;
create policy swipes_update_own on public.swipes for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists swipes_delete_own on public.swipes;
create policy swipes_delete_own on public.swipes for delete
  using (user_id = auth.uid());

-- ------------------------------------------------------------ beforehours

drop policy if exists comments_read on public.comments;
create policy comments_read on public.comments for select
  using (not is_hidden or public.is_admin());

-- Writing needs an account, and nobody can write as somebody else.
drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments for insert
  with check (author_id = auth.uid());

drop policy if exists comments_update on public.comments;
create policy comments_update on public.comments for update
  using (author_id = auth.uid() or public.is_admin())
  with check (author_id = auth.uid() or public.is_admin());

drop policy if exists comments_delete on public.comments;
create policy comments_delete on public.comments for delete
  using (author_id = auth.uid() or public.is_admin());

-- Hiding a comment is moderation, and moderation has to stick: the
-- update rule above lets an author edit their own row, and without this
-- guard that included quietly writing is_hidden back to false.
create or replace function public.guard_comment_hidden()
returns trigger
language plpgsql
as $$
begin
  -- An empty auth.uid() is the service role or the SQL editor, same as
  -- in guard_is_admin above.
  if new.is_hidden is distinct from old.is_hidden
     and auth.uid() is not null
     and not public.is_admin() then
    raise exception 'is_hidden can only be changed by an admin';
  end if;
  return new;
end;
$$;

drop trigger if exists comments_guard_hidden on public.comments;
create trigger comments_guard_hidden
  before update on public.comments
  for each row execute function public.guard_comment_hidden();

-- ------------------------------------------------------------ friendship

drop policy if exists friendships_read on public.friendships;
create policy friendships_read on public.friendships for select
  using (requester_id = auth.uid() or addressee_id = auth.uid());

-- A request is born pending. Without the status check here, a row could
-- be INSERTED as ’accepted’ and skip the other side’s consent entirely.
drop policy if exists friendships_insert on public.friendships;
create policy friendships_insert on public.friendships for insert
  with check (requester_id = auth.uid() and status = 'pending');

-- Only the side that RECEIVED the request may change it: that is what
-- accepting is. The requester’s tools are insert and delete — with
-- update too, a requester could flip their own request to ’accepted’
-- and walk into everything a friend may see.
drop policy if exists friendships_update on public.friendships;
create policy friendships_update on public.friendships for update
  using (addressee_id = auth.uid())
  with check (addressee_id = auth.uid());

drop policy if exists friendships_delete on public.friendships;
create policy friendships_delete on public.friendships for delete
  using (requester_id = auth.uid() or addressee_id = auth.uid());

-- ------------------------------------------------------- the migration log

-- Only the admin reads the table itself. The public list goes through
-- migrations_applied(), which is security definer and returns nothing but
-- filenames and dates (00_migrations.sql).
-- Guarded the same way as the stamps: 02 has to run on its own too (the
-- test suites load it without 00).
do $$ begin
  if to_regclass('public.migrations') is not null then
    execute 'drop policy if exists migrations_read_admin on public.migrations';
    execute 'create policy migrations_read_admin on public.migrations
               for select using (public.is_admin())';
  end if;
end $$;


-- ------------------------------------------------------------ privileges

grant usage on schema public to anon, authenticated;

grant select on public.cities, public.event_types, public.venues,
                public.events, public.profiles, public.comments to anon, authenticated;

grant insert, update, delete on public.swipes to authenticated;
grant select on public.swipes, public.friendships to authenticated;

-- Comments and friendships accept writes only on the columns the site
-- actually sends. The others either default (author_id, created_at,
-- status) or belong to the seed and the tools, which run as the table
-- owner and are not bound by these grants. Grants pile up, so the old
-- broad ones are taken back first — a database that ran the previous
-- version of this file keeps them otherwise.
revoke insert, update on public.comments from authenticated;
grant delete                                  on public.comments to authenticated;
grant insert (event_id, parent_id, author_id, body) on public.comments to authenticated;
grant update (body, is_hidden)                on public.comments to authenticated;

revoke insert, update on public.friendships from authenticated;
grant delete                                  on public.friendships to authenticated;
grant insert (requester_id, addressee_id)     on public.friendships to authenticated;
grant update (status)                         on public.friendships to authenticated;
grant update on public.profiles to authenticated;
grant insert, update, delete on public.cities, public.event_types,
                                 public.venues, public.events to authenticated;

-- Stamp the migration log, if it is there. Each numbered file still runs on
-- its own (the tests load them one at a time), so this cannot insist.
do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('02_rls.sql', '7a25fb9614f16ecda40d256ac2e47118f2eb534d11d689bcf286d1d32325c0ee');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('02_rls.sql');
  end if;
end $$;


-- ============================================================
--  CITIES, TYPES, VENUES   (03_seed_catalog.sql)
-- ============================================================

-- GENERATED FILE - do not edit by hand. Source: backend/tools/build-seed.mjs
-- Cities, types and venues. This first, then 04.

insert into public.cities (slug, name, status, sort_order, country, country_slug) values
  ('munchen', 'münchen', 'live', 1, 'Deutschland', 'de'),
  ('istanbul', 'istanbul', 'live', 2, 'Türkiye', 'tr'),
  ('ankara', 'ankara', 'soon', 3, 'Türkiye', 'tr'),
  ('berlin', 'berlin', 'planned', 4, 'Deutschland', 'de'),
  ('wien', 'wien', 'planned', 5, 'Österreich', 'at'),
  ('koln', 'köln', 'planned', 6, 'Deutschland', 'de'),
  ('hamburg', 'hamburg', 'planned', 7, 'Deutschland', 'de'),
  ('frankfurt', 'frankfurt', 'planned', 8, 'Deutschland', 'de'),
  ('leipzig', 'leipzig', 'planned', 9, 'Deutschland', 'de'),
  ('izmir', 'izmir', 'planned', 10, 'Türkiye', 'tr'),
  ('graz', 'graz', 'planned', 11, 'Österreich', 'at')
on conflict (slug) do nothing;

insert into public.event_types (slug, name, sort_order) values
  ('rave', 'Rave', 1),
  ('club-night', 'Club Night', 2),
  ('konzert', 'Konzert', 3),
  ('festival', 'Festival', 4),
  ('meetup', 'Meetup', 5),
  ('hausparty', 'Hausparty', 6)
on conflict (slug) do nothing;

insert into public.venues (city_id, slug, name, map_x, map_y, opens_hour, open_hours)
select id, 'olympiahalle', 'OLYMPIAHALLE', 512, 236, 18.5, 4
from public.cities where slug = 'munchen'
on conflict (city_id, slug) do nothing;
insert into public.venues (city_id, slug, name, map_x, map_y, opens_hour, open_hours)
select id, 'olympiapark', 'OLYMPIAPARK', 556, 288, 19.5, 4
from public.cities where slug = 'munchen'
on conflict (city_id, slug) do nothing;
insert into public.venues (city_id, slug, name, map_x, map_y, opens_hour, open_hours)
select id, 'zenith', 'ZENITH', 946, 196, 25, 5
from public.cities where slug = 'munchen'
on conflict (city_id, slug) do nothing;
insert into public.venues (city_id, slug, name, map_x, map_y, opens_hour, open_hours)
select id, 'tonhalle', 'TONHALLE', 902, 236, 22, 6
from public.cities where slug = 'munchen'
on conflict (city_id, slug) do nothing;
insert into public.venues (city_id, slug, name, map_x, map_y, opens_hour, open_hours)
select id, 'schwabing', 'SCHWABING', 760, 300, 21, 4
from public.cities where slug = 'munchen'
on conflict (city_id, slug) do nothing;
insert into public.venues (city_id, slug, name, map_x, map_y, opens_hour, open_hours)
select id, 'maxvorstadt', 'MAXVORSTADT', 664, 396, 22.2, 8
from public.cities where slug = 'munchen'
on conflict (city_id, slug) do nothing;
insert into public.venues (city_id, slug, name, map_x, map_y, opens_hour, open_hours)
select id, 'neuhausen', 'NEUHAUSEN', 556, 430, 21.5, 5
from public.cities where slug = 'munchen'
on conflict (city_id, slug) do nothing;
insert into public.venues (city_id, slug, name, map_x, map_y, opens_hour, open_hours)
select id, 'p1', 'P1', 792, 404, 23, 6
from public.cities where slug = 'munchen'
on conflict (city_id, slug) do nothing;
insert into public.venues (city_id, slug, name, map_x, map_y, opens_hour, open_hours)
select id, 'pimpernel', 'PIMPERNEL', 748, 444, 22, 6
from public.cities where slug = 'munchen'
on conflict (city_id, slug) do nothing;
insert into public.venues (city_id, slug, name, map_x, map_y, opens_hour, open_hours)
select id, 'museumsinsel-1', 'MUSEUMSINSEL 1', 828, 478, 24, 7
from public.cities where slug = 'munchen'
on conflict (city_id, slug) do nothing;
insert into public.venues (city_id, slug, name, map_x, map_y, opens_hour, open_hours)
select id, 'haidhausen', 'HAIDHAUSEN', 892, 494, 20, 4
from public.cities where slug = 'munchen'
on conflict (city_id, slug) do nothing;
insert into public.venues (city_id, slug, name, map_x, map_y, opens_hour, open_hours)
select id, 'westend', 'WESTEND', 596, 552, 19, 3
from public.cities where slug = 'munchen'
on conflict (city_id, slug) do nothing;
insert into public.venues (city_id, slug, name, map_x, map_y, opens_hour, open_hours)
select id, 'milla', 'MILLA', 726, 556, 22, 5
from public.cities where slug = 'munchen'
on conflict (city_id, slug) do nothing;
insert into public.venues (city_id, slug, name, map_x, map_y, opens_hour, open_hours)
select id, 'glockenbach', 'GLOCKENBACH', 764, 578, 19, 4
from public.cities where slug = 'munchen'
on conflict (city_id, slug) do nothing;
insert into public.venues (city_id, slug, name, map_x, map_y, opens_hour, open_hours)
select id, 'schlachthof', 'SCHLACHTHOF', 704, 614, 18, 4
from public.cities where slug = 'munchen'
on conflict (city_id, slug) do nothing;
insert into public.venues (city_id, slug, name, map_x, map_y, opens_hour, open_hours)
select id, 'bahnwarter-thiel', 'BAHNWÄRTER THIEL', 668, 662, 21.1, 6
from public.cities where slug = 'munchen'
on conflict (city_id, slug) do nothing;
insert into public.venues (city_id, slug, name, map_x, map_y, opens_hour, open_hours)
select id, 'sunny-red', 'SUNNY RED', 636, 690, 22.6, 6
from public.cities where slug = 'munchen'
on conflict (city_id, slug) do nothing;
insert into public.venues (city_id, slug, name, map_x, map_y, opens_hour, open_hours)
select id, 'alte-utting', 'ALTE UTTING', 700, 706, 18.5, 4
from public.cities where slug = 'munchen'
on conflict (city_id, slug) do nothing;
insert into public.venues (city_id, slug, name, map_x, map_y, opens_hour, open_hours)
select id, 'giesing', 'GIESING', 812, 682, 20, 4
from public.cities where slug = 'munchen'
on conflict (city_id, slug) do nothing;
insert into public.venues (city_id, slug, name, map_x, map_y, opens_hour, open_hours)
select id, 'riem', 'RIEM', 1128, 512, 20, 8
from public.cities where slug = 'munchen'
on conflict (city_id, slug) do nothing;

-- Stamp the migration log, if it is there (00_migrations.sql).
do $$ begin
  if to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('03_seed_catalog.sql');
  end if;
end $$;


-- ============================================================
--  36 EVENTS   (04_seed_events.sql)
-- ============================================================

-- GENERATED FILE - source: events-data.js (36 records)
-- The meta field is the very line shown on screen; it must not be changed.

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'asap-rocky', c.id, t.id, v.id,
       'A$AP Rocky', 'Olympiahalle · 11.09.26 · 18:30', 'An arena show built around one voice. Doors early, everyone seated until they aren''t.', 1,
       '2026-09-11T18:30:00+02:00'::timestamptz, false, '11.09.26 · 18:30'
from public.cities c
join public.event_types t on t.slug = 'konzert'
join public.venues v on v.city_id = c.id and v.slug = 'olympiahalle'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'nick-cave', c.id, t.id, v.id,
       'Nick Cave', 'Olympiapark · 23.08 · open air', 'The Bad Seeds outdoors, at dusk. Quiet enough that you hear the crowd breathing between songs.', 2,
       '2026-08-23T18:00:00.000Z'::timestamptz, true, '23.08 · open air'
from public.cities c
join public.event_types t on t.slug = 'konzert'
join public.venues v on v.city_id = c.id and v.slug = 'olympiapark'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'bonez-mc-raf-camora', c.id, t.id, v.id,
       'Bonez MC & RAF Camora', 'Olympiahalle · 21.12.26 · 20:00', 'Palmen aus Plastik, ten years on. A December hall show that behaves like a summer one.', 3,
       '2026-12-21T20:00:00+02:00'::timestamptz, false, '21.12.26 · 20:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
join public.venues v on v.city_id = c.id and v.slug = 'olympiahalle'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'thirty-seconds-to-mars', c.id, t.id, v.id,
       'Thirty Seconds to Mars', 'Olympiahalle · 12.04.27', 'Stadium rock at hall scale. Bring a voice you don''t mind losing.', 4,
       '2027-04-12T20:00:00+02:00'::timestamptz, false, '12.04.27'
from public.cities c
join public.event_types t on t.slug = 'konzert'
join public.venues v on v.city_id = c.id and v.slug = 'olympiahalle'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'annenmaykantereit', c.id, t.id, v.id,
       'AnnenMayKantereit', 'Olympiapark · 15—16.09', 'Two nights in a row, same park, different setlist. Sung back word for word either way.', 5,
       '2026-09-15T18:00:00.000Z'::timestamptz, true, '15—16.09'
from public.cities c
join public.event_types t on t.slug = 'konzert'
join public.venues v on v.city_id = c.id and v.slug = 'olympiapark'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'elysium', c.id, t.id, v.id,
       'Elysium', 'Maxvorstadt · 12.09.26', 'Three stages, one night, no camping. A festival that fits inside a single walk home.', 6,
       '2026-09-12T20:00:00+02:00'::timestamptz, false, '12.09.26'
from public.cities c
join public.event_types t on t.slug = 'festival'
join public.venues v on v.city_id = c.id and v.slug = 'maxvorstadt'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'tollwood', c.id, t.id, v.id,
       'Tollwood', 'Olympiapark · Sommer 2027', 'Three weeks of stages, kitchens and market stalls. Come for one act, stay for the field.', 7,
       null, false, 'Sommer 2027'
from public.cities c
join public.event_types t on t.slug = 'festival'
join public.venues v on v.city_id = c.id and v.slug = 'olympiapark'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'mondscheinexpress', c.id, t.id, v.id,
       'Mondscheinexpress', 'Bahnwärter Thiel · 19.11 — 23.12', 'The winter counterpart: a month of short, cold, close-up nights between the containers.', 8,
       '2026-12-11T18:00:00.000Z'::timestamptz, true, '19.11 — 23.12'
from public.cities c
join public.event_types t on t.slug = 'festival'
join public.venues v on v.city_id = c.id and v.slug = 'bahnwarter-thiel'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'isle-of-summer', c.id, t.id, v.id,
       'Isle of Summer', 'Galopprennbahn Riem · 2027 TBA', 'Open air on the old racecourse. Line-up lands in spring, tickets go before it does.', 9,
       null, false, '2027 TBA'
from public.cities c
join public.event_types t on t.slug = 'festival'
join public.venues v on v.city_id = c.id and v.slug = 'riem'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'zamanand', c.id, t.id, null,
       'Zamanand', 'München · 12.09 · 16:00', 'Starts in daylight and never quite admits it''s a festival. Local bills, no headliner hierarchy.', 10,
       '2026-09-12T14:00:00.000Z'::timestamptz, true, '12.09 · 16:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'blitz', c.id, t.id, v.id,
       'Blitz', 'Museumsinsel 1 · 23:59', 'CJ Bolland b2b The Advent, Polygonia after. Phones stay in pockets — the no-photo rule is the point.', 11,
       null, false, '23:59'
from public.cities c
join public.event_types t on t.slug = 'rave'
join public.venues v on v.city_id = c.id and v.slug = 'museumsinsel-1'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'rote-sonne-bahnwarter', c.id, t.id, null,
       'Rote Sonne × Bahnwärter', '29.08.26 · 12:00 — 06:00', 'Eighteen hours that start in the sun and end in a basement. One ticket, two places.', 12,
       '2026-08-29T12:00:00+02:00'::timestamptz, false, '12:00 — 06:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'silo-west', c.id, t.id, null,
       'Silo West', 'München · 05.09 · 14:00', 'Narciss, Bambounou, B4ME. A day rave that sends you home before the last train, in theory.', 13,
       '2026-09-05T12:00:00.000Z'::timestamptz, true, '05.09 · 14:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'cfu-open-air', c.id, t.id, v.id,
       'CFU Open Air', 'Bahnwärter Thiel · 18.07 · 14:00', 'Outside while it''s warm, inside when it isn''t. The same crowd moves between both all afternoon.', 14,
       '2027-07-18T12:00:00.000Z'::timestamptz, true, '18.07 · 14:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
join public.venues v on v.city_id = c.id and v.slug = 'bahnwarter-thiel'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'daytime-rave', c.id, t.id, null,
       'Daytime Rave', 'München · 24.10 · 17:00', 'Anna Reusch and Thomas Schumacher, finished by midnight. Built for people who like sleeping.', 15,
       '2026-10-24T15:00:00.000Z'::timestamptz, true, '24.10 · 17:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'echonomist', c.id, t.id, v.id,
       'Echonomist', 'Pimpernel · 25.09 · 22:00', 'Staged inside a former cinema — the screen stays up, the seats don''t. Sound follows the room.', 16,
       '2026-09-25T20:00:00.000Z'::timestamptz, true, '25.09 · 22:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
join public.venues v on v.city_id = c.id and v.slug = 'pimpernel'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select '10-years-blurred-vision', c.id, t.id, null,
       '10 Years Blurred Vision', 'München · 30.10 · 22:00', 'A decade of one collective, condensed into one night. Residents only, no guest slot.', 17,
       '2026-10-30T20:00:00.000Z'::timestamptz, true, '30.10 · 22:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'legal-blitz', c.id, t.id, null,
       'Legal × Blitz', '29.08 · Muallem', 'Two bookers sharing one floor. House early, techno late, the handover is the whole show.', 18,
       '2026-08-29T18:00:00.000Z'::timestamptz, true, 'Muallem'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'bahnwarter-techno-nacht', c.id, t.id, v.id,
       'Bahnwärter Techno-Nacht', 'Bahnwärter Thiel · 22:00', 'Moritz Minoa, Palastica, Sayuara. Stacked containers, low ceilings, nothing polished.', 19,
       null, false, '22:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
join public.venues v on v.city_id = c.id and v.slug = 'bahnwarter-thiel'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'unterwelt', c.id, t.id, v.id,
       'Unterwelt', 'Sunny Red · 02.10.26 · 22:00', 'Down one staircase at a time until the room stops getting bigger. Ends when it ends.', 20,
       '2026-10-02T22:00:00+02:00'::timestamptz, false, '02.10.26 · 22:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
join public.venues v on v.city_id = c.id and v.slug = 'sunny-red'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'kuchentisch', c.id, t.id, v.id,
       'Küchentisch', 'Schwabing · 14.11 · 21:00', 'Four rooms, one kitchen, and everyone ends up in the kitchen anyway. Bring something to share.', 21,
       '2026-11-14T19:00:00.000Z'::timestamptz, true, '14.11 · 21:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
join public.venues v on v.city_id = c.id and v.slug = 'schwabing'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select '3-stock-links', c.id, t.id, v.id,
       '3. Stock Links', 'Haidhausen · 05.07 · 20:00', 'Balcony party with string lights and a borrowed speaker. Quiet by two, that''s the deal with the neighbours.', 22,
       '2027-07-05T18:00:00.000Z'::timestamptz, true, '05.07 · 20:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
join public.venues v on v.city_id = c.id and v.slug = 'haidhausen'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'boxenturm', c.id, t.id, null,
       'Boxenturm', 'Sendling · 19.09 · 22:00', 'Someone stacked four cabinets in a backyard. The stack is the whole concept.', 23,
       '2026-09-19T20:00:00.000Z'::timestamptz, true, '19.09 · 22:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'klingel-14', c.id, t.id, v.id,
       'Klingel 14', 'Maxvorstadt · 28.11 · 22:00', 'No address posted — you get the doorbell number and a name. Ring the right one.', 24,
       '2026-11-28T20:00:00.000Z'::timestamptz, true, '28.11 · 22:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
join public.venues v on v.city_id = c.id and v.slug = 'maxvorstadt'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'plattenabend', c.id, t.id, v.id,
       'Plattenabend', 'Giesing · 07.12', 'Vinyl only, everyone brings one record, nobody gets to hear their own twice.', 25,
       '2026-12-07T18:00:00.000Z'::timestamptz, true, '07.12'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
join public.venues v on v.city_id = c.id and v.slug = 'giesing'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'vierter-stock', c.id, t.id, v.id,
       'Vierter Stock', 'Neuhausen · 21.02', 'Fourth floor, no lift, and the stairwell becomes the smoking area by midnight.', 26,
       '2027-02-21T18:00:00.000Z'::timestamptz, true, '21.02'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
join public.venues v on v.city_id = c.id and v.slug = 'neuhausen'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'zine-klub', c.id, t.id, v.id,
       'Zine Klub', 'Glockenbach · 03.09 · 19:00', 'Bring a page, leave with a stapled issue. First Tuesday of every month, no experience needed.', 27,
       '2026-09-03T17:00:00.000Z'::timestamptz, true, '03.09 · 19:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
join public.venues v on v.city_id = c.id and v.slug = 'glockenbach'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'kaffee-karten', c.id, t.id, v.id,
       'Kaffee & Karten', 'Westend · Sonntags · 15:00', 'Card games and too much coffee. Daylight only — it''s over before anything else starts.', 28,
       null, false, 'Sonntags · 15:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
join public.venues v on v.city_id = c.id and v.slug = 'westend'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'nachtlinie', c.id, t.id, null,
       'Nachtlinie', 'ab Isartor · 18.10 · 18:00', 'A guided night walk along the river and back through the old town. Ends at a bar, obviously.', 29,
       '2026-10-18T16:00:00.000Z'::timestamptz, true, '18.10 · 18:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'sprechstunde', c.id, t.id, v.id,
       'Sprechstunde', 'Untergiesing · Mittwochs · 19:30', 'An open round table — you talk about what you''re making, someone tells you what''s wrong with it.', 30,
       null, false, 'Mittwochs · 19:30'
from public.cities c
join public.event_types t on t.slug = 'meetup'
join public.venues v on v.city_id = c.id and v.slug = 'giesing'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'riso-abend', c.id, t.id, v.id,
       'Riso Abend', 'Schlachthofviertel · 09.10 · 18:00', 'Two-colour risograph workshop. You leave with ink on your hands and forty prints.', 31,
       '2026-10-09T16:00:00.000Z'::timestamptz, true, '09.10 · 18:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
join public.venues v on v.city_id = c.id and v.slug = 'schlachthof'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'lange-tafel', c.id, t.id, v.id,
       'Lange Tafel', 'Alte Utting · 26.09 · 18:30', 'One long table on a beached ship, strangers seated next to each other on purpose.', 32,
       '2026-09-26T16:30:00.000Z'::timestamptz, true, '26.09 · 18:30'
from public.cities c
join public.event_types t on t.slug = 'meetup'
join public.venues v on v.city_id = c.id and v.slug = 'alte-utting'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'strobo', c.id, t.id, v.id,
       'Strobo', 'Zenith Halle · 14.11 · 01:00', 'Hector Oaks and Sara Landry. Fast, loud, and unapologetically bright — sit this one out if lights are a problem.', 33,
       '2026-11-13T23:00:00.000Z'::timestamptz, true, '14.11 · 01:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
join public.venues v on v.city_id = c.id and v.slug = 'zenith'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'tunnelblick', c.id, t.id, v.id,
       'Tunnelblick', 'Tonhalle · 31.10', 'Twenty-four hours with no announced ending. People arrive in shifts.', 34,
       '2026-10-31T18:00:00.000Z'::timestamptz, true, '31.10'
from public.cities c
join public.event_types t on t.slug = 'rave'
join public.venues v on v.city_id = c.id and v.slug = 'tonhalle'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'spiegelsaal', c.id, t.id, v.id,
       'Spiegelsaal', 'P1 · 06.12 · 23:00', 'Italo and disco under an actual mirror ball. The most fun you''ll have taking nothing seriously.', 35,
       '2026-12-06T21:00:00.000Z'::timestamptz, true, '06.12 · 23:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
join public.venues v on v.city_id = c.id and v.slug = 'p1'
where c.slug = 'munchen'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, venue_id, title, meta, body, poster_no,
   starts_at, starts_at_estimated, date_text)
select 'pegel', c.id, t.id, v.id,
       'Pegel', 'Milla Club · 11.10 · 22:00', 'Live hardware sets, no laptops on stage. You watch the sound get built in front of you.', 36,
       '2026-10-11T20:00:00.000Z'::timestamptz, true, '11.10 · 22:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
join public.venues v on v.city_id = c.id and v.slug = 'milla'
where c.slug = 'munchen'
on conflict (slug) do nothing;


-- Stamp the migration log, if it is there (00_migrations.sql).
do $$ begin
  if to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('04_seed_events.sql');
  end if;
end $$;


-- ============================================================
--  DECK, KEPT, COUNTERS   (06_views.sql)
-- ============================================================

-- afterhours — the views and functions the front end uses
-- Keep the query logic here; the JS in the browser should only call it.

-- security_invoker: the view runs with the rights of whoever calls it.
-- Without it the view steps around RLS and unpublished events leak.

-- ------------------------------------------- a column a view cannot rename

-- `create or replace view` can add a column but it cannot RENAME one, and
-- the column carrying the type order was called type_sira before the code
-- moved to English. On a database built before that rename this file used
-- to stop dead with
--     42P16: cannot change name of view column "type_sira" to "type_sort_order"
-- and nothing after it ran. Dropping the view first is the only way.
--
-- cascade is safe here and nowhere else: the only things that depend on
-- events_public are deck() and kept(), which say `returns setof
-- public.events_public`, and both are recreated further down this same
-- file. On a fresh database the block does nothing at all.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'events_public'
      and column_name  = 'type_sira'
  ) then
    drop view public.events_public cascade;
    raise notice 'events_public dropped so its renamed column can come back';
  end if;

  -- The same dance for a SECOND paste: 15_ticketmaster.sql widens this
  -- view, and `create or replace` cannot narrow it back. On a database
  -- that already ran 15 the view is dropped here and widened again there.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name   = 'events_public'
      and column_name  = 'image_url'
  ) then
    drop view public.events_public cascade;
    raise notice 'events_public dropped so 15_ticketmaster.sql can widen it again';
  end if;
end
$$;


-- ------------------------------------------------- event (readable form)

create or replace view public.events_public
with (security_invoker = true) as
select
  e.id,
  e.slug,
  e.title,
  e.meta,
  e.body,
  e.poster_no,
  e.poster_path,
  e.starts_at,
  e.starts_at_estimated,
  e.date_text,
  e.is_published,
  t.slug  as type_slug,
  t.name  as type_name,
  t.sort_order  as type_sort_order,
  c.slug  as city_slug,
  c.name  as city_name,
  v.slug  as venue_slug,
  v.name  as venue_name
from public.events e
join public.event_types t on t.id = e.type_id
join public.cities      c on c.id = e.city_id
left join public.venues v on v.id = e.venue_id;

-- ------------------------------------------------------------ comments

create or replace view public.comments_public
with (security_invoker = true) as
select
  c.id,
  c.event_id,
  c.parent_id,
  c.body,
  c.time_text,
  c.created_at,
  coalesce(p.handle, p.display_name, c.author_name) as author,
  c.author_id is not null as is_real
from public.comments c
left join public.profiles p on p.id = c.author_id
where not c.is_hidden;

-- ---------------------------------------------------------------- deck

-- The deck in explore. Signed in, the cards already swiped drop out;
-- anonymous gets all 36. Ordered by poster number (the order used today).
-- create or replace is not enough when the return type changes; drop first.
drop function if exists public.deck(text, text, int);
create or replace function public.deck(
  p_city text default 'munchen',
  p_type text default null,
  p_limit int  default 60
)
returns setof public.events_public
language sql
stable
-- security definer: anonymous has no rights on the swipes table at all, but
-- the deck has to look there to ask "was this already swiped". The function
-- runs with the rights of its owner, so the published filter and the user
-- filter are written out BY HAND below to stop anything leaking.
security definer
set search_path = public
as $$
  select e.*
  from public.events_public e
  where e.is_published
    and e.city_slug = p_city
    and (p_type is null or e.type_slug = p_type)
    and not exists (
      select 1 from public.swipes s
      where s.event_id = e.id and s.user_id = auth.uid()
    )
  order by e.poster_no
  limit p_limit;
$$;

-- -------------------------------------------------------- writing a swipe

-- The browser should not need to know the event id: the slug is enough.
-- This is what lets the swipes collected while signed out be carried to
-- the account before the deck loads. user_id still comes from the session.
create or replace function public.swipe_set(p_slug text, p_direction text)
returns void
language sql
as $$
  insert into public.swipes (event_id, direction)
  select e.id, p_direction from public.events e where e.slug = p_slug
  on conflict (user_id, event_id)
  do update set direction = excluded.direction, created_at = now();
$$;

-- Reset my deck: every swipe of mine goes and the cards come back.
-- It only touches your own rows; RLS already forces that, but it is
-- written here too so the intent is visible.
create or replace function public.swipes_reset()
returns integer
language sql
as $$
  with removed as (
    delete from public.swipes where user_id = auth.uid() returning 1
  )
  select count(*)::int from removed;
$$;

-- --------------------------------------------------------- kept cards

-- "kept tonight": the ones you threw right, newest first.
-- It returns flat rows, not a composite type: composite types serialise
-- differently from version to version in REST; flat columns are the same everywhere.
-- create or replace is not enough when the return type changes; drop first.
drop function if exists public.kept();
create or replace function public.kept()
returns setof public.events_public
language sql
stable
as $$
  select e.*
  from public.swipes s
  join public.events_public e on e.id = s.event_id
  where s.user_id = auth.uid() and s.direction = 'right'
  order by s.created_at desc;
$$;

-- ------------------------------------------------- what your friends kept

-- What feeds the "friends liked swipes" mode. Confirmed friends only,
-- right swipes only; RLS already forces it, this makes the intent visible.
-- create or replace is not enough when the return type changes; drop first.
drop function if exists public.friends_kept(int);
create or replace function public.friends_kept(p_limit int default 60)
returns table (
  friend      text,
  kept_at     timestamptz,
  id          uuid,
  slug        text,
  title       text,
  meta        text,
  body        text,
  poster_no   int,
  type_name   text,
  venue_name  text,
  city_slug   text,
  starts_at   timestamptz
)
language sql
stable
as $$
  select coalesce(p.handle, p.display_name, 'a friend'), s.created_at,
         e.id, e.slug, e.title, e.meta, e.body, e.poster_no,
         e.type_name, e.venue_name, e.city_slug, e.starts_at
  from public.swipes s
  join public.events_public e on e.id = s.event_id
  join public.profiles p on p.id = s.user_id
  where s.direction = 'right'
    and s.user_id <> auth.uid()
    and public.is_friend(s.user_id)
  order by s.created_at desc
  limit p_limit;
$$;

-- --------------------------------------------------------- counters

-- Where the line on the landing page — "36 nights in Munich this week ·
-- 7 Rave · ..." — comes from. Today it is counted in JS; the same number
-- can come from here.
-- create or replace is not enough when the return type changes; drop first.
drop function if exists public.event_counts(text);
create or replace function public.event_counts(p_city text default 'munchen')
returns table (type_slug text, type_name text, sort_order int, n bigint)
language sql
stable
as $$
  select e.type_slug, e.type_name, e.type_sort_order, count(*)
  from public.events_public e
  where e.is_published and e.city_slug = p_city
  group by e.type_slug, e.type_name, e.type_sort_order
  order by e.type_sort_order;
$$;

-- How many people have kept an event. Who kept it stays hidden:
-- security definer hands out the COUNT and nothing else.
-- create or replace is not enough when the return type changes; drop first.
drop function if exists public.keep_counts();
create or replace function public.keep_counts()
returns table (event_id uuid, n bigint)
language sql
stable
security definer
set search_path = public
as $$
  select s.event_id, count(*)
  from public.swipes s
  where s.direction = 'right'
  group by s.event_id;
$$;

-- The city list for the filter: every city and how many nights it has.
-- create or replace is not enough when the return type changes; drop first.
drop function if exists public.city_counts();
create or replace function public.city_counts()
returns table (
  slug            text,
  name            text,
  status          text,
  sort_order            int,
  country         text,
  country_slug    text,
  continent       text,
  continent_slug  text,
  n               bigint
)
language sql
stable
as $$
  select c.slug, c.name, c.status, c.sort_order, c.country, c.country_slug,
         c.continent, c.continent_slug,
         count(e.id) filter (where e.is_published)
  from public.cities c
  left join public.events e on e.city_id = c.id
  group by c.slug, c.name, c.status, c.sort_order, c.country, c.country_slug,
           c.continent, c.continent_slug
  order by c.sort_order;
$$;

grant execute on function public.city_counts()         to anon, authenticated;
grant execute on function public.deck(text, text, int)  to anon, authenticated;
grant execute on function public.swipe_set(text, text)  to authenticated;
grant execute on function public.swipes_reset()         to authenticated;
grant execute on function public.kept()                 to authenticated;
grant execute on function public.friends_kept(int)      to authenticated;
grant execute on function public.event_counts(text)     to anon, authenticated;

-- keep_counts is the admin panel’s number; nothing signed out reads it.
-- Definer functions hand out exactly what they select, so the fewer keys
-- to this one the better (it was open to anonymous for no reason).
revoke execute on function public.keep_counts() from public, anon;
grant execute on function public.keep_counts()          to authenticated;

grant select on public.events_public, public.comments_public to anon, authenticated;

-- Stamp the migration log, if it is there. Each numbered file still runs on
-- its own (the tests load them one at a time), so this cannot insist.
do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('06_views.sql', '21b58172054af3d9589873a119e22cf1466e70c8a991826f8f4b23fb4a4141ec');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('06_views.sql');
  end if;
end $$;


-- ============================================================
--  FRIENDSHIP   (07_friends.sql)
-- ============================================================

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


-- ============================================================
--  POSTER STORE   (08_storage.sql)
-- ============================================================

-- afterhours — the poster store (Supabase Storage)
-- The storage schema only exists on Supabase; in the local tests this
-- block skips itself. That is why every statement is dynamic (execute).

do $$
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    raise notice 'no storage schema - poster store skipped (running locally)';
    return;
  end if;

  -- A public bucket: the posters are already on the site, nothing secret.
  execute $q$
    insert into storage.buckets (id, name, public)
    values ('posters', 'posters', true)
    on conflict (id) do nothing
  $q$;

  -- Reading is open to everyone
  execute $q$ drop policy if exists "posters okunur" on storage.objects $q$;
  execute $q$
    create policy "posters okunur" on storage.objects
      for select using (bucket_id = 'posters')
  $q$;

  -- Writing belongs to the admin alone. public.is_admin() is defined in 02_rls.sql.
  execute $q$ drop policy if exists "posters yonetici yazar" on storage.objects $q$;
  execute $q$ drop policy if exists "posters admin writes" on storage.objects $q$;
  execute $q$
    create policy "posters admin writes" on storage.objects
      for insert with check (bucket_id = 'posters' and public.is_admin())
  $q$;

  execute $q$ drop policy if exists "posters yonetici gunceller" on storage.objects $q$;
  execute $q$ drop policy if exists "posters admin updates" on storage.objects $q$;
  execute $q$
    create policy "posters admin updates" on storage.objects
      for update using (bucket_id = 'posters' and public.is_admin())
      with check (bucket_id = 'posters' and public.is_admin())
  $q$;

  execute $q$ drop policy if exists "posters yonetici siler" on storage.objects $q$;
  execute $q$ drop policy if exists "posters admin deletes" on storage.objects $q$;
  execute $q$
    create policy "posters admin deletes" on storage.objects
      for delete using (bucket_id = 'posters' and public.is_admin())
  $q$;
end
$$;

-- Stamp the migration log, if it is there. Each numbered file still runs on
-- its own (the tests load them one at a time), so this cannot insist.
do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('08_storage.sql', 'dc9cf4d0234f2ff473ff628d13258e2a8c05d14d0d690b063523cf2c600b31c9');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('08_storage.sql');
  end if;
end $$;


-- ============================================================
--  BACKGROUND JOBS   (09_jobs.sql)
-- ============================================================

-- afterhours — the jobs that run in the background
-- The pg_cron extension is switched on under Database → Extensions.
-- Without the extension the functions still work, they just do not run
-- on their own; you can also call them by hand.

-- Drop past events off the list.
-- IMPORTANT: it only touches events with a CONFIRMED date. Dropping one
-- of the 24 inferred dates could be wrong, and hiding those on their own
-- whose year was merely guessed would take a real event off the site.
create or replace function public.hide_past_events()
returns integer
language sql
security definer
set search_path = public
as $$
  with closed as (
    update public.events
    set is_published = false
    where is_published
      and starts_at is not null
      and not starts_at_estimated
      and starts_at < now() - interval '12 hours'   -- let the night end first
    returning 1
  )
  select count(*)::int from closed;
$$;

-- This is the cron job’s tool (pg_cron runs it as the owner). Postgres
-- hands EXECUTE to everyone by default, and there is no reason a browser
-- should be able to trigger it through the API.
revoke execute on function public.hide_past_events() from public, anon, authenticated;

-- The maintenance summary: one row saying what wants attention.
-- The database side of the warnings in the admin panel.
-- create or replace is not enough when the return type changes; drop first.
drop function if exists public.health();
create or replace function public.health()
returns table (
  events            bigint,
  published         bigint,
  missing_venue     bigint,
  unverified_date   bigint,
  past_still_up     bigint,
  comments          bigint,
  hidden_comments   bigint,
  people            bigint,
  swipes            bigint,
  -- confirmed pairs only: the number the help page shows as
  -- "friend connections". A pending request is not a connection yet.
  friendships       bigint
)
language sql
security definer
set search_path = public
as $$
  select
    (select count(*) from public.events),
    (select count(*) from public.events where is_published),
    (select count(*) from public.events where venue_id is null),
    (select count(*) from public.events where starts_at_estimated),
    (select count(*) from public.events
      where is_published and starts_at is not null
        and not starts_at_estimated and starts_at < now()),
    (select count(*) from public.comments),
    (select count(*) from public.comments where is_hidden),
    (select count(*) from public.profiles),
    (select count(*) from public.swipes),
    (select count(*) from public.friendships where status = 'accepted');
$$;

grant execute on function public.health() to anon, authenticated;

-- The schedule. If pg_cron is off, this block is skipped quietly.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('afterhours-gecmisi-dusur')
      where exists (select 1 from cron.job where jobname = 'afterhours-gecmisi-dusur');
    perform cron.unschedule('afterhours-drop-past')
      where exists (select 1 from cron.job where jobname = 'afterhours-drop-past');
    perform cron.schedule(
      'afterhours-drop-past',
      '30 5 * * *',                       -- 05:30 UTC daily, after the night is over
      $job$ select public.hide_past_events(); $job$
    );
  end if;
end
$$;

-- Stamp the migration log, if it is there. Each numbered file still runs on
-- its own (the tests load them one at a time), so this cannot insist.
do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('09_jobs.sql', 'ccef9d46b66b63da9bdae6308b5048818171e6ece9006ce66537522fbae90030');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('09_jobs.sql');
  end if;
end $$;


-- ============================================================
--  THE WORLD — 54 CITIES, 106 NIGHTS   (11_world.sql)
-- ============================================================

-- ============================================================
--  afterhours — THE WORLD: 6 continents, 18 countries, 54 cities, 106 nights
--
--  GENERATED FILE — source: backend/tools/world-sql.mjs
--  The content is invented but written by hand; the posters were
--  generated alongside it (posters/37.svg … 142.svg).
-- ============================================================

-- Continent fields on the cities
alter table public.cities add column if not exists continent text;
alter table public.cities add column if not exists continent_slug text;

-- Drop the cities with no nights that broke the shape (three per country).
delete from public.cities
where slug in ('hamburg', 'frankfurt', 'leipzig')
  and not exists (select 1 from public.events e where e.city_id = cities.id);

insert into public.cities
  (slug, name, status, sort_order, country, country_slug, continent, continent_slug)
values
  ('munchen', 'münchen', 'live', 1, 'Deutschland', 'de', 'Europe', 'eu'),
  ('berlin', 'berlin', 'live', 2, 'Deutschland', 'de', 'Europe', 'eu'),
  ('koln', 'köln', 'live', 3, 'Deutschland', 'de', 'Europe', 'eu'),
  ('istanbul', 'istanbul', 'live', 4, 'Türkiye', 'tr', 'Europe', 'eu'),
  ('ankara', 'ankara', 'live', 5, 'Türkiye', 'tr', 'Europe', 'eu'),
  ('izmir', 'izmir', 'live', 6, 'Türkiye', 'tr', 'Europe', 'eu'),
  ('wien', 'wien', 'live', 7, 'Österreich', 'at', 'Europe', 'eu'),
  ('graz', 'graz', 'live', 8, 'Österreich', 'at', 'Europe', 'eu'),
  ('salzburg', 'salzburg', 'live', 9, 'Österreich', 'at', 'Europe', 'eu'),
  ('tokyo', 'tokyo', 'live', 10, '日本', 'jp', 'Asia', 'as'),
  ('osaka', 'osaka', 'live', 11, '日本', 'jp', 'Asia', 'as'),
  ('kyoto', 'kyoto', 'live', 12, '日本', 'jp', 'Asia', 'as'),
  ('seoul', 'seoul', 'live', 13, '한국', 'kr', 'Asia', 'as'),
  ('busan', 'busan', 'live', 14, '한국', 'kr', 'Asia', 'as'),
  ('daegu', 'daegu', 'live', 15, '한국', 'kr', 'Asia', 'as'),
  ('jakarta', 'jakarta', 'live', 16, 'Indonesia', 'id', 'Asia', 'as'),
  ('bandung', 'bandung', 'live', 17, 'Indonesia', 'id', 'Asia', 'as'),
  ('yogyakarta', 'yogyakarta', 'live', 18, 'Indonesia', 'id', 'Asia', 'as'),
  ('lagos', 'lagos', 'live', 19, 'Nigeria', 'ng', 'Africa', 'af'),
  ('abuja', 'abuja', 'live', 20, 'Nigeria', 'ng', 'Africa', 'af'),
  ('ibadan', 'ibadan', 'live', 21, 'Nigeria', 'ng', 'Africa', 'af'),
  ('nairobi', 'nairobi', 'live', 22, 'Kenya', 'ke', 'Africa', 'af'),
  ('mombasa', 'mombasa', 'live', 23, 'Kenya', 'ke', 'Africa', 'af'),
  ('kisumu', 'kisumu', 'live', 24, 'Kenya', 'ke', 'Africa', 'af'),
  ('casablanca', 'casablanca', 'live', 25, 'Maroc', 'ma', 'Africa', 'af'),
  ('marrakesh', 'marrakesh', 'live', 26, 'Maroc', 'ma', 'Africa', 'af'),
  ('tanger', 'tanger', 'live', 27, 'Maroc', 'ma', 'Africa', 'af'),
  ('new-york', 'new york', 'live', 28, 'United States', 'us', 'North America', 'na'),
  ('chicago', 'chicago', 'live', 29, 'United States', 'us', 'North America', 'na'),
  ('detroit', 'detroit', 'live', 30, 'United States', 'us', 'North America', 'na'),
  ('ciudad-de-mexico', 'ciudad de méxico', 'live', 31, 'México', 'mx', 'North America', 'na'),
  ('guadalajara', 'guadalajara', 'live', 32, 'México', 'mx', 'North America', 'na'),
  ('monterrey', 'monterrey', 'live', 33, 'México', 'mx', 'North America', 'na'),
  ('montreal', 'montréal', 'live', 34, 'Canada', 'ca', 'North America', 'na'),
  ('toronto', 'toronto', 'live', 35, 'Canada', 'ca', 'North America', 'na'),
  ('vancouver', 'vancouver', 'live', 36, 'Canada', 'ca', 'North America', 'na'),
  ('sao-paulo', 'são paulo', 'live', 37, 'Brasil', 'br', 'South America', 'sa'),
  ('rio-de-janeiro', 'rio de janeiro', 'live', 38, 'Brasil', 'br', 'South America', 'sa'),
  ('belo-horizonte', 'belo horizonte', 'live', 39, 'Brasil', 'br', 'South America', 'sa'),
  ('buenos-aires', 'buenos aires', 'live', 40, 'Argentina', 'ar', 'South America', 'sa'),
  ('cordoba', 'córdoba', 'live', 41, 'Argentina', 'ar', 'South America', 'sa'),
  ('rosario', 'rosario', 'live', 42, 'Argentina', 'ar', 'South America', 'sa'),
  ('bogota', 'bogotá', 'live', 43, 'Colombia', 'co', 'South America', 'sa'),
  ('medellin', 'medellín', 'live', 44, 'Colombia', 'co', 'South America', 'sa'),
  ('cali', 'cali', 'live', 45, 'Colombia', 'co', 'South America', 'sa'),
  ('sydney', 'sydney', 'live', 46, 'Australia', 'au', 'Oceania', 'oc'),
  ('melbourne', 'melbourne', 'live', 47, 'Australia', 'au', 'Oceania', 'oc'),
  ('brisbane', 'brisbane', 'live', 48, 'Australia', 'au', 'Oceania', 'oc'),
  ('auckland', 'auckland', 'live', 49, 'Aotearoa', 'nz', 'Oceania', 'oc'),
  ('wellington', 'wellington', 'live', 50, 'Aotearoa', 'nz', 'Oceania', 'oc'),
  ('christchurch', 'christchurch', 'live', 51, 'Aotearoa', 'nz', 'Oceania', 'oc'),
  ('suva', 'suva', 'live', 52, 'Viti', 'fj', 'Oceania', 'oc'),
  ('nadi', 'nadi', 'live', 53, 'Viti', 'fj', 'Oceania', 'oc'),
  ('lautoka', 'lautoka', 'live', 54, 'Viti', 'fj', 'Oceania', 'oc')
on conflict (slug) do update set
  name = excluded.name,
  status = excluded.status,
  sort_order = excluded.sort_order,
  country = excluded.country,
  country_slug = excluded.country_slug,
  continent = excluded.continent,
  continent_slug = excluded.continent_slug;

create index if not exists cities_continent_idx
  on public.cities (continent_slug, country_slug, sort_order);

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'berlin-betonhalle', c.id, t.id, 'Betonhalle', 'Kraftwerk Mitte · 12.09 · 23:30', 'Concrete, three storeys of it, and a sound system that treats the building as a cabinet.',
       37, '2026-09-12T23:30:00+02:00'::timestamptz, false, '12.09 · 23:30'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'berlin'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'berlin-sonntagsclub', c.id, t.id, 'Sonntagsclub', 'Neukölln basement · 20.09 · 22:00', 'Sunday evening as a proper night out. Everyone has work tomorrow and nobody mentions it.',
       38, '2026-09-20T22:00:00+02:00'::timestamptz, false, '20.09 · 22:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'berlin'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'koln-domplatte', c.id, t.id, 'Domplatte', 'Kulturkirche · 03.10 · 20:00', 'A choir, a drum machine, and a church that was not built for either.',
       39, '2026-10-03T20:00:00+02:00'::timestamptz, false, '03.10 · 20:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'koln'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'koln-zweite-etage', c.id, t.id, 'Zweite Etage', 'Ehrenfeld · 17.10 · 21:00', 'Fourth flat on the left. The neighbours are invited, which is the only reason it works.',
       40, '2026-10-17T21:00:00+02:00'::timestamptz, false, '17.10 · 21:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'koln'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'istanbul-karakoy-alt-kat', c.id, t.id, 'Karaköy Alt Kat', 'Karaköy · 19.09 · 23:00', 'Below street level, one room, and the ferry horn coming through the wall at 2am.',
       41, '2026-09-19T23:00:00+02:00'::timestamptz, false, '19.09 · 23:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'istanbul'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'istanbul-plak-degisimi', c.id, t.id, 'Plak Değişimi', 'Kadıköy · 27.09 · 16:00', 'Bring three records you are done with. Leave with three you are not.',
       42, '2026-09-27T16:00:00+02:00'::timestamptz, false, '27.09 · 16:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'istanbul'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'ankara-sanat-sahnesi', c.id, t.id, 'Sanat Sahnesi', 'Kızılay · 10.10 · 20:30', 'A hall built for speeches, borrowed for a band that does not make any.',
       43, '2026-10-10T20:30:00+02:00'::timestamptz, false, '10.10 · 20:30'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'ankara'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'ankara-depo-gecesi', c.id, t.id, 'Depo Gecesi', 'Ostim · 24.10 · 00:30', 'An industrial district that empties at six and fills again at midnight.',
       44, '2026-10-24T00:30:00+02:00'::timestamptz, false, '24.10 · 00:30'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'ankara'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'izmir-korfez-acik-hava', c.id, t.id, 'Körfez Açık Hava', 'Kültürpark · 05.09 · 18:00', 'Five hours of sea breeze, then the wind drops and the bass finally sits still.',
       45, '2026-09-05T18:00:00+02:00'::timestamptz, false, '05.09 · 18:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'izmir'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'izmir-alsancak-gec-saat', c.id, t.id, 'Alsancak Geç Saat', 'Alsancak · 18.10 · 23:30', 'The street is loud until two; the room is louder after.',
       46, '2026-10-18T23:30:00+02:00'::timestamptz, false, '18.10 · 23:30'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'izmir'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'wien-gurtelbogen', c.id, t.id, 'Gürtelbogen', 'Stadtbahnbögen · 26.09 · 22:30', 'Under the railway arches, a train passing every four minutes and nobody flinching.',
       47, '2026-09-26T22:30:00+02:00'::timestamptz, false, '26.09 · 22:30'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'wien'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'wien-kaffeehaus-runde', c.id, t.id, 'Kaffeehaus Runde', 'Josefstadt · 11.10 · 17:00', 'One table, one waiter who has seen it all, and no agenda whatsoever.',
       48, '2026-10-11T17:00:00+02:00'::timestamptz, false, '11.10 · 17:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'wien'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'graz-altbau-dritter', c.id, t.id, 'Altbau Dritter', 'Lend · 04.10 · 21:30', 'High ceilings, thin walls, and a landlord who is somehow also invited.',
       49, '2026-10-04T21:30:00+02:00'::timestamptz, false, '04.10 · 21:30'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'graz'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'graz-murufer', c.id, t.id, 'Murufer', 'Kunsthaus · 22.11 · 20:00', 'Played to the river, which does not applaud but does carry the sound.',
       50, '2026-11-22T20:00:00+02:00'::timestamptz, false, '22.11 · 20:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'graz'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'salzburg-kellergewolbe', c.id, t.id, 'Kellergewölbe', 'Altstadt · 14.11 · 19:30', 'A cellar older than the country, and a set that leans into the reverb.',
       51, '2026-11-14T19:30:00+02:00'::timestamptz, false, '14.11 · 19:30'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'salzburg'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'salzburg-bergweg-fruhstuck', c.id, t.id, 'Bergweg Frühstück', 'Kapuzinerberg · 29.11 · 09:00', 'Walk up, eat, walk down. The whole event is the walk.',
       52, '2026-11-29T09:00:00+02:00'::timestamptz, false, '29.11 · 09:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'salzburg'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'tokyo-shibuya-chika', c.id, t.id, 'Shibuya Chika', 'Dogenzaka basement · 13.09 · 23:00', 'Second basement, forty people, and a policy of never announcing who is playing.',
       53, '2026-09-13T23:00:00+02:00'::timestamptz, false, '13.09 · 23:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'tokyo'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'tokyo-bayside-warehouse', c.id, t.id, 'Bayside Warehouse', 'Shinkiba · 27.09 · 01:00', 'Out where the trains stop early, so nobody leaves before the sun.',
       54, '2026-09-27T01:00:00+02:00'::timestamptz, false, '27.09 · 01:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'tokyo'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'osaka-namba-loft', c.id, t.id, 'Namba Loft', 'Namba · 08.10 · 19:00', 'Three bands, one hour each, and a crowd that stays for all three.',
       55, '2026-10-08T19:00:00+02:00'::timestamptz, false, '08.10 · 19:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'osaka'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'osaka-nagaya-night', c.id, t.id, 'Nagaya Night', 'Nishinari · 25.10 · 20:00', 'A row house with the doors open and the party spilling into the lane.',
       56, '2026-10-25T20:00:00+02:00'::timestamptz, false, '25.10 · 20:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'osaka'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'kyoto-kamogawa-sit', c.id, t.id, 'Kamogawa Sit', 'Kamo riverbank · 20.09 · 18:30', 'Everyone sits the same distance apart. Nobody planned it; it just happens here.',
       57, '2026-09-20T18:30:00+02:00'::timestamptz, false, '20.09 · 18:30'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'kyoto'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'kyoto-machiya-sound', c.id, t.id, 'Machiya Sound', 'Nakagyo · 15.11 · 22:00', 'A wooden townhouse with a sound system that respects the wood.',
       58, '2026-11-15T22:00:00+02:00'::timestamptz, false, '15.11 · 22:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'kyoto'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'seoul-mullae-ironworks', c.id, t.id, 'Mullae Ironworks', 'Mullae-dong · 19.09 · 23:30', 'Metal shops by day, still smelling of it by night, which somehow suits the music.',
       59, '2026-09-19T23:30:00+02:00'::timestamptz, false, '19.09 · 23:30'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'seoul'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'seoul-itaewon-late', c.id, t.id, 'Itaewon Late', 'Itaewon · 10.10 · 23:00', 'The last hour is the point. Everything before it is a waiting room.',
       60, '2026-10-10T23:00:00+02:00'::timestamptz, false, '10.10 · 23:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'seoul'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'busan-gwangalli-open-air', c.id, t.id, 'Gwangalli Open Air', 'Gwangalli Beach · 12.09 · 17:00', 'The bridge lights up at nine and the whole crowd turns around for it.',
       61, '2026-09-12T17:00:00+02:00'::timestamptz, false, '12.09 · 17:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'busan'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'busan-jagalchi-morning', c.id, t.id, 'Jagalchi Morning', 'Jagalchi Market · 26.09 · 07:00', 'For people who would rather start a day than end one.',
       62, '2026-09-26T07:00:00+02:00'::timestamptz, false, '26.09 · 07:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'busan'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'daegu-bangcheon-stage', c.id, t.id, 'Bangcheon Stage', 'Bangcheon Market · 17.10 · 19:30', 'A market alley that turns into a room once the shutters come down.',
       63, '2026-10-17T19:30:00+02:00'::timestamptz, false, '17.10 · 19:30'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'daegu'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'daegu-rooftop-4f', c.id, t.id, 'Rooftop 4F', 'Jung-gu · 07.11 · 21:00', 'Fourth floor, no lift, and everyone arrives slightly out of breath.',
       64, '2026-11-07T21:00:00+02:00'::timestamptz, false, '07.11 · 21:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'daegu'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'jakarta-kota-tua-cellar', c.id, t.id, 'Kota Tua Cellar', 'Kota Tua · 26.09 · 22:30', 'Colonial walls, tropical heat, and a fan that gave up an hour ago.',
       65, '2026-09-26T22:30:00+02:00'::timestamptz, false, '26.09 · 22:30'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'jakarta'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'jakarta-ancol-late', c.id, t.id, 'Ancol Late', 'Ancol · 24.10 · 00:00', 'By the water, where the city finally stops being loud in the other way.',
       66, '2026-10-24T00:00:00+02:00'::timestamptz, false, '24.10 · 00:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'jakarta'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'bandung-dago-hall', c.id, t.id, 'Dago Hall', 'Dago · 11.10 · 19:00', 'Cool enough at altitude that nobody complains about standing.',
       67, '2026-10-11T19:00:00+02:00'::timestamptz, false, '11.10 · 19:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'bandung'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'bandung-zine-sore', c.id, t.id, 'Zine Sore', 'Braga · 01.11 · 16:00', 'Photocopied, stapled, handed over. The whole economy runs on trade.',
       68, '2026-11-01T16:00:00+02:00'::timestamptz, false, '01.11 · 16:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'bandung'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'yogyakarta-kos-kosan', c.id, t.id, 'Kos Kosan', 'Sleman · 18.10 · 20:30', 'A student boarding house where the rule is that you bring something.',
       69, '2026-10-18T20:30:00+02:00'::timestamptz, false, '18.10 · 20:30'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'yogyakarta'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'yogyakarta-sawah-sonic', c.id, t.id, 'Sawah Sonic', 'rice terraces · 22.11 · 16:00', 'Speakers between the fields. The frogs join in after dark and stay.',
       70, '2026-11-22T16:00:00+02:00'::timestamptz, false, '22.11 · 16:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'yogyakarta'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'lagos-yaba-backroom', c.id, t.id, 'Yaba Backroom', 'Yaba · 19.09 · 23:00', 'Behind a phone repair shop, and the queue knows exactly which door.',
       71, '2026-09-19T23:00:00+02:00'::timestamptz, false, '19.09 · 23:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'lagos'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'lagos-freedom-park-live', c.id, t.id, 'Freedom Park Live', 'Lagos Island · 10.10 · 19:00', 'An old prison yard that has been a concert venue longer than it was a prison.',
       72, '2026-10-10T19:00:00+02:00'::timestamptz, false, '10.10 · 19:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'lagos'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'abuja-rock-bottom', c.id, t.id, 'Rock Bottom', 'Wuse · 03.10 · 00:00', 'A city designed on paper, and a night that ignores the plan entirely.',
       73, '2026-10-03T00:00:00+02:00'::timestamptz, false, '03.10 · 00:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'abuja'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'abuja-sunday-sound', c.id, t.id, 'Sunday Sound', 'Jabi Lake · 25.10 · 17:00', 'Everyone brings one speaker. It should not work and it does.',
       74, '2026-10-25T17:00:00+02:00'::timestamptz, false, '25.10 · 17:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'abuja'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'ibadan-bodija-compound', c.id, t.id, 'Bodija Compound', 'Bodija · 17.10 · 20:00', 'A compound, four families, and one generator that everyone is polite about.',
       75, '2026-10-17T20:00:00+02:00'::timestamptz, false, '17.10 · 20:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'ibadan'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'ibadan-agodi-open-air', c.id, t.id, 'Agodi Open Air', 'Agodi Gardens · 14.11 · 16:00', 'Starts in daylight so the drummers can see each other.',
       76, '2026-11-14T16:00:00+02:00'::timestamptz, false, '14.11 · 16:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'ibadan'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'nairobi-westlands-basement', c.id, t.id, 'Westlands Basement', 'Westlands · 26.09 · 22:30', 'Down two flights, and the traffic above stops mattering.',
       77, '2026-09-26T22:30:00+02:00'::timestamptz, false, '26.09 · 22:30'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'nairobi'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'nairobi-industrial-area', c.id, t.id, 'Industrial Area', 'Enterprise Road · 07.11 · 01:00', 'Warehouses that are still warehouses on Monday morning.',
       78, '2026-11-07T01:00:00+02:00'::timestamptz, false, '07.11 · 01:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'nairobi'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'mombasa-old-town-beats', c.id, t.id, 'Old Town Beats', 'Old Town · 12.09 · 18:00', 'Coral walls hold the heat and hand it back all evening.',
       79, '2026-09-12T18:00:00+02:00'::timestamptz, false, '12.09 · 18:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'mombasa'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'mombasa-dhow-sunset', c.id, t.id, 'Dhow Sunset', 'Tudor Creek · 04.10 · 17:30', 'On the water for two hours. There is nowhere to go, which is the design.',
       80, '2026-10-04T17:30:00+02:00'::timestamptz, false, '04.10 · 17:30'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'mombasa'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'kisumu-lakeside-stage', c.id, t.id, 'Lakeside Stage', 'Dunga Beach · 24.10 · 18:30', 'The lake goes flat at dusk and the sound carries much further than it should.',
       81, '2026-10-24T18:30:00+02:00'::timestamptz, false, '24.10 · 18:30'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'kisumu'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'kisumu-milimani-house', c.id, t.id, 'Milimani House', 'Milimani · 21.11 · 20:00', 'One long table outside, and nobody sits at it until midnight.',
       82, '2026-11-21T20:00:00+02:00'::timestamptz, false, '21.11 · 20:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'kisumu'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'casablanca-corniche-sous-sol', c.id, t.id, 'Corniche Sous-Sol', 'Ain Diab · 10.10 · 23:30', 'The sea on one side, a wall of speakers on the other.',
       83, '2026-10-10T23:30:00+02:00'::timestamptz, false, '10.10 · 23:30'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'casablanca'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'casablanca-ancienne-medina', c.id, t.id, 'Ancienne Médina', 'Old Medina · 28.11 · 20:00', 'A courtyard with four walls and a ceiling of exactly nothing.',
       84, '2026-11-28T20:00:00+02:00'::timestamptz, false, '28.11 · 20:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'casablanca'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'marrakesh-riad-rooftop', c.id, t.id, 'Riad Rooftop', 'Medina · 19.09 · 18:00', 'Mint tea, low cushions, and the call to prayer cutting cleanly through the conversation.',
       85, '2026-09-19T18:00:00+02:00'::timestamptz, false, '19.09 · 18:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'marrakesh'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'marrakesh-palmeraie-night', c.id, t.id, 'Palmeraie Night', 'Palmeraie · 31.10 · 23:00', 'Out among the palms, where the sound has nothing to bounce off.',
       86, '2026-10-31T23:00:00+02:00'::timestamptz, false, '31.10 · 23:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'marrakesh'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'tanger-detroit-sessions', c.id, t.id, 'Détroit Sessions', 'Cap Spartel · 05.09 · 17:00', 'Two seas meet here and the wind cannot decide which way to blow.',
       87, '2026-09-05T17:00:00+02:00'::timestamptz, false, '05.09 · 17:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'tanger'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'tanger-rue-de-la-plage', c.id, t.id, 'Rue de la Plage', 'Malabata · 14.11 · 23:00', 'A room that has been a cinema, a café, and now this.',
       88, '2026-11-14T23:00:00+02:00'::timestamptz, false, '14.11 · 23:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'tanger'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'new-york-bushwick-loft', c.id, t.id, 'Bushwick Loft', 'Bushwick · 12.09 · 23:00', 'Freight lift, fourth floor, and a door person who remembers faces.',
       89, '2026-09-12T23:00:00+02:00'::timestamptz, false, '12.09 · 23:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'new-york'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'new-york-bowery-basement', c.id, t.id, 'Bowery Basement', 'Lower East Side · 03.10 · 20:00', 'Two hundred people in a room built for eighty, which is the tradition.',
       90, '2026-10-03T20:00:00+02:00'::timestamptz, false, '03.10 · 20:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'new-york'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'chicago-south-side-warehouse', c.id, t.id, 'South Side Warehouse', 'Bridgeport · 26.09 · 00:00', 'Where the whole thing started, and the room still acts like it knows.',
       91, '2026-09-26T00:00:00+02:00'::timestamptz, false, '26.09 · 00:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'chicago'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'chicago-record-fair', c.id, t.id, 'Record Fair', 'Pilsen · 18.10 · 11:00', 'Crates on folding tables. Bring cash and a bag you can carry home.',
       92, '2026-10-18T11:00:00+02:00'::timestamptz, false, '18.10 · 11:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'chicago'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'detroit-eastern-market-late', c.id, t.id, 'Eastern Market Late', 'Eastern Market · 10.10 · 23:30', 'Produce sheds by day. The concrete floor takes the low end perfectly.',
       93, '2026-10-10T23:30:00+02:00'::timestamptz, false, '10.10 · 23:30'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'detroit'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'detroit-riverfront-open-air', c.id, t.id, 'Riverfront Open Air', 'Detroit Riverfront · 05.09 · 15:00', 'Canada on the far bank, close enough to wave at.',
       94, '2026-09-05T15:00:00+02:00'::timestamptz, false, '05.09 · 15:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'detroit'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'ciudad-de-mexico-roma-norte-sotano', c.id, t.id, 'Roma Norte Sótano', 'Roma Norte · 19.09 · 23:30', 'A basement under a building that survived two earthquakes and shows it.',
       95, '2026-09-19T23:30:00+02:00'::timestamptz, false, '19.09 · 23:30'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'ciudad-de-mexico'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'ciudad-de-mexico-vecindad', c.id, t.id, 'Vecindad', 'Doctores · 07.11 · 01:00', 'Courtyard housing, doors open onto it, and the party is the courtyard.',
       96, '2026-11-07T01:00:00+02:00'::timestamptz, false, '07.11 · 01:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'ciudad-de-mexico'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'guadalajara-teatro-chico', c.id, t.id, 'Teatro Chico', 'Centro · 24.10 · 20:00', 'Velvet seats nobody uses, because everyone stands from the first song.',
       97, '2026-10-24T20:00:00+02:00'::timestamptz, false, '24.10 · 20:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'guadalajara'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'guadalajara-azotea', c.id, t.id, 'Azotea', 'Americana · 14.11 · 21:00', 'Rooftop, string lights, and a view of every other rooftop doing the same.',
       98, '2026-11-14T21:00:00+02:00'::timestamptz, false, '14.11 · 21:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'guadalajara'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'monterrey-cerro-sonoro', c.id, t.id, 'Cerro Sonoro', 'Parque Fundidora · 12.09 · 16:00', 'Old steelworks, mountains behind, and heat that only breaks at nine.',
       99, '2026-09-12T16:00:00+02:00'::timestamptz, false, '12.09 · 16:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'monterrey'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'monterrey-fanzine-nocturno', c.id, t.id, 'Fanzine Nocturno', 'Barrio Antiguo · 01.11 · 18:00', 'Photocopies, folding tables, and arguments about staples.',
       100, '2026-11-01T18:00:00+02:00'::timestamptz, false, '01.11 · 18:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'monterrey'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'montreal-mile-end-loft', c.id, t.id, 'Mile End Loft', 'Mile End · 03.10 · 23:00', 'A permit that expires at three and a crowd that has read it.',
       101, '2026-10-03T23:00:00+02:00'::timestamptz, false, '03.10 · 23:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'montreal'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'montreal-plateau-church', c.id, t.id, 'Plateau Church', 'Le Plateau · 21.11 · 19:30', 'Deconsecrated, freezing, and acoustically almost unfair.',
       102, '2026-11-21T19:30:00+02:00'::timestamptz, false, '21.11 · 19:30'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'montreal'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'toronto-junction-warehouse', c.id, t.id, 'Junction Warehouse', 'The Junction · 17.10 · 00:30', 'Beside a rail line, so the low end has competition twice an hour.',
       103, '2026-10-17T00:30:00+02:00'::timestamptz, false, '17.10 · 00:30'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'toronto'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'toronto-kensington-swap', c.id, t.id, 'Kensington Swap', 'Kensington Market · 27.09 · 13:00', 'Trade a record, trade a jacket, trade a phone number. All equally likely.',
       104, '2026-09-27T13:00:00+02:00'::timestamptz, false, '27.09 · 13:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'toronto'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'vancouver-east-van-basement', c.id, t.id, 'East Van Basement', 'East Vancouver · 07.11 · 21:00', 'Rain outside, condensation inside, and nobody going home early because of either.',
       105, '2026-11-07T21:00:00+02:00'::timestamptz, false, '07.11 · 21:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'vancouver'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'vancouver-harbour-open-air', c.id, t.id, 'Harbour Open Air', 'Crab Park · 05.09 · 15:00', 'Mountains on one side, container cranes on the other.',
       106, '2026-09-05T15:00:00+02:00'::timestamptz, false, '05.09 · 15:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'vancouver'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'sao-paulo-barra-funda', c.id, t.id, 'Barra Funda', 'Barra Funda · 19.09 · 23:59', 'Nothing starts before midnight and nothing ends before the metro reopens.',
       107, '2026-09-19T23:59:00+02:00'::timestamptz, false, '19.09 · 23:59'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'sao-paulo'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'sao-paulo-minhoc-o', c.id, t.id, 'Minhocão', 'Elevado · 31.10 · 01:00', 'An elevated road closed to cars on Sundays, borrowed a few hours early.',
       108, '2026-10-31T01:00:00+02:00'::timestamptz, false, '31.10 · 01:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'sao-paulo'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'rio-de-janeiro-lapa-arcos', c.id, t.id, 'Lapa Arcos', 'Lapa · 12.09 · 18:00', 'Under the arches, where four sound systems negotiate all night.',
       109, '2026-09-12T18:00:00+02:00'::timestamptz, false, '12.09 · 18:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'rio-de-janeiro'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'rio-de-janeiro-roda-na-praca', c.id, t.id, 'Roda na Praça', 'Santa Teresa · 04.10 · 16:00', 'A circle, instruments passed around it, and no stage anywhere.',
       110, '2026-10-04T16:00:00+02:00'::timestamptz, false, '04.10 · 16:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'rio-de-janeiro'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'belo-horizonte-praca-sonora', c.id, t.id, 'Praça Sonora', 'Savassi · 24.10 · 19:00', 'A square that fills from the edges in, until you cannot see where it started.',
       111, '2026-10-24T19:00:00+02:00'::timestamptz, false, '24.10 · 19:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'belo-horizonte'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'belo-horizonte-casa-amarela', c.id, t.id, 'Casa Amarela', 'Santa Efigênia · 21.11 · 21:00', 'Yellow house, green gate, and a hill that punishes anyone who arrives late.',
       112, '2026-11-21T21:00:00+02:00'::timestamptz, false, '21.11 · 21:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'belo-horizonte'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'buenos-aires-palermo-sotano', c.id, t.id, 'Palermo Sótano', 'Palermo · 26.09 · 01:00', 'Dinner at eleven, arrive at one, leave when the bakeries open.',
       113, '2026-09-26T01:00:00+02:00'::timestamptz, false, '26.09 · 01:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'buenos-aires'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'buenos-aires-galpon-san-telmo', c.id, t.id, 'Galpón San Telmo', 'San Telmo · 14.11 · 20:30', 'A shed with a tin roof that becomes an instrument when it rains.',
       114, '2026-11-14T20:30:00+02:00'::timestamptz, false, '14.11 · 20:30'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'buenos-aires'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'cordoba-sierra-chica', c.id, t.id, 'Sierra Chica', 'outside the city · 10.10 · 23:00', 'Forty minutes out, no lights on the road, and a horizon you can hear.',
       115, '2026-10-10T23:00:00+02:00'::timestamptz, false, '10.10 · 23:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'cordoba'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'cordoba-feria-de-discos', c.id, t.id, 'Feria de Discos', 'Güemes · 18.10 · 12:00', 'Sunday, tables, and one man who will not sell you the record you want.',
       116, '2026-10-18T12:00:00+02:00'::timestamptz, false, '18.10 · 12:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'cordoba'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'rosario-costanera', c.id, t.id, 'Costanera', 'Paraná riverfront · 05.09 · 17:00', 'The river is a kilometre wide here and the sound just keeps going.',
       117, '2026-09-05T17:00:00+02:00'::timestamptz, false, '05.09 · 17:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'rosario'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'rosario-casa-chica', c.id, t.id, 'Casa Chica', 'Pichincha · 07.11 · 22:00', 'A small house with too many people in it, which is the entire concept.',
       118, '2026-11-07T22:00:00+02:00'::timestamptz, false, '07.11 · 22:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'rosario'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'bogota-chapinero-bajo', c.id, t.id, 'Chapinero Bajo', 'Chapinero · 19.09 · 22:30', 'Two thousand six hundred metres up, so pace yourself early.',
       119, '2026-09-19T22:30:00+02:00'::timestamptz, false, '19.09 · 22:30'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'bogota'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'bogota-bodega-norte', c.id, t.id, 'Bodega Norte', 'Usaquén · 28.11 · 00:00', 'Cold outside, which makes the room feel like a decision.',
       120, '2026-11-28T00:00:00+02:00'::timestamptz, false, '28.11 · 00:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'bogota'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'medellin-comuna-abierta', c.id, t.id, 'Comuna Abierta', 'Comuna 13 · 12.09 · 15:00', 'Escalators up the hillside, sound at every landing.',
       121, '2026-09-12T15:00:00+02:00'::timestamptz, false, '12.09 · 15:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'medellin'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'medellin-intercambio', c.id, t.id, 'Intercambio', 'Laureles · 01.11 · 17:00', 'Bring something to swap and something to say about it.',
       122, '2026-11-01T17:00:00+02:00'::timestamptz, false, '01.11 · 17:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'medellin'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'cali-salsa-vieja', c.id, t.id, 'Salsa Vieja', 'Barrio Obrero · 17.10 · 21:00', 'Live brass in a room where everyone already knows the steps.',
       123, '2026-10-17T21:00:00+02:00'::timestamptz, false, '17.10 · 21:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'cali'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'cali-terraza', c.id, t.id, 'Terraza', 'San Antonio · 21.11 · 20:00', 'A terrace above the old town, and a hill that keeps the noise local.',
       124, '2026-11-21T20:00:00+02:00'::timestamptz, false, '21.11 · 20:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'cali'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'sydney-marrickville-warehouse', c.id, t.id, 'Marrickville Warehouse', 'Marrickville · 26.09 · 22:00', 'Industrial estate, one unmarked roller door, and a noise complaint waiting to happen.',
       125, '2026-09-26T22:00:00+02:00'::timestamptz, false, '26.09 · 22:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'sydney'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'sydney-harbour-sunset', c.id, t.id, 'Harbour Sunset', 'Barangaroo · 05.09 · 16:00', 'Finishes at ten because the council says so, and nobody argues.',
       126, '2026-09-05T16:00:00+02:00'::timestamptz, false, '05.09 · 16:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'sydney'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'melbourne-laneway-late', c.id, t.id, 'Laneway Late', 'Collingwood · 10.10 · 00:00', 'A lane so narrow the sound has nowhere to go but up.',
       127, '2026-10-10T00:00:00+02:00'::timestamptz, false, '10.10 · 00:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'melbourne'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'melbourne-vinyl-sunday', c.id, t.id, 'Vinyl Sunday', 'Fitzroy · 18.10 · 12:00', 'Four hours, no phones on the table, and coffee taken very seriously.',
       128, '2026-10-18T12:00:00+02:00'::timestamptz, false, '18.10 · 12:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'melbourne'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'brisbane-fortitude-hall', c.id, t.id, 'Fortitude Hall', 'Fortitude Valley · 24.10 · 19:30', 'Humid enough that the band and the crowd are equally wet by the third song.',
       129, '2026-10-24T19:30:00+02:00'::timestamptz, false, '24.10 · 19:30'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'brisbane'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'brisbane-queenslander', c.id, t.id, 'Queenslander', 'West End · 14.11 · 20:00', 'A house on stilts, the party underneath it, and the mosquitos invited.',
       130, '2026-11-14T20:00:00+02:00'::timestamptz, false, '14.11 · 20:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'brisbane'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'auckland-k-road-basement', c.id, t.id, 'K Road Basement', 'Karangahape Road · 19.09 · 23:00', 'The street has changed hands four times; the basement has not changed at all.',
       131, '2026-09-19T23:00:00+02:00'::timestamptz, false, '19.09 · 23:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'auckland'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'auckland-waterfront-walk', c.id, t.id, 'Waterfront Walk', 'Wynyard Quarter · 27.09 · 17:00', 'An hour along the water, then whoever is left picks a bar.',
       132, '2026-09-27T17:00:00+02:00'::timestamptz, false, '27.09 · 17:00'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'auckland'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'wellington-cuba-street-cellar', c.id, t.id, 'Cuba Street Cellar', 'Te Aro · 17.10 · 23:30', 'Wind outside that could take the door off, and a room that stays warm anyway.',
       133, '2026-10-17T23:30:00+02:00'::timestamptz, false, '17.10 · 23:30'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'wellington'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'wellington-harbour-stage', c.id, t.id, 'Harbour Stage', 'Oriental Bay · 07.11 · 18:00', 'Played into a southerly, which every band here is prepared for.',
       134, '2026-11-07T18:00:00+02:00'::timestamptz, false, '07.11 · 18:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'wellington'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'christchurch-rebuild-open-air', c.id, t.id, 'Rebuild Open Air', 'Central City · 12.09 · 15:00', 'On a site that has been three different things since 2011.',
       135, '2026-09-12T15:00:00+02:00'::timestamptz, false, '12.09 · 15:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'christchurch'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'christchurch-villa-backyard', c.id, t.id, 'Villa Backyard', 'Riccarton · 21.11 · 19:00', 'Long grass, borrowed chairs, and a fire that someone thought about in advance.',
       136, '2026-11-21T19:00:00+02:00'::timestamptz, false, '21.11 · 19:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'christchurch'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'suva-seawall-sundown', c.id, t.id, 'Seawall Sundown', 'Suva seawall · 26.09 · 17:30', 'Everyone sits facing the same way. The event is the sunset and the talking.',
       137, '2026-09-26T17:30:00+02:00'::timestamptz, false, '26.09 · 17:30'
from public.cities c
join public.event_types t on t.slug = 'meetup'
where c.slug = 'suva'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'suva-victoria-parade', c.id, t.id, 'Victoria Parade', 'Victoria Parade · 24.10 · 22:00', 'Rain most evenings, and the room fills faster when it comes.',
       138, '2026-10-24T22:00:00+02:00'::timestamptz, false, '24.10 · 22:00'
from public.cities c
join public.event_types t on t.slug = 'club-night'
where c.slug = 'suva'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'nadi-reef-open-air', c.id, t.id, 'Reef Open Air', 'Wailoaloa Beach · 05.09 · 16:00', 'Sand, one stage, and a tide that decides how much room there is.',
       139, '2026-09-05T16:00:00+02:00'::timestamptz, false, '05.09 · 16:00'
from public.cities c
join public.event_types t on t.slug = 'festival'
where c.slug = 'nadi'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'nadi-backyard-lovo', c.id, t.id, 'Backyard Lovo', 'Namaka · 14.11 · 18:00', 'Food buried in the ground hours before anyone arrives. Worth the wait.',
       140, '2026-11-14T18:00:00+02:00'::timestamptz, false, '14.11 · 18:00'
from public.cities c
join public.event_types t on t.slug = 'hausparty'
where c.slug = 'nadi'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'lautoka-sugar-city-hall', c.id, t.id, 'Sugar City Hall', 'Lautoka · 17.10 · 19:00', 'The mill smells of molasses for six months a year and tonight is one of them.',
       141, '2026-10-17T19:00:00+02:00'::timestamptz, false, '17.10 · 19:00'
from public.cities c
join public.event_types t on t.slug = 'konzert'
where c.slug = 'lautoka'
on conflict (slug) do nothing;

insert into public.events
  (slug, city_id, type_id, title, meta, body, poster_no, starts_at,
   starts_at_estimated, date_text)
select 'lautoka-mill-yard', c.id, t.id, 'Mill Yard', 'Lautoka Mill · 28.11 · 23:00', 'Cane trains on one side, sound system on the other, both running late.',
       142, '2026-11-28T23:00:00+02:00'::timestamptz, false, '28.11 · 23:00'
from public.cities c
join public.event_types t on t.slug = 'rave'
where c.slug = 'lautoka'
on conflict (slug) do nothing;


-- Stamp the migration log, if it is there (00_migrations.sql).
do $$ begin
  if to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('11_world.sql');
  end if;
end $$;


-- ============================================================
--  PEOPLE PROFILES   (12_profiles.sql)
-- ============================================================

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


-- ============================================================
--  FEEDBACK   (13_feedback.sql)
-- ============================================================

-- afterhours — feedback
-- What sits behind the "give feedback → help us" page. One table, two rules:
-- everyone may write, only the admin may read.
--
-- You can write without signing in, because opening an account just to
-- report something broken is absurd. Whoever writes may then leave a
-- way to reach them; if not, what they wrote is still read, they just get
-- no answer.

create table if not exists public.feedback (
  id          uuid primary key default gen_random_uuid(),
  -- If signed in, who wrote it is filled in automatically; if the account
  -- is deleted the text stays and the name falls away.
  author_id   uuid default auth.uid() references public.profiles on delete set null,
  -- An email or some other way back, left by a signed-out writer. Optional.
  contact     text check (contact is null or length(btrim(contact)) between 3 and 120),
  kind        text not null default 'other'
              check (kind in ('broken', 'idea', 'event', 'other')),
  body        text not null check (length(btrim(body)) between 10 and 2000),
  -- The "this has been dealt with" mark on the admin side.
  handled     boolean not null default false,
  created_at  timestamptz not null default now()
);

drop index if exists public.feedback_yeni_idx;   -- the name from before the code spoke English
create index if not exists feedback_recent_idx on public.feedback (created_at desc);

alter table public.feedback enable row level security;

-- Everyone writes, signed in or not. One condition: not in another name.
drop policy if exists feedback_write on public.feedback;
create policy feedback_write on public.feedback for insert
  with check (author_id is null or author_id = auth.uid());

-- Only the admin reads. Not even the writer can read their own back:
-- this is an inbox, not a conversation.
drop policy if exists feedback_read on public.feedback;
create policy feedback_read on public.feedback for select
  using (public.is_admin());

drop policy if exists feedback_handle on public.feedback;
create policy feedback_handle on public.feedback for update
  using (public.is_admin()) with check (public.is_admin());

-- The list the admin panel reads: the writer resolved, the newest on top.
drop function if exists public.feedback_list(int);
create or replace function public.feedback_list(p_limit int default 100)
returns table (
  id         uuid,
  kind       text,
  body       text,
  author     text,
  contact    text,
  handled    boolean,
  created_at timestamptz
)
language sql
stable
as $$
  select f.id, f.kind, f.body,
         public.author_name(f.author_id, null),
         f.contact, f.handled, f.created_at
  from public.feedback f
  order by f.created_at desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

-- Writers may fill in exactly what the form asks: the subject, the words
-- and a way back. handled belongs to the admin’s PATCH, created_at to the
-- clock — neither is anyone’s to send. (The old broad grants are taken
-- back first; grants pile up on a database that ran an earlier version.)
revoke insert, update on public.feedback from anon, authenticated;
grant insert (author_id, kind, body, contact) on public.feedback to anon, authenticated;
grant update (handled) on public.feedback to authenticated;
grant select on public.feedback to authenticated;
grant execute on function public.feedback_list(int) to authenticated;

-- Stamp the migration log, if it is there. Each numbered file still runs on
-- its own (the tests load them one at a time), so this cannot insist.
do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('13_feedback.sql', 'dea8158134bc7c0ce4786a39a1f7a9f11a5873d90caae10dc3fa604cd49f7cd2');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('13_feedback.sql');
  end if;
end $$;


-- ============================================================
--  TAKE YOUR DATA WITH YOU   (14_export.sql)
-- ============================================================

-- afterhours — everything we hold about one person, in one call
-- The GDPR calls this the right of access (Art. 15) and the right to data
-- portability (Art. 20): a person may ask for their own data, and get it
-- in a form a machine can read. The site says so in datenschutz, so it has
-- to be true.
--
-- One function, and it only ever answers about the caller. There is no
-- argument to point it at somebody else.

create or replace function public.export_me()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'taken_at', now(),
    'about', 'Everything afterhours holds about you. Your account email lives'
             || ' with the sign-in provider, not in this database.',

    'profile', (
      select to_jsonb(x) from (
        select p.handle, p.display_name, p.bio, c.slug as city,
               p.created_at as joined, p.onboarded_at, p.last_seen_at
        from public.profiles p
        left join public.cities c on c.id = p.city_id
        where p.id = auth.uid()
      ) x),

    'settings', (
      select to_jsonb(x) from (
        select s.kept_visibility, s.discoverable, s.notify_email, s.locale
        from public.profile_settings s where s.user_id = auth.uid()
      ) x),

    -- Which nights you swiped, and which way. The event is named by its
    -- slug so the file still means something away from this database.
    'swipes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event', e.slug, 'title', e.title,
               'direction', w.direction, 'at', w.created_at)
             order by w.created_at)
      from public.swipes w
      join public.events e on e.id = w.event_id
      where w.user_id = auth.uid()
    ), '[]'::jsonb),

    'comments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event', e.slug, 'body', c.body,
               'reply_to', c.parent_id, 'at', c.created_at)
             order by c.created_at)
      from public.comments c
      join public.events e on e.id = c.event_id
      where c.author_id = auth.uid()
    ), '[]'::jsonb),

    -- Both directions, by handle. Another handle belongs to that person, but
    -- the fact of the friendship is yours as much as theirs.
    'friendships', coalesce((
      select jsonb_agg(jsonb_build_object(
               'handle', p.handle, 'status', f.status,
               'direction', case when f.requester_id = auth.uid()
                                 then 'outgoing' else 'incoming' end,
               'at', f.created_at)
             order by f.created_at)
      from public.friendships f
      join public.profiles p
        on p.id = case when f.requester_id = auth.uid()
                       then f.addressee_id else f.requester_id end
      where f.requester_id = auth.uid() or f.addressee_id = auth.uid()
    ), '[]'::jsonb),

    'feedback', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', g.kind, 'body', g.body, 'at', g.created_at)
             order by g.created_at)
      from public.feedback g where g.author_id = auth.uid()
    ), '[]'::jsonb)
  )
  where auth.uid() is not null;
$$;

-- Signed out there is nobody to describe, so this is for accounts only.
grant execute on function public.export_me() to authenticated;

-- Stamp the migration log, if it is there (00_migrations.sql).
do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('14_export.sql', '6c42d037a8d8af5cf230e0832ee2cb6adde149e91c42127f2aa8ade0a997479a');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('14_export.sql');
  end if;
end $$;


-- ============================================================
--  REAL EVENTS — TICKETMASTER COLUMNS, WORLDWIDE DECK   (15_ticketmaster.sql)
-- ============================================================

-- afterhours — real events from Ticketmaster
--
-- Four columns on events, and the deck learns to serve the whole world.
-- The rows themselves are written by backend/tools/sync-ticketmaster.mjs
-- (a daily GitHub Action with the service key); nothing in the browser
-- can write them, the same as every other event.
--
--   source       "seed" for the hand-written nights, "ticketmaster" for
--                the synced ones. The cleanup script and the daily prune
--                only ever touch their own source.
--   external_id  the Ticketmaster id. The sync upserts on it, so a night
--                keeps its uuid between runs and swipes on it survive.
--   image_url    a photograph instead of a drawn poster. The front end
--                shows an <img> when this is set, posters/NN.svg when not.
--   ticket_url   the real ticket page; the button on the event page uses
--                it when it is there.

alter table public.events add column if not exists source text not null default 'seed';
alter table public.events add column if not exists external_id text;
alter table public.events add column if not exists image_url text;
alter table public.events add column if not exists ticket_url text;

create unique index if not exists events_external_idx
  on public.events (external_id);

create index if not exists events_source_idx on public.events (source);

-- ------------------------------------------------- the view grows a little

-- The three new columns the screen needs, appended at the end. The view
-- is dropped rather than replaced: deck() and kept() return its row type,
-- and both are recreated right below (the same dance as in 06_views.sql).
drop view if exists public.events_public cascade;

create view public.events_public
with (security_invoker = true) as
select
  e.id,
  e.slug,
  e.title,
  e.meta,
  e.body,
  e.poster_no,
  e.poster_path,
  e.starts_at,
  e.starts_at_estimated,
  e.date_text,
  e.is_published,
  t.slug  as type_slug,
  t.name  as type_name,
  t.sort_order  as type_sort_order,
  c.slug  as city_slug,
  c.name  as city_name,
  v.slug  as venue_slug,
  v.name  as venue_name,
  e.image_url,
  e.ticket_url,
  e.source
from public.events e
join public.event_types t on t.id = e.type_id
join public.cities      c on c.id = e.city_id
left join public.venues v on v.id = e.venue_id;

-- ---------------------------------------------------- the deck, worldwide

-- One change of meaning: a NULL city now says "everywhere" instead of
-- "nowhere". The filter on explore sends null when the person has picked
-- no city, and the deck answers with the whole world, soonest night
-- inside a city block first. Hand-drawn posters keep their own order;
-- synced nights (no poster number) follow, by date.
create or replace function public.deck(
  p_city text default 'munchen',
  p_type text default null,
  p_limit int  default 60
)
returns setof public.events_public
language sql
stable
-- security definer: anonymous has no rights on the swipes table at all, but
-- the deck has to look there to ask "was this already swiped". The function
-- runs with the rights of its owner, so the published filter and the user
-- filter are written out BY HAND below to stop anything leaking.
security definer
set search_path = public
as $$
  select e.*
  from public.events_public e
  where e.is_published
    and (p_city is null or e.city_slug = p_city)
    and (p_type is null or e.type_slug = p_type)
    and not exists (
      select 1 from public.swipes s
      where s.event_id = e.id and s.user_id = auth.uid()
    )
  order by e.poster_no nulls last, e.starts_at nulls last, e.slug
  limit p_limit;
$$;

-- --------------------------------------------------------- kept cards

-- Unchanged in meaning; recreated because the cascade above took it.
create or replace function public.kept()
returns setof public.events_public
language sql
stable
as $$
  select e.*
  from public.swipes s
  join public.events_public e on e.id = s.event_id
  where s.user_id = auth.uid() and s.direction = 'right'
  order by s.created_at desc;
$$;

-- ------------------------------------------------- what your friends kept

-- Same rows as before plus the photograph, so a synced night in the
-- friends deck does not fall back to the wrong drawn poster.
-- create or replace is not enough when the return type changes; drop first.
drop function if exists public.friends_kept(int);
create or replace function public.friends_kept(p_limit int default 60)
returns table (
  friend      text,
  kept_at     timestamptz,
  id          uuid,
  slug        text,
  title       text,
  meta        text,
  body        text,
  poster_no   int,
  type_name   text,
  venue_name  text,
  city_slug   text,
  starts_at   timestamptz,
  image_url   text
)
language sql
stable
as $$
  select coalesce(p.handle, p.display_name, 'a friend'), s.created_at,
         e.id, e.slug, e.title, e.meta, e.body, e.poster_no,
         e.type_name, e.venue_name, e.city_slug, e.starts_at, e.image_url
  from public.swipes s
  join public.events_public e on e.id = s.event_id
  join public.profiles p on p.id = s.user_id
  where s.direction = 'right'
    and s.user_id <> auth.uid()
    and public.is_friend(s.user_id)
  order by s.created_at desc
  limit p_limit;
$$;

-- ------------------------------------------------------------- the keys

-- Dropping a view or a function takes its grants with it; everything the
-- cascade touched gets its keys back here.
grant select on public.events_public to anon, authenticated;
grant execute on function public.deck(text, text, int) to anon, authenticated;
grant execute on function public.kept()                to authenticated;
grant execute on function public.friends_kept(int)     to authenticated;

-- Stamp the migration log, if it is there. Each numbered file still runs on
-- its own (the tests load them one at a time), so this cannot insist.
do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('15_ticketmaster.sql', '19395a7080f04915970864ca82a17a419dbfaa3771393edbf35ffccff81125db');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('15_ticketmaster.sql');
  end if;
end $$;


-- ============================================================
--  THE COVERAGE — EUROPE, KEY ASIA, NORTH AMERICA   (16_coverage.sql)
-- ============================================================

-- afterhours — the coverage: all of Europe, the key Asian countries,
-- North America.
--
-- The 54 showcase cities of 11_world.sql were a demonstration; this is
-- the real service area, chosen with the Ticketmaster sync in mind.
-- Every city here is also on the sync map in
-- backend/tools/sync-ticketmaster.mjs — the two lists move together.
--
-- Cities that already exist keep their uuid (and their events); the
-- upsert only refreshes name, country and order. Cities outside the
-- coverage are not touched here — the live cleanup script drops the
-- event-less ones, and the tests keep them for the seed nights.

insert into public.cities
  (slug, name, status, sort_order, country, country_slug, continent, continent_slug)
values
  -- ---------------------------------------------------------- Europe
  ('munchen', 'münchen', 'live', 1, 'Deutschland', 'de', 'Europe', 'eu'),
  ('berlin', 'berlin', 'live', 2, 'Deutschland', 'de', 'Europe', 'eu'),
  ('koln', 'köln', 'live', 3, 'Deutschland', 'de', 'Europe', 'eu'),
  ('hamburg', 'hamburg', 'live', 4, 'Deutschland', 'de', 'Europe', 'eu'),
  ('frankfurt', 'frankfurt', 'live', 5, 'Deutschland', 'de', 'Europe', 'eu'),
  ('stuttgart', 'stuttgart', 'live', 6, 'Deutschland', 'de', 'Europe', 'eu'),
  ('dusseldorf', 'düsseldorf', 'live', 7, 'Deutschland', 'de', 'Europe', 'eu'),
  ('leipzig', 'leipzig', 'live', 8, 'Deutschland', 'de', 'Europe', 'eu'),
  ('istanbul', 'istanbul', 'live', 9, 'Türkiye', 'tr', 'Europe', 'eu'),
  ('ankara', 'ankara', 'live', 10, 'Türkiye', 'tr', 'Europe', 'eu'),
  ('izmir', 'izmir', 'live', 11, 'Türkiye', 'tr', 'Europe', 'eu'),
  ('wien', 'wien', 'live', 12, 'Österreich', 'at', 'Europe', 'eu'),
  ('graz', 'graz', 'live', 13, 'Österreich', 'at', 'Europe', 'eu'),
  ('salzburg', 'salzburg', 'live', 14, 'Österreich', 'at', 'Europe', 'eu'),
  ('zurich', 'zürich', 'live', 15, 'Schweiz', 'ch', 'Europe', 'eu'),
  ('geneva', 'genève', 'live', 16, 'Schweiz', 'ch', 'Europe', 'eu'),
  ('basel', 'basel', 'live', 17, 'Schweiz', 'ch', 'Europe', 'eu'),
  ('london', 'london', 'live', 18, 'United Kingdom', 'gb', 'Europe', 'eu'),
  ('manchester', 'manchester', 'live', 19, 'United Kingdom', 'gb', 'Europe', 'eu'),
  ('birmingham', 'birmingham', 'live', 20, 'United Kingdom', 'gb', 'Europe', 'eu'),
  ('glasgow', 'glasgow', 'live', 21, 'United Kingdom', 'gb', 'Europe', 'eu'),
  ('dublin', 'dublin', 'live', 22, 'Ireland', 'ie', 'Europe', 'eu'),
  ('cork', 'cork', 'live', 23, 'Ireland', 'ie', 'Europe', 'eu'),
  ('paris', 'paris', 'live', 24, 'France', 'fr', 'Europe', 'eu'),
  ('lyon', 'lyon', 'live', 25, 'France', 'fr', 'Europe', 'eu'),
  ('marseille', 'marseille', 'live', 26, 'France', 'fr', 'Europe', 'eu'),
  ('amsterdam', 'amsterdam', 'live', 27, 'Nederland', 'nl', 'Europe', 'eu'),
  ('rotterdam', 'rotterdam', 'live', 28, 'Nederland', 'nl', 'Europe', 'eu'),
  ('utrecht', 'utrecht', 'live', 29, 'Nederland', 'nl', 'Europe', 'eu'),
  ('brussel', 'brussel', 'live', 30, 'België', 'be', 'Europe', 'eu'),
  ('antwerpen', 'antwerpen', 'live', 31, 'België', 'be', 'Europe', 'eu'),
  ('gent', 'gent', 'live', 32, 'België', 'be', 'Europe', 'eu'),
  ('madrid', 'madrid', 'live', 33, 'España', 'es', 'Europe', 'eu'),
  ('barcelona', 'barcelona', 'live', 34, 'España', 'es', 'Europe', 'eu'),
  ('valencia', 'valencia', 'live', 35, 'España', 'es', 'Europe', 'eu'),
  ('sevilla', 'sevilla', 'live', 36, 'España', 'es', 'Europe', 'eu'),
  ('milano', 'milano', 'live', 37, 'Italia', 'it', 'Europe', 'eu'),
  ('roma', 'roma', 'live', 38, 'Italia', 'it', 'Europe', 'eu'),
  ('torino', 'torino', 'live', 39, 'Italia', 'it', 'Europe', 'eu'),
  ('bologna', 'bologna', 'live', 40, 'Italia', 'it', 'Europe', 'eu'),
  ('lisboa', 'lisboa', 'live', 41, 'Portugal', 'pt', 'Europe', 'eu'),
  ('porto', 'porto', 'live', 42, 'Portugal', 'pt', 'Europe', 'eu'),
  ('warszawa', 'warszawa', 'live', 43, 'Polska', 'pl', 'Europe', 'eu'),
  ('krakow', 'kraków', 'live', 44, 'Polska', 'pl', 'Europe', 'eu'),
  ('wroclaw', 'wrocław', 'live', 45, 'Polska', 'pl', 'Europe', 'eu'),
  ('praha', 'praha', 'live', 46, 'Česko', 'cz', 'Europe', 'eu'),
  ('brno', 'brno', 'live', 47, 'Česko', 'cz', 'Europe', 'eu'),
  ('kobenhavn', 'københavn', 'live', 48, 'Danmark', 'dk', 'Europe', 'eu'),
  ('aarhus', 'aarhus', 'live', 49, 'Danmark', 'dk', 'Europe', 'eu'),
  ('stockholm', 'stockholm', 'live', 50, 'Sverige', 'se', 'Europe', 'eu'),
  ('goteborg', 'göteborg', 'live', 51, 'Sverige', 'se', 'Europe', 'eu'),
  ('malmo', 'malmö', 'live', 52, 'Sverige', 'se', 'Europe', 'eu'),
  ('oslo', 'oslo', 'live', 53, 'Norge', 'no', 'Europe', 'eu'),
  ('bergen', 'bergen', 'live', 54, 'Norge', 'no', 'Europe', 'eu'),
  ('helsinki', 'helsinki', 'live', 55, 'Suomi', 'fi', 'Europe', 'eu'),
  ('tampere', 'tampere', 'live', 56, 'Suomi', 'fi', 'Europe', 'eu'),
  ('athina', 'athína', 'live', 57, 'Ελλάδα', 'gr', 'Europe', 'eu'),
  ('thessaloniki', 'thessaloníki', 'live', 58, 'Ελλάδα', 'gr', 'Europe', 'eu'),
  ('budapest', 'budapest', 'live', 59, 'Magyarország', 'hu', 'Europe', 'eu'),
  -- ------------------------------------------------------------ Asia
  ('tokyo', 'tokyo', 'live', 60, '日本', 'jp', 'Asia', 'as'),
  ('osaka', 'osaka', 'live', 61, '日本', 'jp', 'Asia', 'as'),
  ('seoul', 'seoul', 'live', 62, '한국', 'kr', 'Asia', 'as'),
  ('busan', 'busan', 'live', 63, '한국', 'kr', 'Asia', 'as'),
  ('singapore', 'singapore', 'live', 64, 'Singapore', 'sg', 'Asia', 'as'),
  ('dubai', 'dubai', 'live', 65, 'United Arab Emirates', 'ae', 'Asia', 'as'),
  ('abu-dhabi', 'abu dhabi', 'live', 66, 'United Arab Emirates', 'ae', 'Asia', 'as'),
  ('hong-kong', 'hong kong', 'live', 67, '香港', 'hk', 'Asia', 'as'),
  ('taipei', 'taipei', 'live', 68, '台灣', 'tw', 'Asia', 'as'),
  -- --------------------------------------------------- North America
  ('new-york', 'new york', 'live', 69, 'United States', 'us', 'North America', 'na'),
  ('los-angeles', 'los angeles', 'live', 70, 'United States', 'us', 'North America', 'na'),
  ('chicago', 'chicago', 'live', 71, 'United States', 'us', 'North America', 'na'),
  ('detroit', 'detroit', 'live', 72, 'United States', 'us', 'North America', 'na'),
  ('miami', 'miami', 'live', 73, 'United States', 'us', 'North America', 'na'),
  ('san-francisco', 'san francisco', 'live', 74, 'United States', 'us', 'North America', 'na'),
  ('las-vegas', 'las vegas', 'live', 75, 'United States', 'us', 'North America', 'na'),
  ('seattle', 'seattle', 'live', 76, 'United States', 'us', 'North America', 'na'),
  ('austin', 'austin', 'live', 77, 'United States', 'us', 'North America', 'na'),
  ('boston', 'boston', 'live', 78, 'United States', 'us', 'North America', 'na'),
  ('atlanta', 'atlanta', 'live', 79, 'United States', 'us', 'North America', 'na'),
  ('philadelphia', 'philadelphia', 'live', 80, 'United States', 'us', 'North America', 'na'),
  ('washington', 'washington', 'live', 81, 'United States', 'us', 'North America', 'na'),
  ('denver', 'denver', 'live', 82, 'United States', 'us', 'North America', 'na'),
  ('nashville', 'nashville', 'live', 83, 'United States', 'us', 'North America', 'na'),
  ('new-orleans', 'new orleans', 'live', 84, 'United States', 'us', 'North America', 'na'),
  ('houston', 'houston', 'live', 85, 'United States', 'us', 'North America', 'na'),
  ('dallas', 'dallas', 'live', 86, 'United States', 'us', 'North America', 'na'),
  ('toronto', 'toronto', 'live', 87, 'Canada', 'ca', 'North America', 'na'),
  ('montreal', 'montréal', 'live', 88, 'Canada', 'ca', 'North America', 'na'),
  ('vancouver', 'vancouver', 'live', 89, 'Canada', 'ca', 'North America', 'na'),
  ('calgary', 'calgary', 'live', 90, 'Canada', 'ca', 'North America', 'na'),
  ('ottawa', 'ottawa', 'live', 91, 'Canada', 'ca', 'North America', 'na'),
  ('ciudad-de-mexico', 'ciudad de méxico', 'live', 92, 'México', 'mx', 'North America', 'na'),
  ('guadalajara', 'guadalajara', 'live', 93, 'México', 'mx', 'North America', 'na'),
  ('monterrey', 'monterrey', 'live', 94, 'México', 'mx', 'North America', 'na')
on conflict (slug) do update set
  name = excluded.name,
  status = excluded.status,
  sort_order = excluded.sort_order,
  country = excluded.country,
  country_slug = excluded.country_slug,
  continent = excluded.continent,
  continent_slug = excluded.continent_slug;

-- Showcase cities outside the coverage lose their place in the filter as
-- soon as nothing points at them. Here that only catches cities that
-- never had a night; the live cleanup (which removes the seed nights
-- first) catches the rest.
delete from public.cities c
where c.continent_slug not in ('eu', 'as', 'na')
  and not exists (select 1 from public.events e where e.city_id = c.id);

-- Stamp the migration log, if it is there. Each numbered file still runs on
-- its own (the tests load them one at a time), so this cannot insist.
do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('16_coverage.sql', 'e99e9d89a3c29bd7e2a68e3db1818e0dc8de82565f4b1fe10a7d1816d795c667');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('16_coverage.sql');
  end if;
end $$;


-- ============================================================
--  REAL PEOPLE — WHO KEPT A NIGHT, AND THE WAY YOU REACH THEM   (17_real_people.sql)
-- ============================================================

-- afterhours — real people on a night, and the way you reach them
--
-- The column of who is going on an event page, and the roll on the page
-- of a person, used to be drawn from name pools. These two calls replace them
-- with the database: who actually kept a night, how the caller knows
-- each of them, and what one person kept.
--
--   friends_of(uid)      the accepted friends of anybody, as ids
--   event_people(slug)   everybody who kept the night, with the path back
--                        to the caller: degree 1 is a friend, 2 a friend
--                        of a friend (via = that friend), 3 one further
--                        (via = the first hop), 0 no path known
--   profile_kept(handle) the nights one person kept, newest first
--
-- Both readers are definer: swipes are closed to strangers by the rule in
-- 02, and this is the one place they open — everybody is public for now,
-- by decision, except a person who set kept_visibility to private.

-- ------------------------------------------------------------ friends_of

create or replace function public.friends_of(uid uuid)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select case when f.requester_id = uid then f.addressee_id else f.requester_id end
  from public.friendships f
  where f.status = 'accepted'
    and (f.requester_id = uid or f.addressee_id = uid);
$$;

-- ---------------------------------------------------------- event_people

drop function if exists public.event_people(text);
create or replace function public.event_people(p_slug text)
returns table (
  handle        text,
  display_name  text,
  kept_at       timestamptz,
  degree        int,
  via           text,
  via2          text
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (select auth.uid() as id),
  mine as (select f from public.friends_of((select id from me)) f),
  people as (
    select s.user_id, s.created_at
    from public.swipes s
    join public.events e on e.id = s.event_id
    where e.slug = p_slug
      and s.direction = 'right'
      and s.user_id <> coalesce((select id from me), '00000000-0000-0000-0000-000000000000'::uuid)
      and public.kept_visible(s.user_id)
  ),
  -- the first hop: a friend of mine who is a friend of theirs
  hop1 as (
    select p.user_id, min(q.handle) as via
    from people p
    join lateral (
      select pr.handle
      from public.friends_of(p.user_id) g
      join mine m on m.f = g
      join public.profiles pr on pr.id = g
      order by pr.handle
      limit 1
    ) q on true
    group by p.user_id
  ),
  -- two hops: a friend of mine, then a friend of that friend, then them
  hop2 as (
    select p.user_id, min(q.via) as via, min(q.via2) as via2
    from people p
    join lateral (
      select pr1.handle as via, pr2.handle as via2
      from mine m
      join public.friends_of(m.f) g1 on true
      join public.friends_of(g1) g2 on g2 = p.user_id
      join public.profiles pr1 on pr1.id = m.f
      join public.profiles pr2 on pr2.id = g1
      where g1 <> (select id from me)
      order by pr1.handle, pr2.handle
      limit 1
    ) q on true
    group by p.user_id
  )
  select pr.handle, pr.display_name, p.created_at,
         case
           when (select id from me) is null then 0
           when exists (select 1 from mine m where m.f = p.user_id) then 1
           when h1.via is not null then 2
           when h2.via is not null then 3
           else 0
         end,
         case
           when exists (select 1 from mine m where m.f = p.user_id) then null
           else coalesce(h1.via, h2.via)
         end,
         case
           when h1.via is null then h2.via2
         end
  from people p
  join public.profiles pr on pr.id = p.user_id
  left join hop1 h1 on h1.user_id = p.user_id
  left join hop2 h2 on h2.user_id = p.user_id
  where pr.handle is not null
  order by 4 desc, 3 desc;
$$;

-- ---------------------------------------------------------- profile_kept

drop function if exists public.profile_kept(text);
create or replace function public.profile_kept(p_handle text)
returns table (
  kept_at     timestamptz,
  id          uuid,
  slug        text,
  title       text,
  meta        text,
  body        text,
  poster_no   int,
  type_name   text,
  venue_name  text,
  city_slug   text,
  starts_at   timestamptz,
  image_url   text
)
language sql
stable
security definer
set search_path = public
as $$
  select s.created_at,
         e.id, e.slug, e.title, e.meta, e.body, e.poster_no,
         e.type_name, e.venue_name, e.city_slug, e.starts_at, e.image_url
  from public.profiles p
  join public.swipes s on s.user_id = p.id and s.direction = 'right'
  join public.events_public e on e.id = s.event_id
  where p.handle = lower(btrim(p_handle))
    and public.kept_visible(p.id)
  order by s.created_at desc
  limit 60;
$$;

-- --------------------------------------------------------------- keys

revoke execute on function public.friends_of(uuid) from public, anon, authenticated;
grant execute on function public.event_people(text)  to anon, authenticated;
grant execute on function public.profile_kept(text)  to anon, authenticated;

-- Stamp the migration log, if it is there.
do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('17_real_people.sql', '68427f8d1536603cd4b47b493a9366166812d97a8cbd3ae4808e6e07b3a6c1c7');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('17_real_people.sql');
  end if;
end $$;


-- ============================================================
--  THE MAP — WHERE A NIGHT IS, AND WHAT IS NEAR YOU   (18_geo.sql)
-- ============================================================

-- afterhours — where a night is, on the map
--
-- Two columns on events and one call. The Ticketmaster sync writes the
-- coordinates of the venue on every upsert (backend/tools/sync-ticketmaster.mjs);
-- the hand-written nights get theirs from the venue table, once, below.
--
--   lat / lng    the venue, WGS84. NULL means "we do not know" — the map
--                leaves the night out, the deck does not care.
--   nights_near  the nights within p_km of a point, nearest first. Same
--                row shape as events_public plus the point and the distance,
--                so the app draws a pin from it directly.
--
-- Szene nights keep their real address behind check-in: the sync never
-- touches them, and whoever enters one by hand should put the district
-- centre here, not the door.

alter table public.events add column if not exists lat double precision;
alter table public.events add column if not exists lng double precision;
alter table public.venues add column if not exists lat double precision;
alter table public.venues add column if not exists lng double precision;

create index if not exists events_geo_idx on public.events (lat, lng) where lat is not null;

-- hand-written nights inherit the point of their venue, if the venue has one
update public.events e
   set lat = v.lat, lng = v.lng
  from public.venues v
 where e.venue_id = v.id and e.lat is null and v.lat is not null;

-- ------------------------------------------------------------ nearby

-- Haversine in plain SQL: no PostGIS, no extension to switch on. Good to a
-- few metres at city scale, which is all a night needs. A bounding box
-- goes first so the index does the heavy lifting; the exact distance
-- only runs on what survives it.
create or replace function public.nights_near(
  p_lat   double precision,
  p_lng   double precision,
  p_km    double precision default 3,
  p_limit int default 80
)
returns table (
  id            uuid,
  slug          text,
  title         text,
  meta          text,
  body          text,
  poster_no     int,
  image_url     text,
  ticket_url    text,
  source        text,
  starts_at     timestamptz,
  starts_at_estimated boolean,
  date_text     text,
  type_slug     text,
  type_name     text,
  city_slug     text,
  city_name     text,
  venue_name    text,
  lat           double precision,
  lng           double precision,
  distance_km   double precision
)
language sql
stable
security definer
set search_path = public
as $$
  with box as (
    select p_lat - p_km / 111.0                                  as lat_lo,
           p_lat + p_km / 111.0                                  as lat_hi,
           p_lng - p_km / (111.0 * cos(radians(p_lat)))          as lng_lo,
           p_lng + p_km / (111.0 * cos(radians(p_lat)))          as lng_hi
  ),
  near as (
    select e.id, e.slug, e.title, e.meta, e.body, e.poster_no, e.image_url,
           e.ticket_url, e.source, e.starts_at, e.starts_at_estimated,
           e.date_text, t.slug as type_slug, t.name as type_name,
           c.slug as city_slug, c.name as city_name, v.name as venue_name,
           e.lat, e.lng,
           2 * 6371.0 * asin(sqrt(
             power(sin(radians(e.lat - p_lat) / 2), 2)
             + cos(radians(p_lat)) * cos(radians(e.lat))
             * power(sin(radians(e.lng - p_lng) / 2), 2)
           )) as distance_km
      from public.events e
      join public.event_types t on t.id = e.type_id
      join public.cities      c on c.id = e.city_id
      left join public.venues v on v.id = e.venue_id
      cross join box
     where e.is_published
       and e.lat is not null and e.lng is not null
       and e.lat between box.lat_lo and box.lat_hi
       and e.lng between box.lng_lo and box.lng_hi
       and (e.starts_at is null or e.starts_at > now() - interval '8 hours')
  )
  select * from near
   where distance_km <= p_km
   order by distance_km, starts_at nulls last
   limit p_limit;
$$;

grant execute on function public.nights_near(double precision, double precision, double precision, int)
  to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('18_geo.sql', '845448c0da357dbe8834a5e72d1638b284b6c8fc39fbb4d71b64ee4fa94b06c5');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('18_geo.sql');
  end if;
end $$;


-- ============================================================
--  CHECK-IN, THE CARD, THE ROOM   (19_checkins.sql)
-- ============================================================

-- afterhours — check-in, the afterhours card, and the room
--
-- The heart of the product, in three tables and a handful of calls.
--
--   checkins    one row per person per night: "I was there". Written only
--               through check_in(), which asks two questions: is it that
--               night right now (six hours before the start until twelve
--               after), and are you close (500 m) when both sides have a
--               point. Every row takes a card number from one shared
--               sequence, so NO. 0208 means the 208th card ever issued.
--   room_posts  what the people who were there say, up to 200 characters.
--               Only they can read it, only they can write it, and only
--               until the room freezes: 48 hours after the night ends.
--   my_cards    everything the card generator needs, one row per card.
--
-- Nobody sees who checked in where except the person, their confirmed
-- friends (if show_friends is on), and the others in the same room, who
-- see initials only.

create sequence if not exists public.card_no_seq;

create table if not exists public.checkins (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references public.profiles on delete cascade,
  event_id      uuid not null references public.events on delete cascade,
  card_no       bigint not null default nextval('public.card_no_seq'),
  checked_at    timestamptz not null default now(),
  lat           double precision,
  lng           double precision,
  show_friends  boolean not null default true,
  unique (user_id, event_id)
);
create index if not exists checkins_event_idx on public.checkins (event_id);
create index if not exists checkins_user_idx  on public.checkins (user_id, checked_at desc);

create table if not exists public.room_posts (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events on delete cascade,
  user_id     uuid default auth.uid() references public.profiles on delete set null,
  body        text not null check (length(btrim(body)) between 1 and 200),
  created_at  timestamptz not null default now()
);
create index if not exists room_posts_event_idx on public.room_posts (event_id, created_at);

alter table public.checkins   enable row level security;
alter table public.room_posts enable row level security;

-- ------------------------------------------------------------ helpers

-- confirmed friends, either direction
create or replace function public.is_friend(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester_id = auth.uid() and f.addressee_id = other)
        or (f.addressee_id = auth.uid() and f.requester_id = other))
  );
$$;

-- when a room freezes: the night ends eight hours after it starts, the
-- room stays open 48 hours after that. A night without a date runs from
-- its first check-in.
create or replace function public.room_freeze_at(p_event uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(e.starts_at, (select min(c.checked_at) from public.checkins c where c.event_id = e.id), now())
         + interval '8 hours' + interval '48 hours'
  from public.events e where e.id = p_event;
$$;

create or replace function public.checked_in(p_event uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.checkins c where c.event_id = p_event and c.user_id = auth.uid());
$$;

-- ------------------------------------------------------------- rules

drop policy if exists checkins_read on public.checkins;
create policy checkins_read on public.checkins for select
  using (user_id = auth.uid() or (show_friends and public.is_friend(user_id)));

drop policy if exists checkins_update on public.checkins;
create policy checkins_update on public.checkins for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- no insert policy on purpose: rows come through check_in() below

drop policy if exists room_posts_read on public.room_posts;
create policy room_posts_read on public.room_posts for select
  using (public.checked_in(event_id));

drop policy if exists room_posts_write on public.room_posts;
create policy room_posts_write on public.room_posts for insert
  with check (user_id = auth.uid() and public.checked_in(event_id) and now() < public.room_freeze_at(event_id));

drop policy if exists room_posts_delete on public.room_posts;
create policy room_posts_delete on public.room_posts for delete
  using (user_id = auth.uid());

-- ----------------------------------------------------------- check in

-- Returns the card number. Errors are short codes the app turns into
-- sentences: signedout, nonight, notnow, far.
create or replace function public.check_in(
  p_slug text,
  p_lat  double precision default null,
  p_lng  double precision default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  e   public.events%rowtype;
  n   bigint;
  km  double precision;
begin
  if auth.uid() is null then raise exception 'signedout'; end if;
  select * into e from public.events where slug = p_slug and is_published;
  if not found then raise exception 'nonight'; end if;

  if e.starts_at is not null
     and (now() < e.starts_at - interval '6 hours' or now() > e.starts_at + interval '12 hours') then
    raise exception 'notnow';
  end if;

  if e.lat is not null and e.lng is not null and p_lat is not null and p_lng is not null then
    km := 2 * 6371.0 * asin(sqrt(
            power(sin(radians(e.lat - p_lat) / 2), 2)
            + cos(radians(p_lat)) * cos(radians(e.lat))
            * power(sin(radians(e.lng - p_lng) / 2), 2)));
    if km > 0.5 then raise exception 'far'; end if;
  end if;

  insert into public.checkins (user_id, event_id, lat, lng)
  values (auth.uid(), e.id, p_lat, p_lng)
  on conflict (user_id, event_id) do nothing;

  select card_no into n from public.checkins where user_id = auth.uid() and event_id = e.id;
  return n;
end;
$$;

-- ------------------------------------------------------------- cards

-- One row per card, shaped for the generator: the night, when you came,
-- who else was there (initials, never ids), how many spoke, the first two
-- lines from the room, and when it froze.
drop function if exists public.my_cards();
create or replace function public.my_cards()
returns table (
  card_no     bigint,
  checked_at  timestamptz,
  freeze_at   timestamptz,
  frozen      boolean,
  slug        text,
  title       text,
  type_name   text,
  venue_name  text,
  city_name   text,
  starts_at   timestamptz,
  image_url   text,
  crew        text[],
  crew_more   int,
  who_count   int,
  post_count  int,
  q1_body     text,
  q1_who      text,
  q1_at       timestamptz,
  q2_body     text,
  q2_who      text,
  q2_at       timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with mine as (
    select c.*, public.room_freeze_at(c.event_id) as freeze_at
    from public.checkins c where c.user_id = auth.uid()
  ),
  others as (
    select c.event_id,
           array_agg(lower(left(coalesce(p.display_name, p.handle, 's'), 1)) order by c.checked_at) as initials,
           count(*)::int as n
    from public.checkins c
    join public.profiles p on p.id = c.user_id
    where c.user_id <> auth.uid() and c.event_id in (select event_id from mine)
    group by c.event_id
  ),
  posts as (
    select r.event_id, r.body, lower(left(coalesce(p.display_name, p.handle, 's'), 1)) as who, r.created_at,
           row_number() over (partition by r.event_id order by r.created_at) as rn,
           count(*) over (partition by r.event_id)::int as total
    from public.room_posts r
    left join public.profiles p on p.id = r.user_id
    where r.event_id in (select event_id from mine)
  )
  select m.card_no, m.checked_at, m.freeze_at, now() >= m.freeze_at,
         e.slug, e.title, t.name, v.name, ci.name, e.starts_at, e.image_url,
         coalesce(o.initials[1:4], '{}'), greatest(coalesce(o.n, 0) - 4, 0),
         coalesce(o.n, 0) + 1,
         coalesce((select total from posts p where p.event_id = m.event_id limit 1), 0),
         (select body from posts p where p.event_id = m.event_id and rn = 1),
         (select who  from posts p where p.event_id = m.event_id and rn = 1),
         (select created_at from posts p where p.event_id = m.event_id and rn = 1),
         (select body from posts p where p.event_id = m.event_id and rn = 2),
         (select who  from posts p where p.event_id = m.event_id and rn = 2),
         (select created_at from posts p where p.event_id = m.event_id and rn = 2)
  from mine m
  join public.events e on e.id = m.event_id
  join public.event_types t on t.id = e.type_id
  join public.cities ci on ci.id = e.city_id
  left join public.venues v on v.id = e.venue_id
  left join others o on o.event_id = m.event_id
  order by m.checked_at desc;
$$;

-- -------------------------------------------------------------- room

create or replace function public.room_info(p_slug text)
returns table (
  event_id    uuid,
  checked_in  boolean,
  freeze_at   timestamptz,
  frozen      boolean,
  who_count   int,
  initials    text[]
)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, public.checked_in(e.id), public.room_freeze_at(e.id), now() >= public.room_freeze_at(e.id),
         (select count(*)::int from public.checkins c where c.event_id = e.id),
         case when public.checked_in(e.id)
              then (select coalesce(array_agg(lower(left(coalesce(p.display_name, p.handle, 's'), 1)) order by c.checked_at), '{}')
                    from public.checkins c join public.profiles p on p.id = c.user_id where c.event_id = e.id)
              else '{}' end
  from public.events e where e.slug = p_slug;
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
  order by r.created_at;
$$;

create or replace function public.room_post(p_slug text, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  ev uuid;
  n  uuid;
begin
  if auth.uid() is null then raise exception 'signedout'; end if;
  select id into ev from public.events where slug = p_slug;
  if ev is null then raise exception 'nonight'; end if;
  if not public.checked_in(ev) then raise exception 'notthere'; end if;
  if now() >= public.room_freeze_at(ev) then raise exception 'frozen'; end if;
  insert into public.room_posts (event_id, user_id, body) values (ev, auth.uid(), btrim(p_body)) returning id into n;
  return n;
end;
$$;

-- --------------------------------------------------- friends, tonight

-- where your confirmed friends are right now (last 8 hours), if they let you see
create or replace function public.friends_live()
returns table (
  friend_id     uuid,
  handle        text,
  display_name  text,
  slug          text,
  title         text,
  venue_name    text,
  checked_at    timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select c.user_id, p.handle, p.display_name, e.slug, e.title, v.name, c.checked_at
  from public.checkins c
  join public.profiles p on p.id = c.user_id
  join public.events e on e.id = c.event_id
  left join public.venues v on v.id = e.venue_id
  where c.show_friends
    and c.checked_at > now() - interval '8 hours'
    and public.is_friend(c.user_id)
  order by c.checked_at desc;
$$;

grant execute on function public.is_friend(uuid)                         to authenticated;
grant execute on function public.room_freeze_at(uuid)                    to anon, authenticated;
grant execute on function public.checked_in(uuid)                        to authenticated;
grant execute on function public.check_in(text, double precision, double precision) to authenticated;
grant execute on function public.my_cards()                              to authenticated;
grant execute on function public.room_info(text)                         to anon, authenticated;
grant execute on function public.room_list(text)                         to authenticated;
grant execute on function public.room_post(text, text)                   to authenticated;
grant execute on function public.friends_live()                          to authenticated;
grant select, update on public.checkins to authenticated;
grant select, insert, delete on public.room_posts to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('19_checkins.sql', '20c26372a269344c166562e355958ef7a756774194c77e03adf674cf596b4b73');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('19_checkins.sql');
  end if;
end $$;


-- ============================================================
--  DJS, SETS, FOLLOWS   (20_djs.sql)
-- ============================================================

-- afterhours — djs, their sets, and who follows them
--
--   djs        the person: name, genre, which of the three sounds plays
--              when you tune in, home city, photo, since when. Follower
--              numbers are counted from dj_follows (dj_follow_counts), never stored.
--   dj_sets    a night they play: venue, start, length. The app builds
--              "live now / later tonight / this week" from these.
--   dj_follows one row per person per dj. Only the owner reads their own.
--
-- Everyone reads djs and sets; only the admin writes them. Eight seed rows
-- so the screen is not empty on day one; they carry source = seed and can
-- be deleted the same way the invented nights were.

create table if not exists public.djs (
  id          uuid primary key default gen_random_uuid(),
  slug        text unique not null,
  name        text not null,
  genre       text not null,
  sound       text not null default 'house' check (sound in ('house', 'techno', 'rap')),
  city_id     uuid references public.cities on delete set null,
  photo_url   text,
  since       int,
  source      text not null default 'seed',
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.dj_sets (
  id          uuid primary key default gen_random_uuid(),
  dj_id       uuid not null references public.djs on delete cascade,
  venue       text not null,
  city_id     uuid references public.cities on delete set null,
  starts_at   timestamptz not null,
  hours       numeric(4,1) not null default 3
);
create index if not exists dj_sets_time_idx on public.dj_sets (starts_at);

create table if not exists public.dj_follows (
  user_id     uuid not null default auth.uid() references public.profiles on delete cascade,
  dj_id       uuid not null references public.djs on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, dj_id)
);

alter table public.djs        enable row level security;
alter table public.dj_sets    enable row level security;
alter table public.dj_follows enable row level security;

drop policy if exists djs_read on public.djs;
create policy djs_read on public.djs for select using (true);
drop policy if exists djs_admin on public.djs;
create policy djs_admin on public.djs for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists dj_sets_read on public.dj_sets;
create policy dj_sets_read on public.dj_sets for select using (true);
drop policy if exists dj_sets_admin on public.dj_sets;
create policy dj_sets_admin on public.dj_sets for all using (public.is_admin()) with check (public.is_admin());

drop policy if exists dj_follows_own on public.dj_follows;
create policy dj_follows_own on public.dj_follows for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

grant select on public.djs, public.dj_sets to anon, authenticated;
grant select, insert, delete on public.dj_follows to authenticated;

-- ---------------------------------------------------------------- seed

insert into public.djs (slug, name, genre, sound, city_id, since, sort_order)
select v.slug, v.name, v.genre, v.sound, c.id, v.since, v.o
from (values
  ('mara-volt', 'mara volt', 'techno', 'techno', 'munchen', 2023, 1),
  ('levent-ok', 'levent ok', 'house', 'house', 'munchen', 2021, 2),
  ('nachtfalter', 'nachtfalter', 'rave', 'techno', 'munchen', 2024, 3),
  ('ines-okur', 'ines okur', 'deep house', 'house', 'istanbul', 2022, 4),
  ('tuesday-club', 'tuesday club', 'house', 'house', 'munchen', 2020, 5),
  ('dilan-k', 'dilan k.', 'rap', 'rap', 'munchen', 2024, 6),
  ('orbit-9', 'orbit 9', 'techno', 'techno', 'berlin', 2019, 7),
  ('selin', 'selin', 'house', 'house', 'munchen', 2025, 8)
) as v(slug, name, genre, sound, city, since, o)
left join public.cities c on c.slug = v.city
on conflict (slug) do nothing;

-- sets: the next six days from whenever this runs, so the screen shows a
-- week of nights. re-running adds nothing (one seed set per dj and venue).
insert into public.dj_sets (dj_id, venue, city_id, starts_at, hours)
select d.id, v.venue, d.city_id, v.at, v.h
from (values
  ('levent-ok',    'harry klein',       date_trunc('day', now()) + interval '22 hours',            3),
  ('mara-volt',    'blitz',             date_trunc('day', now()) + interval '23 hours 30 minutes', 4),
  ('nachtfalter',  'szene',             date_trunc('day', now()) + interval '1 day 1 hour',        5),
  ('ines-okur',    'kadıköy · alt kat', date_trunc('day', now()) + interval '1 day 23 hours',      4),
  ('tuesday-club', 'rote sonne',        date_trunc('day', now()) + interval '2 days 23 hours',     3),
  ('orbit-9',      'blitz',             date_trunc('day', now()) + interval '3 days 23 hours',     5),
  ('dilan-k',      'bahnwärter thiel',  date_trunc('day', now()) + interval '4 days 21 hours',     2),
  ('selin',        'harry klein',       date_trunc('day', now()) + interval '5 days 22 hours',     3)
) as v(slug, venue, at, h)
join public.djs d on d.slug = v.slug
where not exists (
  select 1 from public.dj_sets s
  where s.dj_id = d.id and s.venue = v.venue
);

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('20_djs.sql', 'bd2925223d53fe72984c69828aa1921f90eea3cdb8959f07ff286642360a1571');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('20_djs.sql');
  end if;
end $$;


-- ============================================================
--  THE SOUND STORE   (21_sound.sql)
-- ============================================================

-- afterhours — the sound store
--
-- The background music leaves the app package (14 MB) and streams from a
-- public bucket: sound/<genre>/NN.m4a. Everyone reads; the files are put
-- there once with the service key (backend/tools/upload-sound.mjs).
-- Supabase only: skipped elsewhere, like the poster store.

do $$
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    raise notice 'no storage schema - sound store skipped (running locally)';
    return;
  end if;
  execute $q$
    insert into storage.buckets (id, name, public)
    values ('sound', 'sound', true)
    on conflict (id) do nothing
  $q$;
  execute $q$ drop policy if exists "sound is read by everyone" on storage.objects $q$;
  execute $q$
    create policy "sound is read by everyone" on storage.objects
      for select using (bucket_id = 'sound')
  $q$;
  execute $q$ drop policy if exists "sound admin writes" on storage.objects $q$;
  execute $q$
    create policy "sound admin writes" on storage.objects
      for insert with check (bucket_id = 'sound' and public.is_admin())
  $q$;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('21_sound.sql', 'c58aeea48ea9d4e75ffee9a89e9009c82ec28c255a35f018b7ab1c8089f610b8');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('21_sound.sql');
  end if;
end $$;


-- ============================================================
--  HARDENING — WHAT THE REVIEW CLOSED   (22_hardening.sql)
-- ============================================================

-- afterhours — hardening after review (19, 20, 18)
--
-- What the review found, and what closes it:
--   checkins   a person could UPDATE their own row onto another night and
--              forge the card number. Now only show_friends is writable,
--              card_no is unique, and device coordinates are not stored at
--              all (check_in only ever needed them for the 500 m test).
--   room_posts direct INSERT let anyone backdate a line onto the front of
--              every card; direct SELECT handed out poster ids. Both go
--              through the functions now; delete stops at the freeze.
--   guests     anonymous sessions could check in and post without anyone
--              to hold to it. Cards and rooms need a real account.
--   djs        the admin write policies had no grant behind them, and the
--              follower number was invented. Counts come from dj_follows.
--   check_in   no coordinates skipped the door test; a night without a
--              date had no window at all; a repeat call burned a number.
--   friends_live carried the clock time; it carries the hour now.
--   nights_near ran as definer for no reason.

-- ------------------------------------------------------------- guests

create or replace function public.is_guest()
returns boolean
language sql
stable
as $$
  select coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'is_anonymous')::boolean, false);
$$;
grant execute on function public.is_guest() to anon, authenticated;

-- ----------------------------------------------------------- checkins

alter table public.checkins drop column if exists lat;
alter table public.checkins drop column if exists lng;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'checkins_card_no_key') then
    alter table public.checkins add constraint checkins_card_no_key unique (card_no);
  end if;
end $$;

revoke select, update on public.checkins from authenticated;
grant select (id, user_id, event_id, card_no, show_friends) on public.checkins to authenticated;
grant update (show_friends) on public.checkins to authenticated;

revoke select, insert, delete on public.room_posts from authenticated;
grant delete on public.room_posts to authenticated;

drop policy if exists room_posts_delete on public.room_posts;
create policy room_posts_delete on public.room_posts for delete
  using (user_id = auth.uid() and now() < public.room_freeze_at(event_id));

-- the door test needs a point on both sides; a night without a date has
-- no window and takes no check-in; a repeat call returns the same card.
create or replace function public.check_in(
  p_slug text,
  p_lat  double precision default null,
  p_lng  double precision default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  e   public.events%rowtype;
  n   bigint;
  km  double precision;
begin
  if auth.uid() is null or public.is_guest() then raise exception 'signedout'; end if;
  select * into e from public.events where slug = p_slug and is_published;
  if not found then raise exception 'nonight'; end if;
  if e.starts_at is null then raise exception 'notnow'; end if;
  if now() < e.starts_at - interval '6 hours' or now() > e.starts_at + interval '12 hours' then
    raise exception 'notnow';
  end if;

  if e.lat is not null and e.lng is not null then
    if p_lat is null or p_lng is null then raise exception 'far'; end if;
    km := 2 * 6371.0 * asin(sqrt(
            power(sin(radians(e.lat - p_lat) / 2), 2)
            + cos(radians(p_lat)) * cos(radians(e.lat))
            * power(sin(radians(e.lng - p_lng) / 2), 2)));
    if km > 0.5 then raise exception 'far'; end if;
  end if;

  select card_no into n from public.checkins where user_id = auth.uid() and event_id = e.id;
  if found then return n; end if;

  insert into public.checkins (user_id, event_id) values (auth.uid(), e.id) returning card_no into n;
  return n;
end;
$$;

create or replace function public.room_post(p_slug text, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  ev uuid;
  n  uuid;
begin
  if auth.uid() is null or public.is_guest() then raise exception 'signedout'; end if;
  select id into ev from public.events where slug = p_slug;
  if ev is null then raise exception 'nonight'; end if;
  if not public.checked_in(ev) then raise exception 'notthere'; end if;
  if now() >= public.room_freeze_at(ev) then raise exception 'frozen'; end if;
  insert into public.room_posts (event_id, user_id, body) values (ev, auth.uid(), btrim(p_body)) returning id into n;
  return n;
end;
$$;

-- where friends are: the hour, not the minute
drop function if exists public.friends_live();
create or replace function public.friends_live()
returns table (
  friend_id     uuid,
  handle        text,
  display_name  text,
  slug          text,
  title         text,
  venue_name    text,
  checked_at    timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select c.user_id, p.handle, p.display_name, e.slug, e.title, v.name, date_trunc('hour', c.checked_at)
  from public.checkins c
  join public.profiles p on p.id = c.user_id
  join public.events e on e.id = c.event_id
  left join public.venues v on v.id = e.venue_id
  where c.show_friends
    and c.checked_at > now() - interval '8 hours'
    and public.is_friend(c.user_id)
  order by c.checked_at desc;
$$;
grant execute on function public.friends_live() to authenticated;

-- ---------------------------------------------------------------- djs

grant insert, update, delete on public.djs, public.dj_sets to authenticated;

alter table public.djs drop column if exists followers;

create or replace function public.dj_follow_counts()
returns table (dj_id uuid, n bigint)
language sql
stable
security definer
set search_path = public
as $$
  select dj_id, count(*) from public.dj_follows group by dj_id;
$$;
grant execute on function public.dj_follow_counts() to anon, authenticated;

drop policy if exists dj_follows_own on public.dj_follows;
create policy dj_follows_own on public.dj_follows for all
  using (user_id = auth.uid()) with check (user_id = auth.uid() and not public.is_guest());

-- one seed set per dj and venue, whatever day the file runs
delete from public.dj_sets s
using public.djs d
where s.dj_id = d.id and d.source = 'seed'
  and s.id not in (
    select distinct on (dj_id, venue) id from public.dj_sets order by dj_id, venue, starts_at
  );

-- -------------------------------------------------------- nights_near

create or replace function public.nights_near(
  p_lat   double precision,
  p_lng   double precision,
  p_km    double precision default 3,
  p_limit int default 80
)
returns table (
  id            uuid,
  slug          text,
  title         text,
  meta          text,
  body          text,
  poster_no     int,
  image_url     text,
  ticket_url    text,
  source        text,
  starts_at     timestamptz,
  starts_at_estimated boolean,
  date_text     text,
  type_slug     text,
  type_name     text,
  city_slug     text,
  city_name     text,
  venue_name    text,
  lat           double precision,
  lng           double precision,
  distance_km   double precision
)
language sql
stable
as $$
  with box as (
    select p_lat - p_km / 111.0                                  as lat_lo,
           p_lat + p_km / 111.0                                  as lat_hi,
           p_lng - p_km / (111.0 * cos(radians(p_lat)))          as lng_lo,
           p_lng + p_km / (111.0 * cos(radians(p_lat)))          as lng_hi
  ),
  near as (
    select e.id, e.slug, e.title, e.meta, e.body, e.poster_no, e.image_url,
           e.ticket_url, e.source, e.starts_at, e.starts_at_estimated,
           e.date_text, t.slug as type_slug, t.name as type_name,
           c.slug as city_slug, c.name as city_name, v.name as venue_name,
           e.lat, e.lng,
           2 * 6371.0 * asin(sqrt(
             power(sin(radians(e.lat - p_lat) / 2), 2)
             + cos(radians(p_lat)) * cos(radians(e.lat))
             * power(sin(radians(e.lng - p_lng) / 2), 2)
           )) as distance_km
      from public.events e
      join public.event_types t on t.id = e.type_id
      join public.cities      c on c.id = e.city_id
      left join public.venues v on v.id = e.venue_id
      cross join box
     where e.is_published
       and e.lat is not null and e.lng is not null
       and e.lat between box.lat_lo and box.lat_hi
       and e.lng between box.lng_lo and box.lng_hi
       and (e.starts_at is null or e.starts_at > now() - interval '8 hours')
  )
  select * from near
   where distance_km <= p_km
   order by distance_km, starts_at nulls last
   limit p_limit;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('22_hardening.sql', '5eaab7682fd89f3291aef571b15fda540f691f9c6631d7fcc7f41011dfd51015');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('22_hardening.sql');
  end if;
end $$;


-- ============================================================
--  CHECK-IN, OPEN — NO DOOR TEST, NO WINDOW   (23_checkin_open.sql)
-- ============================================================

-- afterhours — check-in opens up (23)
--
-- The door test and the time window are gone: check in to any published
-- night, whenever, from wherever. What stays: a real account (no guest),
-- a night that exists, one card per person per night, and the room rules
-- (only the people with a card write, and only until it freezes).
-- The coordinates are still accepted so the app does not have to change
-- its call; they are simply not looked at.

create or replace function public.check_in(
  p_slug text,
  p_lat  double precision default null,
  p_lng  double precision default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.events%rowtype;
  n bigint;
begin
  if auth.uid() is null or public.is_guest() then raise exception 'signedout'; end if;
  select * into e from public.events where slug = p_slug and is_published;
  if not found then raise exception 'nonight'; end if;

  select card_no into n from public.checkins where user_id = auth.uid() and event_id = e.id;
  if found then return n; end if;

  insert into public.checkins (user_id, event_id) values (auth.uid(), e.id) returning card_no into n;
  return n;
end;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('23_checkin_open.sql', 'd14b387bd619ea2e5ea761c4c191d6392275e8c1e16c2c130b10ad89cb765a59');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('23_checkin_open.sql');
  end if;
end $$;


-- ============================================================
--  THE PHOTOGRAPH — YOURS TO SET, YOUR FRIENDS TO SEE   (24_photos.sql)
-- ============================================================

-- afterhours — the photograph on a profile
--
-- One photograph per person, shown at the top of their account and, to
-- their CONFIRMED friends, wherever the app draws that friend. Nobody
-- else: not a stranger who knows the handle, not someone whose request
-- is still waiting.
--
-- The picture itself lives in the storage bucket "photos", at
-- <user id>/<number>.jpg. What this table keeps is only that path. It is
-- a table of its own and not a column on profiles, because profiles can
-- be read by anyone LINKED to you — a pending request included — and a
-- face is owed to fewer people than a handle is.
--
-- The bucket is public in the storage sense: a file is served to whoever
-- holds its address, without a token, so an <Image> can simply load it.
-- The address is the secret; it is handed out by the rule below and by
-- nothing else, and it changes every time the photograph does.

create table if not exists public.profile_photos (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  path        text not null,
  updated_at  timestamptz not null default now(),
  constraint profile_photos_path_shape
    check (path ~ '^[0-9a-f-]{36}/[0-9]{1,16}[.]jpg$'),
  constraint profile_photos_path_own
    check (split_part(path, '/', 1) = user_id::text)
);

alter table public.profile_photos enable row level security;

-- confirmed friends, either direction (the same question 19 asks; asked
-- here again so this file does not depend on the check-ins being there)
create or replace function public.photo_friend(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester_id = auth.uid() and f.addressee_id = other)
        or (f.addressee_id = auth.uid() and f.requester_id = other))
  );
$$;
revoke execute on function public.photo_friend(uuid) from public, anon;
grant execute on function public.photo_friend(uuid) to authenticated;

drop policy if exists profile_photos_read on public.profile_photos;
create policy profile_photos_read on public.profile_photos for select
  using (user_id = auth.uid() or public.photo_friend(user_id));

-- Reading only. Writing goes through photo_set(), which knows whose row
-- it is; there is no insert, update or delete grant to get around it.
revoke all on public.profile_photos from anon, authenticated;
grant select on public.profile_photos to authenticated;

-- ------------------------------------------------------------ photo_set

-- Called after the file has been uploaded. null takes the photograph
-- away. Returns the path that was there BEFORE, so the app can remove
-- the old file from the bucket (the database cannot: storage rows are
-- not ours to delete).
drop function if exists public.photo_set(text);
create or replace function public.photo_set(p_path text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  was text;
begin
  if auth.uid() is null then
    raise exception 'signedout';
  end if;
  -- a guest has no friends to show a face to, and no account to keep it
  if coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'is_anonymous')::boolean, false) then
    raise exception 'guest';
  end if;

  select path into was from public.profile_photos where user_id = auth.uid();

  if p_path is null or btrim(p_path) = '' then
    delete from public.profile_photos where user_id = auth.uid();
    return was;
  end if;

  if split_part(p_path, '/', 1) <> auth.uid()::text then
    raise exception 'notyours';
  end if;

  insert into public.profile_photos (user_id, path)
  values (auth.uid(), p_path)
  on conflict (user_id) do update set path = excluded.path, updated_at = now();

  return was;
end;
$$;
revoke execute on function public.photo_set(text) from public, anon;
grant execute on function public.photo_set(text) to authenticated;

-- --------------------------------------------------------------- bucket

-- Supabase only: skipped elsewhere, like the poster and the sound store.
-- 3 MB and jpeg only; the app sends about 200 KB (1080 px wide).
do $$
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    raise notice 'no storage schema - photo store skipped (running locally)';
    return;
  end if;
  execute $q$
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('photos', 'photos', true, 3145728, array['image/jpeg'])
    on conflict (id) do update
      set public = true, file_size_limit = 3145728, allowed_mime_types = array['image/jpeg']
  $q$;

  -- No select policy on purpose: a public bucket serves a file by its
  -- address without one, and without one nobody can LIST the bucket.
  execute $q$ drop policy if exists "photos owner writes" on storage.objects $q$;
  execute $q$
    create policy "photos owner writes" on storage.objects
      for insert to authenticated
      with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text)
  $q$;
  execute $q$ drop policy if exists "photos owner removes" on storage.objects $q$;
  execute $q$
    create policy "photos owner removes" on storage.objects
      for delete to authenticated
      using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text)
  $q$;
  -- removing through the storage API reads the row first
  execute $q$ drop policy if exists "photos owner sees own" on storage.objects $q$;
  execute $q$
    create policy "photos owner sees own" on storage.objects
      for select to authenticated
      using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text)
  $q$;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('24_photos.sql', '47f14362b094dfdfe7f59a054aedb705d0b2bc4fd310b131bcb7afa8986d0ce1');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('24_photos.sql');
  end if;
end $$;


-- ============================================================
--  FINDING PEOPLE — SEARCH AND SUGGESTIONS   (25_people.sql)
-- ============================================================

-- afterhours — finding people: search and suggestions
-- 07 could only send a request to a handle you already knew by heart.
-- These two calls let the yours tab find someone:
--
--   people_search(q)     by handle or name, as you type
--   people_suggested(n)  a few you may know: the friends of your friends first,
--                        then people in your city
--
-- Both go around the profiles rule (the row of a stranger is closed), so both are
-- definer functions that hand back only the public card: handle, name, city.
-- Nobody hidden by "discoverable = off" appears in either. What someone kept
-- is never used for a stranger: kept nights are for friends only (12).

-- ------------------------------------------------ how you stand with someone

-- friend · outgoing (you asked) · incoming (they asked) · none
create or replace function public.people_relation(other uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select case
              when f.status = 'accepted' then 'friend'
              when f.requester_id = auth.uid() then 'outgoing'
              else 'incoming'
            end
     from public.friendships f
     where (f.requester_id = auth.uid() and f.addressee_id = other)
        or (f.addressee_id = auth.uid() and f.requester_id = other)
     limit 1),
    'none');
$$;

-- How many confirmed friends you and someone share.
create or replace function public.people_mutual(other uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  with mine as (
    select case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end as id
    from public.friendships f
    where f.status = 'accepted' and auth.uid() in (f.requester_id, f.addressee_id)
  ),
  theirs as (
    select case when f.requester_id = other then f.addressee_id else f.requester_id end as id
    from public.friendships f
    where f.status = 'accepted' and other in (f.requester_id, f.addressee_id)
  )
  select count(*)::int from mine join theirs using (id);
$$;

-- ------------------------------------------------------------------ search

-- Two letters at least; a dozen answers at most. The handle is matched from
-- its start, the name anywhere in it. % and _ typed by the person are taken
-- literally, not as wildcards.
drop function if exists public.people_search(text, int);
create or replace function public.people_search(p_query text, p_limit int default 12)
returns table (
  id            uuid,
  handle        text,
  display_name  text,
  city_name     text,
  mutual        int,
  relation      text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  q    text := lower(btrim(regexp_replace(coalesce(p_query, ''), '^@', '')));
  safe text;
begin
  if auth.uid() is null or length(q) < 2 then
    return;
  end if;
  safe := replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_');
  return query
    select p.id, p.handle, p.display_name, c.name,
           public.people_mutual(p.id), public.people_relation(p.id)
    from public.profiles p
    left join public.cities c on c.id = p.city_id
    where p.handle is not null
      and p.id <> auth.uid()
      and public.card_visible(p.id)
      and (p.handle like safe || '%' or lower(coalesce(p.display_name, '')) like '%' || safe || '%')
    order by (p.handle = q) desc,
             (p.handle like safe || '%') desc,
             public.people_mutual(p.id) desc,
             p.handle
    limit least(greatest(coalesce(p_limit, 12), 1), 20);
end;
$$;

-- ------------------------------------------------------------- suggestions

-- Someone you have no link with yet. Order: shared friends (most first),
-- then the same city, then who was around lately. reason tells the app
-- which line to write under the card: mutual · city · new.
drop function if exists public.people_suggested(int);
create or replace function public.people_suggested(p_limit int default 3)
returns table (
  id            uuid,
  handle        text,
  display_name  text,
  city_name     text,
  mutual        int,
  reason        text
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select p.city_id from public.profiles p where p.id = auth.uid()
  ),
  pool as (
    select p.id, p.handle, p.display_name, c.name as city_name,
           public.people_mutual(p.id) as mutual,
           (p.city_id is not null and p.city_id = (select city_id from me)) as same_city,
           p.last_seen_at
    from public.profiles p
    left join public.cities c on c.id = p.city_id
    where auth.uid() is not null
      and p.handle is not null
      and p.id <> auth.uid()
      and not public.is_linked(p.id)
      and public.card_visible(p.id)
  )
  select id, handle, display_name, city_name, mutual,
         case when mutual > 0 then 'mutual' when same_city then 'city' else 'new' end
  from pool
  order by mutual desc, same_city desc, last_seen_at desc nulls last, handle
  limit least(greatest(coalesce(p_limit, 3), 1), 12);
$$;

revoke execute on function public.people_relation(uuid)      from public, anon;
revoke execute on function public.people_mutual(uuid)        from public, anon;
revoke execute on function public.people_search(text, int)   from public, anon;
revoke execute on function public.people_suggested(int)      from public, anon;
grant execute on function public.people_relation(uuid)       to authenticated;
grant execute on function public.people_mutual(uuid)         to authenticated;
grant execute on function public.people_search(text, int)    to authenticated;
grant execute on function public.people_suggested(int)       to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('25_people.sql', '4881b3365b5165d7527cd2210d01d09d26b2196cee59b2c3ea211bfb5817e9fb');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('25_people.sql');
  end if;
end $$;


-- ============================================================
--  PUSH NOTIFICATIONS — REQUESTS, ACCEPTS, MATCHES, OUT NOW   (26_push.sql)
-- ============================================================

-- afterhours — push notifications
-- Every notification has a switch in the settings (profile_settings.notify_*):
--
--   friends    friend_request · friend_accepted · match · friend_live
--   nights     night_soon (a kept night starts in 2 to 3 hours)
--              room_open · room_closing · room_message (the rooms switch)
--              reply (someone answered your beforehours comment)
--   discovery  digest (thursday evening: the weekend in your city)
--              dj_live (a DJ you follow plays within the hour)
--              wave (a friend of a friend kept a night in your city)
--   sparks     spark (someone in your waves started one) · spark_in (someone is in on yours)
--              the triggers live in 34_spark_push.sql, after the sparks exist
--
-- The path: a trigger (or the hourly job) writes one row to push_outbox,
-- unless the person turned that kind off; a unique key keeps the same thing
-- from going out twice. A trigger on push_outbox hands due rows to the Expo
-- push service through pg_net; the rest wait for the five-minute flush.
--
-- Quiet hours: between 00:00 and 09:00 on the phone, requests, accepts,
-- matches, replies and the discovery kinds wait until 09:00. Friends out
-- now, the rooms, soon-starting nights and DJ sets go at once: they belong
-- to the night. Discovery and room messages stop at ten a day per person.
--
-- The phone registers its token with push_register(); a token belongs to
-- one account at a time and carries the app language and the time zone of
-- the phone. Without pg_net (the tests) rows wait in the outbox, unsent.
-- Phones Expo reports as gone are removed by the flush (push_prune).
--
-- Safe to run again on top of an earlier version of this file: every
-- table, column, constraint and function is created or replaced in place.

do $$ begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net is not available here; push rows stay in the outbox';
end $$;

-- ------------------------------------------------------------ the switches

alter table public.profile_settings
  add column if not exists notify_requests boolean not null default true,
  add column if not exists notify_accepts  boolean not null default true,
  add column if not exists notify_matches  boolean not null default true,
  add column if not exists notify_live     boolean not null default true,
  add column if not exists notify_nights   boolean not null default true,
  add column if not exists notify_rooms    boolean not null default true,
  add column if not exists notify_replies  boolean not null default true,
  add column if not exists notify_digest   boolean not null default true,
  add column if not exists notify_djs      boolean not null default true,
  add column if not exists notify_waves    boolean not null default true,
  add column if not exists notify_sparks   boolean not null default true;

-- ------------------------------------------------------------ the phones

create table if not exists public.push_tokens (
  token       text primary key check (token ~ '^Expo(nent)?PushToken\[.+\]$'),
  user_id     uuid not null references public.profiles on delete cascade,
  platform    text not null check (platform in ('ios', 'android')),
  lang        text not null default 'en' check (lang in ('en', 'de', 'tr')),
  tz          text not null default 'Europe/Berlin',
  updated_at  timestamptz not null default now()
);
alter table public.push_tokens add column if not exists tz text not null default 'Europe/Berlin';
create index if not exists push_tokens_user_idx on public.push_tokens (user_id, updated_at desc);

alter table public.push_tokens enable row level security;
drop policy if exists push_tokens_read_own on public.push_tokens;
create policy push_tokens_read_own on public.push_tokens for select
  using (user_id = auth.uid());
revoke all on public.push_tokens from anon, authenticated;
grant select on public.push_tokens to authenticated;

-- A token moves to whoever signs in on that phone; language and zone follow the app.
drop function if exists public.push_register(text, text, text);
create or replace function public.push_register(p_token text, p_platform text, p_lang text default 'en', p_tz text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  zone text := 'Europe/Berlin';
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  if p_tz is not null and exists (select 1 from pg_timezone_names where name = p_tz) then
    zone := p_tz;
  end if;
  insert into public.push_tokens (token, user_id, platform, lang, tz)
  values (p_token, auth.uid(), p_platform, coalesce(p_lang, 'en'), zone)
  on conflict (token) do update
    set user_id = excluded.user_id, platform = excluded.platform,
        lang = excluded.lang, tz = excluded.tz, updated_at = now();
  return true;
end;
$$;

-- On sign-out: this phone stops receiving notifications for this account.
create or replace function public.push_unregister(p_token text)
returns boolean
language sql
security definer
set search_path = public
as $$
  with gone as (
    delete from public.push_tokens where token = p_token and user_id = auth.uid() returning 1
  )
  select exists (select 1 from gone);
$$;

-- ------------------------------------------------------------ the outbox

create table if not exists public.push_outbox (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles on delete cascade,
  kind        text not null,
  -- one notification per thing: the same key never goes out twice
  key         text not null unique,
  data        jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  send_after  timestamptz not null default now(),
  sent_at     timestamptz
);
alter table public.push_outbox add column if not exists send_after timestamptz not null default now();
-- what was sent where: the pg_net request and the phones in message order,
-- so the answer from Expo can tell which phone no longer exists
alter table public.push_outbox add column if not exists request_id bigint;
alter table public.push_outbox add column if not exists tokens text[];
alter table public.push_outbox add column if not exists checked boolean not null default false;
alter table public.push_outbox drop constraint if exists push_outbox_kind_check;
alter table public.push_outbox add constraint push_outbox_kind_check check (kind in (
  'friend_request', 'friend_accepted', 'match', 'friend_live',
  'night_soon', 'room_open', 'room_closing', 'room_message', 'reply',
  'digest', 'dj_live', 'wave', 'spark', 'spark_in'));
create index if not exists push_outbox_user_idx on public.push_outbox (user_id, created_at desc);
create index if not exists push_outbox_due_idx on public.push_outbox (send_after) where sent_at is null;

-- Nobody reads or writes it directly; the triggers and jobs below do.
alter table public.push_outbox enable row level security;
revoke all on public.push_outbox from anon, authenticated;

-- ------------------------------------------------------------ helpers

-- The name a notification shows: the handle, else the display name.
create or replace function public.push_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select coalesce(p.handle, p.display_name) from public.profiles p where p.id = p_user), 'someone');
$$;

-- The time zone of the most recently registered phone.
create or replace function public.push_zone(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select k.tz from public.push_tokens k where k.user_id = p_user
                   order by k.updated_at desc limit 1), 'Europe/Berlin');
$$;

-- Whether the person wants this kind; a missing settings row means yes.
create or replace function public.push_wants(p_user uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select case
             when p_kind = 'friend_request'  then s.notify_requests
             when p_kind = 'friend_accepted' then s.notify_accepts
             when p_kind = 'match'           then s.notify_matches
             when p_kind = 'friend_live'     then s.notify_live
             when p_kind = 'night_soon'      then s.notify_nights
             when p_kind in ('room_open', 'room_closing', 'room_message') then s.notify_rooms
             when p_kind = 'reply'           then s.notify_replies
             when p_kind = 'digest'          then s.notify_digest
             when p_kind = 'dj_live'         then s.notify_djs
             when p_kind = 'wave'            then s.notify_waves
             when p_kind in ('spark', 'spark_in') then s.notify_sparks
           end
    from public.profile_settings s where s.user_id = p_user), true);
$$;

-- Clock time on the phone, for the words: "22:00".
create or replace function public.push_clock(p_user uuid, p_at timestamptz)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select to_char(p_at at time zone public.push_zone(p_user), 'HH24:MI');
$$;

create or replace function public.push_enqueue(p_user uuid, p_kind text, p_key text, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  zone  text;
  here  timestamp;
  due   timestamptz := now();
begin
  if not public.push_wants(p_user, p_kind) then
    return;
  end if;
  -- the daily cap for the chattier kinds
  if p_kind in ('room_message', 'digest', 'dj_live', 'wave')
     and (select count(*) from public.push_outbox o
          where o.user_id = p_user and o.created_at > now() - interval '1 day'
            and o.kind in ('room_message', 'digest', 'dj_live', 'wave')) >= 10 then
    return;
  end if;
  -- quiet hours: wait for 09:00 on the phone
  if p_kind not in ('friend_live', 'room_open', 'room_closing', 'room_message', 'night_soon', 'dj_live') then
    zone := public.push_zone(p_user);
    here := now() at time zone zone;
    if extract(hour from here) < 9 then
      due := (date_trunc('day', here) + interval '9 hours') at time zone zone;
    end if;
  end if;
  insert into public.push_outbox (user_id, kind, key, data, send_after)
  values (p_user, p_kind, p_key, p_data, due)
  on conflict (key) do nothing;
end;
$$;

-- ------------------------------------------------------------ the words

-- Title and body in the language of the phone; every {key} is filled from data.
drop function if exists public.push_text(text, text, jsonb);
create or replace function public.push_text(p_kind text, p_lang text, p_data jsonb)
returns table (title text, body text)
language plpgsql
immutable
as $$
declare
  pair record;
begin
  select x.title, x.body into title, body
  from (values
    ('friend_request',  'en', 'friend request',                '{name} wants to add you'),
    ('friend_request',  'de', 'freundschaftsanfrage',          '{name} möchte dich hinzufügen'),
    ('friend_request',  'tr', 'arkadaşlık isteği',             '{name} seni eklemek istiyor'),
    ('friend_accepted', 'en', 'you are friends now',           '{name} accepted your request'),
    ('friend_accepted', 'de', 'ihr seid jetzt freunde',        '{name} hat deine anfrage angenommen'),
    ('friend_accepted', 'tr', 'artık arkadaşsınız',            '{name} isteğini kabul etti'),
    ('match',           'en', '{name} is going too',           '{title}'),
    ('match',           'de', '{name} geht auch hin',          '{title}'),
    ('match',           'tr', '{name} de gidiyor',             '{title}'),
    ('friend_live',     'en', '{name} is out now',             '{title}'),
    ('friend_live',     'de', '{name} ist gerade unterwegs',   '{title}'),
    ('friend_live',     'tr', '{name} şu an dışarıda',         '{title}'),
    ('night_soon',      'en', 'tonight · {time}',              '{title}'),
    ('night_soon',      'de', 'heute nacht · {time}',          '{title}'),
    ('night_soon',      'tr', 'bu gece · {time}',              '{title}'),
    ('room_open',       'en', 'your room is open',             '{title} · 48 hours to write'),
    ('room_open',       'de', 'dein raum ist offen',           '{title} · 48 stunden zum schreiben'),
    ('room_open',       'tr', 'odan açık',                     '{title} · 48 saat yazabilirsin'),
    ('room_closing',    'en', 'your room closes soon',         '{title} · the last two hours'),
    ('room_closing',    'de', 'dein raum schließt bald',       '{title} · die letzten zwei stunden'),
    ('room_closing',    'tr', 'odan birazdan kapanıyor',       '{title} · son iki saat'),
    ('room_message',    'en', '{name} in {title}',             '{text}'),
    ('room_message',    'de', '{name} in {title}',             '{text}'),
    ('room_message',    'tr', '{title} · {name}',              '{text}'),
    ('reply',           'en', '{name} replied',                '{text}'),
    ('reply',           'de', '{name} hat geantwortet',        '{text}'),
    ('reply',           'tr', '{name} cevap verdi',            '{text}'),
    ('digest',          'en', 'this weekend in {city}',        '{n} nights · {friends} kept by friends'),
    ('digest',          'de', 'dieses wochenende in {city}',   '{n} nächte · {friends} von freunden behalten'),
    ('digest',          'tr', 'bu hafta sonu {city}',          '{n} gece · {friends} tanesini arkadaşların sakladı'),
    ('dj_live',         'en', '{name} plays soon',             '{where} · {time}'),
    ('dj_live',         'de', '{name} legt bald auf',          '{where} · {time}'),
    ('dj_live',         'tr', '{name} birazdan çalıyor',       '{where} · {time}'),
    ('wave',            'en', '2nd wave',                      'a friend of {via} kept {title}'),
    ('wave',            'de', '2. welle',                      'ein freund von {via} hat {title} behalten'),
    ('wave',            'tr', '2. dalga',                      '{via} üzerinden biri {title} gecesini sakladı'),
    ('spark',           'en', '{name} is starting something',  '{title} · {when}'),
    ('spark',           'de', '{name} startet etwas',          '{title} · {when}'),
    ('spark',           'tr', '{name} bir şey başlatıyor',     '{title} · {when}'),
    ('spark_in',        'en', '{name} is in',                  '{title}'),
    ('spark_in',        'de', '{name} ist dabei',              '{title}'),
    ('spark_in',        'tr', '{name} geliyor',                '{title}')
  ) as x(kind, lang, title, body)
  where x.kind = p_kind and x.lang = coalesce(nullif(p_lang, ''), 'en');

  for pair in select * from jsonb_each_text(coalesce(p_data, '{}')) loop
    title := replace(title, '{' || pair.key || '}', coalesce(pair.value, ''));
    body  := replace(body,  '{' || pair.key || '}', coalesce(pair.value, ''));
  end loop;
  return next;
end;
$$;

-- ------------------------------------------------------------ delivery

-- One request per notification, one message per phone of the recipient.
-- pg_net sends after the transaction commits: a rolled back swipe sends nothing.
create or replace function public.push_send(p_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  item      public.push_outbox;
  messages  jsonb;
  phones    text[];
  request   bigint;
begin
  if to_regnamespace('net') is null then
    return false;
  end if;
  select * into item from public.push_outbox where id = p_id and sent_at is null;
  if not found then
    return false;
  end if;
  select jsonb_agg(jsonb_build_object(
           'to', k.token, 'title', x.title, 'body', x.body, 'sound', 'default',
           'channelId', 'default', 'data', item.data || jsonb_build_object('kind', item.kind)) order by k.token),
         array_agg(k.token order by k.token)
    into messages, phones
  from public.push_tokens k
  cross join lateral public.push_text(item.kind, k.lang, item.data) x
  where k.user_id = item.user_id;

  if messages is not null then
    -- the endpoint path contains two dashes, spelled out so no tool reads them as a comment
    execute 'select net.http_post(url := $1, body := $2, headers := $3)'
      into request
      using 'https://exp.host/' || repeat('-', 2) || '/api/v2/push/send', messages,
            '{"Content-Type": "application/json", "Accept": "application/json"}'::jsonb;
  end if;
  update public.push_outbox set sent_at = now(), request_id = request, tokens = phones where id = p_id;
  return messages is not null;
end;
$$;

create or replace function public.push_deliver()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.send_after <= now() then
    perform public.push_send(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists push_outbox_deliver on public.push_outbox;
create trigger push_outbox_deliver
  after insert on public.push_outbox
  for each row execute function public.push_deliver();

-- Reads the answers Expo gave (pg_net keeps them for a few hours) and forgets
-- phones that no longer exist: the app was removed or the token expired.
create or replace function public.push_prune()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  answer record;
  i      integer;
  gone   integer := 0;
begin
  if to_regclass('net._http_response') is null then
    return 0;
  end if;
  for answer in execute $q$
    select o.id, o.tokens, h.status_code, h.content
    from public.push_outbox o
    join net._http_response h on h.id = o.request_id
    where not o.checked and o.request_id is not null
  $q$
  loop
    begin
      if answer.status_code = 200 then
        for i in 0 .. coalesce(jsonb_array_length(answer.content::jsonb -> 'data'), 0) - 1 loop
          if (answer.content::jsonb -> 'data' -> i -> 'details' ->> 'error') = 'DeviceNotRegistered' then
            delete from public.push_tokens where token = answer.tokens[i + 1];
            gone := gone + 1;
          end if;
        end loop;
      end if;
    exception when others then
      null;  -- an answer that is not JSON tells us nothing
    end;
    update public.push_outbox set checked = true where id = answer.id;
  end loop;
  -- answers pg_net has already thrown away will never come
  update public.push_outbox set checked = true
  where not checked and sent_at < now() - interval '1 day';
  return gone;
end;
$$;

-- Sends what has come due (quiet hours over). Older than a day is dropped.
create or replace function public.push_flush()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  due  bigint;
  sent integer := 0;
begin
  if to_regnamespace('net') is null then
    return 0;
  end if;
  for due in
    select id from public.push_outbox
    where sent_at is null and send_after <= now() and send_after > now() - interval '1 day'
    order by id limit 500
  loop
    perform public.push_send(due);
    sent := sent + 1;
  end loop;
  perform public.push_prune();
  return sent;
end;
$$;

-- ------------------------------------------------------------ friends

-- Confirmed friendships in both directions: (who, friend).
create or replace view public.push_edges
with (security_invoker = true) as
  select requester_id as who, addressee_id as friend from public.friendships where status = 'accepted'
  union all
  select addressee_id, requester_id from public.friendships where status = 'accepted';
revoke all on public.push_edges from anon, authenticated;

-- A request arrives; or one is accepted. The key carries the day, so a request
-- taken back and sent again notifies again tomorrow, not ten times today.
create or replace function public.push_on_friendship()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.status = 'pending' then
    perform public.push_enqueue(new.addressee_id, 'friend_request',
      format('request:%s:%s:%s', new.requester_id, new.addressee_id, current_date),
      jsonb_build_object('name', public.push_name(new.requester_id), 'url', '/friend/' || new.requester_id));
  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'accepted' then
    perform public.push_enqueue(new.requester_id, 'friend_accepted',
      format('accepted:%s:%s', new.requester_id, new.addressee_id),
      jsonb_build_object('name', public.push_name(new.addressee_id), 'url', '/friend/' || new.addressee_id));
  end if;
  return new;
end;
$$;

drop trigger if exists push_friendship on public.friendships;
create trigger push_friendship
  after insert or update of status on public.friendships
  for each row execute function public.push_on_friendship();

-- A keep. Friends who kept the same night hear it (match). Friends of friends
-- in the city of the night hear it once a week, without the name (wave).
-- Nothing at all when the swiper keeps their keeps private (12: kept_visibility).
create or replace function public.push_on_swipe()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  night record;
  them  record;
begin
  if new.direction <> 'right' or (tg_op = 'UPDATE' and old.direction = 'right') then
    return new;
  end if;
  if not public.kept_visible(new.user_id) then
    return new;
  end if;
  select e.title, e.slug, e.city_id into night from public.events e where e.id = new.event_id;

  for them in
    select w.user_id
    from public.swipes w
    join public.push_edges f on f.who = new.user_id and f.friend = w.user_id
    where w.event_id = new.event_id and w.direction = 'right'
  loop
    perform public.push_enqueue(them.user_id, 'match',
      format('match:%s:%s:%s', them.user_id, new.user_id, new.event_id),
      jsonb_build_object('name', public.push_name(new.user_id), 'title', night.title, 'url', '/night/' || night.slug));
  end loop;

  for them in
    select distinct on (second.friend) second.friend as user_id, public.push_name(first.friend) as via
    from public.push_edges first
    join public.push_edges second on second.who = first.friend
    join public.profiles p on p.id = second.friend
    where first.who = new.user_id
      and second.friend <> new.user_id
      and p.city_id = night.city_id
      -- the friend in the middle is named: not someone who keeps their keeps closed
      and public.kept_visible(first.friend)
      and not exists (select 1 from public.push_edges d where d.who = new.user_id and d.friend = second.friend)
    order by second.friend, first.friend
  loop
    perform public.push_enqueue(them.user_id, 'wave',
      format('wave:%s:%s', them.user_id, to_char(now(), 'IYYY-IW')),
      jsonb_build_object('via', them.via, 'title', night.title, 'url', '/night/' || night.slug));
  end loop;
  return new;
end;
$$;

drop trigger if exists push_swipe on public.swipes;
create trigger push_swipe
  after insert or update of direction on public.swipes
  for each row execute function public.push_on_swipe();

-- ------------------------------------------------------------ nights and rooms

-- A check-in: your room is open; friends hear you are out (when shared).
create or replace function public.push_on_checkin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  night  record;
  friend uuid;
begin
  select e.title, e.slug, v.name as venue
    into night
  from public.events e left join public.venues v on v.id = e.venue_id
  where e.id = new.event_id;

  perform public.push_enqueue(new.user_id, 'room_open', format('room_open:%s', new.id),
    jsonb_build_object('title', night.title, 'url', '/room/' || night.slug));

  if new.show_friends then
    for friend in select f.friend from public.push_edges f where f.who = new.user_id loop
      perform public.push_enqueue(friend, 'friend_live',
        format('live:%s:%s', friend, new.id),
        jsonb_build_object('name', public.push_name(new.user_id),
                           'title', coalesce(night.venue || ' · ', '') || night.title,
                           'url', '/night/' || night.slug));
    end loop;
  end if;
  return new;
end;
$$;

-- A line in a room: everyone else checked in hears it, at most once per half hour per room.
create or replace function public.push_on_room_post()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  night record;
  them  uuid;
begin
  select e.title, e.slug into night from public.events e where e.id = new.event_id;
  for them in
    select c.user_id from public.checkins c
    where c.event_id = new.event_id and c.user_id is distinct from new.user_id
  loop
    perform public.push_enqueue(them, 'room_message',
      format('room:%s:%s:%s', them, new.event_id, floor(extract(epoch from new.created_at) / 1800)),
      jsonb_build_object('name', public.push_name(new.user_id), 'title', night.title,
                         'text', left(new.body, 80), 'url', '/room/' || night.slug));
  end loop;
  return new;
end;
$$;

-- A reply to your beforehours comment.
create or replace function public.push_on_comment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent uuid;
  night  record;
begin
  if new.parent_id is null or new.is_hidden then
    return new;
  end if;
  select c.author_id into parent from public.comments c where c.id = new.parent_id;
  if parent is null or parent is not distinct from new.author_id then
    return new;
  end if;
  select e.title, e.slug into night from public.events e where e.id = new.event_id;
  perform public.push_enqueue(parent, 'reply', format('reply:%s', new.id),
    jsonb_build_object('name', coalesce(case when new.author_id is not null then public.push_name(new.author_id) end,
                                        new.author_name, 'someone'),
                       'title', night.title, 'text', left(new.body, 80), 'url', '/night/' || night.slug));
  return new;
end;
$$;

do $$ begin
  if to_regclass('public.checkins') is not null then
    drop trigger if exists push_checkin on public.checkins;
    create trigger push_checkin
      after insert on public.checkins
      for each row execute function public.push_on_checkin();
  end if;
  if to_regclass('public.room_posts') is not null then
    drop trigger if exists push_room_post on public.room_posts;
    create trigger push_room_post
      after insert on public.room_posts
      for each row execute function public.push_on_room_post();
  end if;
end $$;

drop trigger if exists push_comment on public.comments;
create trigger push_comment
  after insert on public.comments
  for each row execute function public.push_on_comment();

-- ------------------------------------------------------------ the hourly job

-- Everything that depends on the clock. p_now exists for the tests.
create or replace function public.push_hourly(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n    integer := 0;
  them record;
begin
  -- a kept night starts in two to three hours
  for them in
    select w.user_id, e.id, e.title, e.slug, e.starts_at
    from public.swipes w join public.events e on e.id = w.event_id
    where w.direction = 'right' and e.is_published and not e.starts_at_estimated
      and e.starts_at > p_now + interval '2 hours' and e.starts_at <= p_now + interval '3 hours'
  loop
    perform public.push_enqueue(them.user_id, 'night_soon', format('soon:%s:%s', them.user_id, them.id),
      jsonb_build_object('title', them.title, 'time', public.push_clock(them.user_id, them.starts_at),
                         'url', '/night/' || them.slug));
    n := n + 1;
  end loop;

  -- a room freezes within two hours
  if to_regclass('public.checkins') is not null then
    for them in execute $q$
      select c.id, c.user_id, e.title, e.slug
      from public.checkins c join public.events e on e.id = c.event_id
      where public.room_freeze_at(c.event_id) > $1 + interval '1 hour'
        and public.room_freeze_at(c.event_id) <= $1 + interval '2 hours'
    $q$ using p_now
    loop
      perform public.push_enqueue(them.user_id, 'room_closing', format('closing:%s', them.id),
        jsonb_build_object('title', them.title, 'url', '/room/' || them.slug));
      n := n + 1;
    end loop;
  end if;

  -- a followed DJ plays within the hour
  if to_regclass('public.dj_sets') is not null then
    for them in execute $q$
      select f.user_id, s.id, s.venue, s.starts_at, d.name, d.slug
      from public.dj_follows f
      join public.dj_sets s on s.dj_id = f.dj_id
      join public.djs d on d.id = f.dj_id
      where s.starts_at > $1 and s.starts_at <= $1 + interval '1 hour'
    $q$ using p_now
    loop
      perform public.push_enqueue(them.user_id, 'dj_live', format('dj:%s:%s', them.user_id, them.id),
        jsonb_build_object('name', them.name, 'where', them.venue,
                           'time', public.push_clock(them.user_id, them.starts_at), 'url', '/dj/' || them.slug));
      n := n + 1;
    end loop;
  end if;

  -- thursday 18:00 on the phone: the weekend in your city (friday 18:00 to monday 06:00)
  for them in
    with here as (
      select distinct on (k.user_id) k.user_id, k.tz from public.push_tokens k order by k.user_id, k.updated_at desc
    ),
    due as (
      select h.user_id, p.city_id, c.name as city,
             ((p_now at time zone h.tz)::date + 1 + time '18:00') at time zone h.tz as from_at,
             ((p_now at time zone h.tz)::date + 4 + time '06:00') at time zone h.tz as to_at
      from here h
      join public.profiles p on p.id = h.user_id
      join public.cities c on c.id = p.city_id
      where extract(isodow from p_now at time zone h.tz) = 4
        and extract(hour from p_now at time zone h.tz) = 18
    )
    select d.user_id, d.city,
           (select count(*)::int from public.events e
             where e.city_id = d.city_id and e.is_published and e.starts_at >= d.from_at and e.starts_at < d.to_at) as nights,
           (select count(distinct w.event_id)::int from public.swipes w
              join public.events e on e.id = w.event_id
              join public.push_edges f on f.who = d.user_id and f.friend = w.user_id
             where w.direction = 'right' and public.kept_visible(w.user_id)
               and e.city_id = d.city_id and e.starts_at >= d.from_at and e.starts_at < d.to_at) as kept
    from due d
  loop
    if them.nights > 0 then
      perform public.push_enqueue(them.user_id, 'digest', format('digest:%s:%s', them.user_id, to_char(p_now, 'IYYY-IW')),
        jsonb_build_object('city', them.city, 'n', them.nights, 'friends', them.kept, 'url', '/flow'));
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

-- ------------------------------------------------------------ the schedule

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('afterhours-push-flush')
      where exists (select 1 from cron.job where jobname = 'afterhours-push-flush');
    perform cron.unschedule('afterhours-push-hourly')
      where exists (select 1 from cron.job where jobname = 'afterhours-push-hourly');
    perform cron.schedule('afterhours-push-flush', '*/5 * * * *', $job$ select public.push_flush(); $job$);
    perform cron.schedule('afterhours-push-hourly', '0 * * * *', $job$ select public.push_hourly(); $job$);
  end if;
end
$$;

-- ------------------------------------------------------------ grants

revoke execute on function public.push_register(text, text, text, text) from public, anon;
revoke execute on function public.push_unregister(text)                  from public, anon;
grant execute on function public.push_register(text, text, text, text)  to authenticated;
grant execute on function public.push_unregister(text)                  to authenticated;

-- Everything else is for the triggers and the jobs only.
revoke execute on function public.push_name(uuid)                        from public, anon, authenticated;
revoke execute on function public.push_zone(uuid)                        from public, anon, authenticated;
revoke execute on function public.push_wants(uuid, text)                 from public, anon, authenticated;
revoke execute on function public.push_clock(uuid, timestamptz)          from public, anon, authenticated;
revoke execute on function public.push_enqueue(uuid, text, text, jsonb)  from public, anon, authenticated;
revoke execute on function public.push_send(bigint)                      from public, anon, authenticated;
revoke execute on function public.push_flush()                           from public, anon, authenticated;
revoke execute on function public.push_prune()                           from public, anon, authenticated;
revoke execute on function public.push_hourly(timestamptz)               from public, anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('26_push.sql', '3bb69fa2d92d5a3a13e8476335a8d2b63334576a944ebf6dfc9fbcac1f64336d');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('26_push.sql');
  end if;
end $$;


-- ============================================================
--  SPARKS — NIGHTS YOU START, INVITES TO FRIENDS   (27_sparks.sql)
-- ============================================================

-- afterhours — sparks: nights you start yourself
-- Every other card in the deck is a night someone else organises. A spark is
-- one nobody has organised yet: the derby at yours, a grill at the river, a
-- hike. Swiping a spark right creates it and invites friends; the invite
-- reaches them inside the app, as a card on top of their scene deck, and they
-- answer with the same swipe (right = in, left = out).
--
--   sparks          one row per plan: who hosts it, what, when, where
--   spark_invites   who was asked, and what they answered
--
-- Nobody reads or writes the tables directly (no grants, RLS on with no
-- policies). Everything goes through five definer calls that check who you are:
--
--   spark_create(kind, title, starts_at, place, invite[])   host: start one
--   spark_inbox()                                           invited: open asks
--   spark_answer(spark, answer)                             invited: in / out
--   spark_mine()                                            host: yours + answers
--   spark_cancel(spark)                                     host: call it off
--
-- Only confirmed friends can be invited; anyone else in the list is dropped
-- without a word, so the call cannot be used to find out who exists.

create table if not exists public.sparks (
  id          uuid primary key default gen_random_uuid(),
  host_id     uuid not null references public.profiles on delete cascade,
  kind        text not null check (kind in ('derby', 'grill', 'hike')),
  title       text not null check (char_length(btrim(title)) between 1 and 80),
  starts_at   timestamptz not null,
  place       text check (place is null or char_length(place) <= 80),
  created_at  timestamptz not null default now()
);
create index if not exists sparks_host_idx on public.sparks (host_id, starts_at);

create table if not exists public.spark_invites (
  spark_id     uuid not null references public.sparks on delete cascade,
  user_id      uuid not null references public.profiles on delete cascade,
  answer       text not null default 'waiting' check (answer in ('waiting', 'in', 'out')),
  answered_at  timestamptz,
  primary key (spark_id, user_id)
);
create index if not exists spark_invites_user_idx on public.spark_invites (user_id, answer);

alter table public.sparks        enable row level security;
alter table public.spark_invites enable row level security;
revoke all on public.sparks, public.spark_invites from public, anon, authenticated;

-- --------------------------------------------------------------- create

-- Returns the new id. Raises when you are signed out, the time is in the past,
-- or none of the people asked is a confirmed friend.
drop function if exists public.spark_create(text, text, timestamptz, text, uuid[]);
create or replace function public.spark_create(
  p_kind      text,
  p_title     text,
  p_starts_at timestamptz,
  p_place     text,
  p_invite    uuid[]
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  me     uuid := auth.uid();
  new_id uuid;
begin
  if me is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_starts_at is null or p_starts_at < now() - interval '1 hour' then
    raise exception 'that time has passed' using errcode = '22023';
  end if;
  if not exists (
    select 1 from unnest(coalesce(p_invite, '{}'::uuid[])) as u(id)
    where u.id <> me and public.is_friend(u.id)
  ) then
    raise exception 'invite at least one friend' using errcode = '22023';
  end if;

  insert into public.sparks (host_id, kind, title, starts_at, place)
  values (me, p_kind, btrim(p_title), p_starts_at, nullif(btrim(coalesce(p_place, '')), ''))
  returning id into new_id;

  insert into public.spark_invites (spark_id, user_id)
  select distinct new_id, u.id
  from unnest(p_invite) as u(id)
  where u.id <> me and public.is_friend(u.id);

  return new_id;
end;
$$;

-- ---------------------------------------------------------------- inbox

-- Asks you have not answered yet, for plans that have not ended (a plan counts
-- as running for six hours after it starts). Soonest first.
drop function if exists public.spark_inbox();
create or replace function public.spark_inbox()
returns table (
  id            uuid,
  kind          text,
  title         text,
  starts_at     timestamptz,
  place         text,
  host_handle   text,
  host_name     text,
  going         int
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.kind, s.title, s.starts_at, s.place, p.handle, p.display_name,
         (select count(*)::int from public.spark_invites g where g.spark_id = s.id and g.answer = 'in')
  from public.spark_invites i
  join public.sparks s on s.id = i.spark_id
  join public.profiles p on p.id = s.host_id
  where i.user_id = auth.uid()
    and i.answer = 'waiting'
    and s.starts_at > now() - interval '6 hours'
  order by s.starts_at;
$$;

-- --------------------------------------------------------------- answer

-- in or out. Answering again changes it (the deck has an undo).
drop function if exists public.spark_answer(uuid, text);
create or replace function public.spark_answer(p_spark uuid, p_answer text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if p_answer not in ('in', 'out', 'waiting') then
    raise exception 'answer is in, out or waiting' using errcode = '22023';
  end if;
  update public.spark_invites
     set answer = p_answer,
         answered_at = case when p_answer = 'waiting' then null else now() end
   where spark_id = p_spark and user_id = auth.uid();
  if not found then
    raise exception 'no such invite' using errcode = '42501';
  end if;
end;
$$;

-- ----------------------------------------------------------------- mine

-- What you host, with the answers so far. Ended plans drop off after a day.
drop function if exists public.spark_mine();
create or replace function public.spark_mine()
returns table (
  id         uuid,
  kind       text,
  title      text,
  starts_at  timestamptz,
  place      text,
  invited    int,
  going      int,
  not_going  int
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.kind, s.title, s.starts_at, s.place,
         count(i.user_id)::int,
         count(*) filter (where i.answer = 'in')::int,
         count(*) filter (where i.answer = 'out')::int
  from public.sparks s
  left join public.spark_invites i on i.spark_id = s.id
  where s.host_id = auth.uid()
    and s.starts_at > now() - interval '1 day'
  group by s.id
  order by s.starts_at;
$$;

-- --------------------------------------------------------------- cancel

drop function if exists public.spark_cancel(uuid);
create or replace function public.spark_cancel(p_spark uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  delete from public.sparks where id = p_spark and host_id = auth.uid();
  if not found then
    raise exception 'not yours' using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.spark_create(text, text, timestamptz, text, uuid[]) from public, anon;
revoke execute on function public.spark_inbox()                                       from public, anon;
revoke execute on function public.spark_answer(uuid, text)                            from public, anon;
revoke execute on function public.spark_mine()                                        from public, anon;
revoke execute on function public.spark_cancel(uuid)                                  from public, anon;
grant execute on function public.spark_create(text, text, timestamptz, text, uuid[])  to authenticated;
grant execute on function public.spark_inbox()                                        to authenticated;
grant execute on function public.spark_answer(uuid, text)                             to authenticated;
grant execute on function public.spark_mine()                                         to authenticated;
grant execute on function public.spark_cancel(uuid)                                   to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('27_sparks.sql', '27cfc3c6b692e2e458aad2c909c131e233de71539ebf53312fa972d00a981ffb');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('27_sparks.sql');
  end if;
end $$;


-- ============================================================
--  SPARKS REACH A WAVE — FRIENDS, THEIR FRIENDS, ONE STEP FURTHER   (28_spark_waves.sql)
-- ============================================================

-- afterhours — sparks reach a wave, not a list
-- 27 sent a spark to the friends the host ticked one by one. Now the host picks
-- how far it travels, the same three waves the yours tab already speaks of:
--
--   1st wave   your friends
--   2nd wave   and their friends
--   3rd wave   one step further
--
-- Everyone inside the wave finds the spark in their spark panel and answers it
-- with the same swipe (right = in, left = out). Nobody is written down in
-- advance: an answer row appears the moment someone answers. Sparks made the
-- old way (27, a ticked list) keep working: their invite rows are still read.
--
--   spark_audience()                                    how many people each wave holds
--   spark_create(kind, title, starts_at, place, reach)  start one for a wave (no list)
--   spark_inbox()                                       + reach-based sparks, + wave
--   spark_answer(spark, answer)                         also for someone inside the wave
--   spark_mine()                                        + reach
--
-- The wave is counted from the person looking, over CONFIRMED friendships only,
-- and only ever up to three steps.

alter table public.sparks add column if not exists reach smallint;
alter table public.sparks drop constraint if exists sparks_reach_range;
alter table public.sparks add constraint sparks_reach_range check (reach is null or reach between 1 and 3);

-- ------------------------------------------------------------ the waves

-- Everyone within three confirmed steps of you, with the fewest steps it takes.
-- You are not in it.
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
  select person, min(hops)::int from walk where person <> p_me group by person;
$$;
revoke execute on function public.spark_waves(uuid) from public, anon, authenticated;

-- How many people each wave reaches, counted up (the 2nd includes the 1st).
create or replace function public.spark_audience()
returns table (wave1 int, wave2 int, wave3 int)
language sql
stable
security definer
set search_path = public
as $$
  select count(*) filter (where hops <= 1)::int,
         count(*) filter (where hops <= 2)::int,
         count(*)::int
  from public.spark_waves(auth.uid());
$$;

-- --------------------------------------------------------------- create

-- One press: no list, a wave. Works with nobody in it yet (it waits for them).
drop function if exists public.spark_create(text, text, timestamptz, text, int);
create or replace function public.spark_create(
  p_kind      text,
  p_title     text,
  p_starts_at timestamptz,
  p_place     text,
  p_reach     int
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  me     uuid := auth.uid();
  new_id uuid;
begin
  if me is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_starts_at is null or p_starts_at < now() - interval '1 hour' then
    raise exception 'that time has passed' using errcode = '22023';
  end if;
  if p_reach is null or p_reach not between 1 and 3 then
    raise exception 'the wave is 1, 2 or 3' using errcode = '22023';
  end if;
  insert into public.sparks (host_id, kind, title, starts_at, place, reach)
  values (me, p_kind, btrim(p_title), p_starts_at, nullif(btrim(coalesce(p_place, '')), ''), p_reach)
  returning id into new_id;
  return new_id;
end;
$$;

-- ---------------------------------------------------------------- inbox

-- Open sparks for you: ticked for you (27) and not answered, or inside the
-- wave of a spark and not answered. wave = how many steps the host is from you
-- (null when you were ticked by name). Soonest first.
drop function if exists public.spark_inbox();
create or replace function public.spark_inbox()
returns table (
  id            uuid,
  kind          text,
  title         text,
  starts_at     timestamptz,
  place         text,
  host_handle   text,
  host_name     text,
  going         int,
  wave          int
)
language sql
stable
security definer
set search_path = public
as $$
  with near as (select person, hops from public.spark_waves(auth.uid()))
  select s.id, s.kind, s.title, s.starts_at, s.place, p.handle, p.display_name,
         (select count(*)::int from public.spark_invites g where g.spark_id = s.id and g.answer = 'in'),
         n.hops
  from public.sparks s
  join public.profiles p on p.id = s.host_id
  left join near n on n.person = s.host_id
  left join public.spark_invites i on i.spark_id = s.id and i.user_id = auth.uid()
  where auth.uid() is not null
    and s.host_id <> auth.uid()
    and s.starts_at > now() - interval '6 hours'
    and (
      (i.user_id is not null and i.answer = 'waiting')
      or (i.user_id is null and s.reach is not null and n.hops <= s.reach)
    )
  order by s.starts_at;
$$;

-- --------------------------------------------------------------- answer

-- in / out / waiting (undo). Someone inside the wave gets their answer row now.
drop function if exists public.spark_answer(uuid, text);
create or replace function public.spark_answer(p_spark uuid, p_answer text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if p_answer not in ('in', 'out', 'waiting') then
    raise exception 'answer is in, out or waiting' using errcode = '22023';
  end if;
  update public.spark_invites
     set answer = p_answer,
         answered_at = case when p_answer = 'waiting' then null else now() end
   where spark_id = p_spark and user_id = me;
  if found then
    return;
  end if;
  if exists (
    select 1 from public.sparks s
    join public.spark_waves(me) w on w.person = s.host_id
    where s.id = p_spark and s.reach is not null and w.hops <= s.reach and s.host_id <> me
  ) then
    insert into public.spark_invites (spark_id, user_id, answer, answered_at)
    values (p_spark, me, p_answer, case when p_answer = 'waiting' then null else now() end);
    return;
  end if;
  raise exception 'no such invite' using errcode = '42501';
end;
$$;

-- ----------------------------------------------------------------- mine

drop function if exists public.spark_mine();
create or replace function public.spark_mine()
returns table (
  id         uuid,
  kind       text,
  title      text,
  starts_at  timestamptz,
  place      text,
  reach      int,
  invited    int,
  going      int,
  not_going  int
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.kind, s.title, s.starts_at, s.place, s.reach::int,
         count(i.user_id)::int,
         count(*) filter (where i.answer = 'in')::int,
         count(*) filter (where i.answer = 'out')::int
  from public.sparks s
  left join public.spark_invites i on i.spark_id = s.id
  where s.host_id = auth.uid()
    and s.starts_at > now() - interval '1 day'
  group by s.id
  order by s.starts_at;
$$;

revoke execute on function public.spark_audience()                                  from public, anon;
revoke execute on function public.spark_create(text, text, timestamptz, text, int)  from public, anon;
revoke execute on function public.spark_inbox()                                     from public, anon;
revoke execute on function public.spark_answer(uuid, text)                          from public, anon;
revoke execute on function public.spark_mine()                                      from public, anon;
grant execute on function public.spark_audience()                                   to authenticated;
grant execute on function public.spark_create(text, text, timestamptz, text, int)   to authenticated;
grant execute on function public.spark_inbox()                                      to authenticated;
grant execute on function public.spark_answer(uuid, text)                           to authenticated;
grant execute on function public.spark_mine()                                       to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('28_spark_waves.sql', '06299f66604c846e9f1257e5f57b60e557112216921aa35615c8cf1bf0af0821');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('28_spark_waves.sql');
  end if;
end $$;


-- ============================================================
--  MORE OF YOU — LONGER BIO, ABOUT, LINKS TO OTHER NETWORKS   (29_profile_more.sql)
-- ============================================================

-- afterhours — more of you on your page: a longer bio, a text about you,
-- and where else to find you
--
--   bio            the line under your name: 160 → 300 characters
--   about          new: a longer text about you, up to 1500 characters
--   profile_links  new: instagram · tiktok · spotify · soundcloud · x · website
--
-- Who sees what:
--   bio, about     whoever can see your card (12: you, friends, and, unless
--                  discoverable is off, anyone who has your handle)
--   links          you and your CONFIRMED friends only. A handle on another
--                  network is a way to reach you, so it is kept closer.
--
-- The links table is closed (RLS on, no policies, no grants); it is read and
-- written only through the calls below.
--
--   profile_about_set(about)          write your text (empty clears it)
--   profile_links_set(links jsonb)    {"instagram": "name", ...}; empty clears one
--   profile_extra(handle)             about + links for a page; null = you

alter table public.profiles add column if not exists about text;
alter table public.profiles drop constraint if exists profiles_about_length;
alter table public.profiles add constraint profiles_about_length
  check (about is null or length(btrim(about)) between 1 and 1500);

alter table public.profiles drop constraint if exists profiles_bio_length;
alter table public.profiles add constraint profiles_bio_length
  check (bio is null or length(btrim(bio)) between 1 and 300);

create table if not exists public.profile_links (
  user_id     uuid not null references public.profiles on delete cascade,
  kind        text not null check (kind in ('instagram', 'tiktok', 'spotify', 'soundcloud', 'x', 'website')),
  value       text not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, kind),
  -- a name on the network, or for website a full address
  constraint profile_links_value check (
    (kind = 'website' and value ~ '^https?://[^[:space:]]{3,200}$')
    or (kind <> 'website' and value ~ '^[A-Za-z0-9._-]{1,40}$')
  )
);
alter table public.profile_links enable row level security;
revoke all on public.profile_links from public, anon, authenticated;

-- ------------------------------------------------------------------ write

drop function if exists public.profile_about_set(text);
create or replace function public.profile_about_set(p_about text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  update public.profiles set about = nullif(btrim(coalesce(p_about, '')), '') where id = auth.uid();
end;
$$;

-- Every kind present in p_links is set (or cleared when empty); kinds that are
-- not mentioned stay as they are. A leading @ is dropped. Returns ok, or
-- format:<kind> for the first value that does not fit (nothing is written then).
drop function if exists public.profile_links_set(jsonb);
create or replace function public.profile_links_set(p_links jsonb)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  k text;
  v text;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_links is null or jsonb_typeof(p_links) <> 'object' then
    return 'format';
  end if;
  for k, v in select key, btrim(coalesce(value, '')) from jsonb_each_text(p_links) loop
    if k not in ('instagram', 'tiktok', 'spotify', 'soundcloud', 'x', 'website') then
      return 'format:' || k;
    end if;
    if k <> 'website' then
      v := regexp_replace(v, '^@+', '');
    end if;
    if v <> '' and not (
      (k = 'website' and v ~ '^https?://[^[:space:]]{3,200}$')
      or (k <> 'website' and v ~ '^[A-Za-z0-9._-]{1,40}$')
    ) then
      return 'format:' || k;
    end if;
  end loop;

  for k, v in select key, btrim(coalesce(value, '')) from jsonb_each_text(p_links) loop
    if k <> 'website' then
      v := regexp_replace(v, '^@+', '');
    end if;
    if v = '' then
      delete from public.profile_links where user_id = auth.uid() and kind = k;
    else
      insert into public.profile_links (user_id, kind, value) values (auth.uid(), k, v)
      on conflict (user_id, kind) do update set value = excluded.value, updated_at = now();
    end if;
  end loop;
  return 'ok';
end;
$$;

-- ------------------------------------------------------------------- read

-- about: null when the card is not visible to you (or empty).
-- links: {} when you are not a confirmed friend (or there are none).
drop function if exists public.profile_extra(text);
create or replace function public.profile_extra(p_handle text default null)
returns table (about text, links jsonb)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  target uuid;
begin
  if auth.uid() is null then
    return;
  end if;
  if p_handle is null then
    target := auth.uid();
  else
    select p.id into target from public.profiles p where p.handle = lower(btrim(regexp_replace(p_handle, '^@', '')));
  end if;
  if target is null or not public.card_visible(target) then
    return;
  end if;
  return query
    select p.about,
           case when target = auth.uid() or public.is_friend(target)
                then coalesce((select jsonb_object_agg(l.kind, l.value) from public.profile_links l where l.user_id = target), '{}'::jsonb)
                else '{}'::jsonb end
    from public.profiles p where p.id = target;
end;
$$;

revoke execute on function public.profile_about_set(text)  from public, anon;
revoke execute on function public.profile_links_set(jsonb) from public, anon;
revoke execute on function public.profile_extra(text)      from public, anon;
grant execute on function public.profile_about_set(text)   to authenticated;
grant execute on function public.profile_links_set(jsonb)  to authenticated;
grant execute on function public.profile_extra(text)       to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('29_profile_more.sql', '26a155be94d9d4347110e4a0585f9fe7fc2425f58fb2b251d8e35e69b696e84a');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('29_profile_more.sql');
  end if;
end $$;


-- ============================================================
--  SPARKS ON THE MAP — A SPOT, BLURRED FOR STRANGERS   (30_spark_map.sql)
-- ============================================================

-- afterhours — sparks on the map
-- A spark now has a spot: where the host was when they created it (the app
-- sends its position). The map shows the sparks you are allowed to see as
-- their own kind of mark, and a tap opens the spark like a night.
--
--   spark_create(…, reach, lat, lng)   27/28 create plus the spot
--   sparks_near(lat, lng, km)          the sparks around a point that you can see
--   spark_get(spark)                   one spark, for its page
--
-- Who can see a spark: its host, the people ticked by name (27), and everyone
-- inside its wave (28). A spot is often a home, so it is blurred for people who
-- are not the host or a confirmed friend of the host: rounded to two decimals,
-- about a kilometre.

alter table public.sparks add column if not exists lat double precision;
alter table public.sparks add column if not exists lng double precision;
alter table public.sparks drop constraint if exists sparks_spot;
alter table public.sparks add constraint sparks_spot check (
  (lat is null and lng is null)
  or (lat between -90 and 90 and lng between -180 and 180)
);
create index if not exists sparks_spot_idx on public.sparks (lat, lng) where lat is not null;

-- --------------------------------------------------------------- create

drop function if exists public.spark_create(text, text, timestamptz, text, int, double precision, double precision);
create or replace function public.spark_create(
  p_kind      text,
  p_title     text,
  p_starts_at timestamptz,
  p_place     text,
  p_reach     int,
  p_lat       double precision,
  p_lng       double precision
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  new_id uuid;
begin
  new_id := public.spark_create(p_kind, p_title, p_starts_at, p_place, p_reach);
  if p_lat is not null and p_lng is not null then
    update public.sparks set lat = p_lat, lng = p_lng where id = new_id;
  end if;
  return new_id;
end;
$$;

-- ----------------------------------------------------------------- read

-- Every spark you can see that has not ended, with your answer and the spot
-- (blurred unless you are the host or a friend of the host).
create or replace function public.spark_rows()
returns table (
  id          uuid,
  kind        text,
  title       text,
  starts_at   timestamptz,
  place       text,
  host_handle text,
  host_name   text,
  going       int,
  wave        int,
  mine        boolean,
  my_answer   text,
  lat         double precision,
  lng         double precision
)
language sql
stable
security definer
set search_path = public
as $$
  with near as (select person, hops from public.spark_waves(auth.uid()))
  select s.id, s.kind, s.title, s.starts_at, s.place, p.handle, p.display_name,
         (select count(*)::int from public.spark_invites g where g.spark_id = s.id and g.answer = 'in'),
         n.hops,
         s.host_id = auth.uid(),
         i.answer,
         case when s.host_id = auth.uid() or n.hops = 1 then s.lat else round(s.lat::numeric, 2)::double precision end,
         case when s.host_id = auth.uid() or n.hops = 1 then s.lng else round(s.lng::numeric, 2)::double precision end
  from public.sparks s
  join public.profiles p on p.id = s.host_id
  left join near n on n.person = s.host_id
  left join public.spark_invites i on i.spark_id = s.id and i.user_id = auth.uid()
  where auth.uid() is not null
    and s.starts_at > now() - interval '6 hours'
    and (s.host_id = auth.uid()
         or i.user_id is not null
         or (s.reach is not null and n.hops <= s.reach));
$$;
revoke execute on function public.spark_rows() from public, anon, authenticated;

drop function if exists public.sparks_near(double precision, double precision, double precision);
create or replace function public.sparks_near(p_lat double precision, p_lng double precision, p_km double precision default 3)
returns table (
  id          uuid,
  kind        text,
  title       text,
  starts_at   timestamptz,
  place       text,
  host_handle text,
  host_name   text,
  going       int,
  wave        int,
  mine        boolean,
  my_answer   text,
  lat         double precision,
  lng         double precision,
  distance_km double precision
)
language sql
stable
security definer
set search_path = public
as $$
  select * from (
    select r.*,
           2 * 6371.0 * asin(sqrt(
             power(sin(radians(r.lat - p_lat) / 2), 2)
             + cos(radians(p_lat)) * cos(radians(r.lat))
             * power(sin(radians(r.lng - p_lng) / 2), 2))) as distance_km
    from public.spark_rows() r
    where r.lat is not null
  ) x
  where x.distance_km <= least(greatest(coalesce(p_km, 3), 0.1), 60)
  order by x.distance_km
  limit 100;
$$;

drop function if exists public.spark_get(uuid);
create or replace function public.spark_get(p_spark uuid)
returns table (
  id          uuid,
  kind        text,
  title       text,
  starts_at   timestamptz,
  place       text,
  host_handle text,
  host_name   text,
  going       int,
  wave        int,
  mine        boolean,
  my_answer   text,
  lat         double precision,
  lng         double precision
)
language sql
stable
security definer
set search_path = public
as $$
  select * from public.spark_rows() r where r.id = p_spark;
$$;

revoke execute on function public.spark_create(text, text, timestamptz, text, int, double precision, double precision) from public, anon;
revoke execute on function public.sparks_near(double precision, double precision, double precision)                   from public, anon;
revoke execute on function public.spark_get(uuid)                                                                      from public, anon;
grant execute on function public.spark_create(text, text, timestamptz, text, int, double precision, double precision)  to authenticated;
grant execute on function public.sparks_near(double precision, double precision, double precision)                    to authenticated;
grant execute on function public.spark_get(uuid)                                                                       to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('30_spark_map.sql', 'bd78b55bbfa774153349f89e8f3918e726f53e1b223c17d24b9d93387f42e601');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('30_spark_map.sql');
  end if;
end $$;


-- ============================================================
--  THE PAST FEED — PHOTOS OF NIGHTS THAT HAPPENED   (31_past_feed.sql)
-- ============================================================

-- afterhours — the past feed: photos of nights that already happened
-- The bottom of the yours tab is an endless feed, newest first, of past nights:
-- every past night in your city that has a photograph, plus any past night
-- (anywhere) where you or a friend checked in or kept it. Those carry who was
-- there. It is read a page at a time: the app passes the date of the last card
-- it has and gets the next ones.
--
--   past_feed(city, before, before_id, limit)   before + before_id: the last card you have
--
-- Who is named: you, and confirmed friends whose check-in shows to friends
-- (19, show_friends) or who kept the night and keep their kept nights visible
-- (12, kept_visible). Signed out: the nights only, nobody named.
-- Past nights are unpublished by the nightly job (09) but the rows stay; this
-- call reads them, so the feed reaches back a year.

drop function if exists public.past_feed(text, timestamptz, int);
drop function if exists public.past_feed(text, timestamptz, uuid, int);
create or replace function public.past_feed(
  p_city   text default null,
  p_before    timestamptz default null,
  p_before_id uuid default null,
  p_limit     int default 12
)
returns table (
  id          uuid,
  slug        text,
  title       text,
  image_url   text,
  venue_name  text,
  city_name   text,
  type_slug   text,
  type_name   text,
  starts_at   timestamptz,
  people      text[],
  mine        boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with circle as (
    select case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end as id
    from public.friendships f
    where f.status = 'accepted' and auth.uid() in (f.requester_id, f.addressee_id)
  ),
  -- who of yours was there, per night: checked in (shown to friends) or kept it
  went as (
    select c.event_id, c.user_id, c.checked_at as at
    from public.checkins c
    where c.user_id = auth.uid()
       or (c.show_friends and c.user_id in (select id from circle))
    union
    select s.event_id, s.user_id, s.created_at
    from public.swipes s
    where s.direction = 'right'
      and (s.user_id = auth.uid() or (s.user_id in (select id from circle) and public.kept_visible(s.user_id)))
  ),
  named as (
    select w.event_id,
           array_agg(distinct lower(coalesce(p.handle, p.display_name, 'someone'))) filter (where w.user_id <> auth.uid()) as people,
           bool_or(w.user_id = auth.uid()) as mine
    from went w
    join public.profiles p on p.id = w.user_id
    group by w.event_id
  )
  select e.id, e.slug, e.title, e.image_url, v.name, ci.name, t.slug, t.name, e.starts_at,
         coalesce(n.people, '{}'), coalesce(n.mine, false)
  from public.events e
  join public.event_types t on t.id = e.type_id
  join public.cities ci on ci.id = e.city_id
  left join public.venues v on v.id = e.venue_id
  left join named n on n.event_id = e.id
  where e.starts_at is not null
    and e.starts_at < now()
    and e.starts_at > now() - interval '365 days'
    and (p_before is null or e.starts_at < p_before
         or (e.starts_at = p_before and p_before_id is not null and e.id > p_before_id))
    and e.image_url is not null
    and (ci.slug = p_city or n.event_id is not null)
  order by e.starts_at desc, e.id
  limit least(greatest(coalesce(p_limit, 12), 1), 30);
$$;

revoke execute on function public.past_feed(text, timestamptz, uuid, int) from public;
grant execute on function public.past_feed(text, timestamptz, uuid, int) to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('31_past_feed.sql', 'bb1fa6b0708e370eaa850822fd850d3b9fb04cb3b663cd8bba3bd1d62957d693');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('31_past_feed.sql');
  end if;
end $$;


-- ============================================================
--  WHO IS COMING — IN, MAYBE, OUT, FOR FRIENDS   (32_rsvp.sql)
-- ============================================================

-- afterhours — who is coming: your answer to a night, seen by your friends
-- "who is coming?" on yours asks in · maybe · out. Until now the answer stayed on
-- the phone; here it is stored, and your confirmed friends see it next to your
-- face (and you see theirs).
--
--   rsvp_set(event, answer)   in · maybe · out; null or empty takes it back
--   rsvp_for(events[])        the answers of you and your friends for these nights
--
-- The table is closed (RLS on, no policies, no grants). Answers are for
-- friends only: nobody else can read them, not even who answered at all.

create table if not exists public.rsvps (
  user_id     uuid not null references public.profiles on delete cascade,
  event_id    uuid not null references public.events on delete cascade,
  answer      text not null check (answer in ('in', 'maybe', 'out')),
  updated_at  timestamptz not null default now(),
  primary key (user_id, event_id)
);
create index if not exists rsvps_event_idx on public.rsvps (event_id);
alter table public.rsvps enable row level security;
revoke all on public.rsvps from public, anon, authenticated;

drop function if exists public.rsvp_set(uuid, text);
create or replace function public.rsvp_set(p_event uuid, p_answer text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if coalesce(p_answer, '') = '' then
    delete from public.rsvps where user_id = auth.uid() and event_id = p_event;
    return;
  end if;
  if p_answer not in ('in', 'maybe', 'out') then
    raise exception 'answer is in, maybe or out' using errcode = '22023';
  end if;
  if not exists (select 1 from public.events where id = p_event) then
    raise exception 'no such night' using errcode = '22023';
  end if;
  insert into public.rsvps (user_id, event_id, answer) values (auth.uid(), p_event, p_answer)
  on conflict (user_id, event_id) do update set answer = excluded.answer, updated_at = now();
end;
$$;

-- name: handle, else the display name (the same key friends_kept uses).
drop function if exists public.rsvp_for(uuid[]);
create or replace function public.rsvp_for(p_events uuid[])
returns table (event_id uuid, user_id uuid, name text, answer text, mine boolean)
language sql
stable
security definer
set search_path = public
as $$
  select r.event_id, r.user_id, lower(coalesce(p.handle, p.display_name, 'someone')), r.answer, r.user_id = auth.uid()
  from public.rsvps r
  join public.profiles p on p.id = r.user_id
  where auth.uid() is not null
    and r.event_id = any (coalesce(p_events, '{}'))
    and (r.user_id = auth.uid() or public.is_friend(r.user_id))
  order by r.event_id, (r.answer = 'in') desc, (r.answer = 'maybe') desc, r.updated_at desc;
$$;

revoke execute on function public.rsvp_set(uuid, text) from public, anon;
revoke execute on function public.rsvp_for(uuid[])    from public, anon;
grant execute on function public.rsvp_set(uuid, text) to authenticated;
grant execute on function public.rsvp_for(uuid[])     to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('32_rsvp.sql', 'fc4b2a54d1022c7c69ee67d70656026c078cf9cc2dfcc8b280a371ad5dd133e1');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('32_rsvp.sql');
  end if;
end $$;


-- ============================================================
--  THE WAVES — NIGHTS KEPT BY FRIENDS OF FRIENDS   (33_waves.sql)
-- ============================================================

-- afterhours — the waves on yours: nights kept beyond your friends
-- yours has shown two decks above the friends deck with sample cards only:
--
--   2nd wave   nights kept by friends of your friends
--   3rd wave   one step further
--
-- This is the real thing. The walk goes over CONFIRMED friendships only, at
-- most three steps, and keeps the shortest chain to each person, so a card can
-- say who it came through ("you — lina — tarık"). Your own friends are not in
-- it: their keeps are the friends deck already.
--
-- What it shows of someone you do not know: their handle (else their name) and
-- that they kept a night that is still to come. Nothing at all of a person who
-- set kept_visibility to private (12) — and such a person does not carry the
-- chain either, so nobody is named "via" someone who keeps their keeps closed.
--
--   waves_kept(limit)   upcoming nights kept in the 2nd and 3rd wave

-- Everyone within three confirmed steps, the shortest chain to each, starting
-- after you: path[1] is your friend, the last name is the person. Not callable
-- from the app.
create or replace function public.wave_paths(p_me uuid)
returns table (person uuid, hops int, path uuid[])
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
  walk(person, hops, path) as (
    select b, 1, array[b] from f where a = p_me
    union all
    select f.b, w.hops + 1, w.path || f.b
    from walk w join f on f.a = w.person
    where w.hops < 3 and f.b <> p_me and not f.b = any (w.path)
  )
  select distinct on (person) person, hops, path
  from walk
  order by person, hops, path;
$$;
revoke execute on function public.wave_paths(uuid) from public, anon, authenticated;

drop function if exists public.waves_kept(int);
create or replace function public.waves_kept(p_limit int default 80)
returns table (
  wave        int,
  via         text[],
  kept_at     timestamptz,
  id          uuid,
  slug        text,
  title       text,
  poster_no   int,
  type_name   text,
  venue_name  text,
  city_slug   text,
  starts_at   timestamptz,
  image_url   text,
  ticket_url  text
)
language sql
stable
security definer
set search_path = public
as $$
  with near as (
    select w.person, w.hops, w.path
    from public.wave_paths(auth.uid()) w
    where w.hops between 2 and 3
      -- everyone on the chain keeps their keeps open
      and not exists (
        select 1 from unnest(w.path) as link(id)
        where not public.kept_visible(link.id)
      )
  )
  select n.hops,
         array(select coalesce(p.handle, p.display_name, 'someone')
               from unnest(n.path) with ordinality as link(id, i)
               join public.profiles p on p.id = link.id
               order by link.i),
         s.created_at,
         e.id, e.slug, e.title, e.poster_no, e.type_name, e.venue_name,
         e.city_slug, e.starts_at, e.image_url, e.ticket_url
  from near n
  join public.swipes s on s.user_id = n.person and s.direction = 'right'
  join public.events_public e on e.id = s.event_id
  where auth.uid() is not null
    and e.starts_at > now() - interval '6 hours'
  order by e.starts_at, n.hops, s.created_at desc
  limit greatest(1, least(coalesce(p_limit, 80), 200));
$$;

revoke execute on function public.waves_kept(int) from public, anon;
grant execute on function public.waves_kept(int) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('33_waves.sql', '414c1cc87d464508f0d618ae209261c4a04a74defe6b76902f938e8bca6b0d4c');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('33_waves.sql');
  end if;
end $$;


-- ============================================================
--  SPARKS SAY SO — A PUSH WHEN ONE REACHES YOU, AND WHEN SOMEONE IS IN   (34_spark_push.sql)
-- ============================================================

-- afterhours — sparks say so: a push when one reaches you, and when someone is in
-- The kinds, their words and the switch (notify_sparks) are in 26_push.sql; this
-- file only adds the triggers, because the sparks themselves come later (27, 28).
--
--   spark      a spark reaches you: you were ticked by name (27), or you are
--              inside the wave it was started for (28). Opens its page.
--   spark_in   someone answered "in" to a spark you started.
--
-- Each goes out once per spark and person (the outbox key), follows the
-- switch, and waits for 09:00 in quiet hours like a friend request does.
-- A wave can be large: the 2nd and 3rd wave count against the same ten a day
-- as the other discovery kinds; the 1st wave (your friends) always goes.

-- Pasted on its own (without 26 again) it must still work: the switch and the
-- two kinds are made sure of here too, and a push that fails never stops the
-- spark or the answer that caused it.
alter table public.profile_settings add column if not exists notify_sparks boolean not null default true;
alter table public.push_outbox drop constraint if exists push_outbox_kind_check;
alter table public.push_outbox add constraint push_outbox_kind_check check (kind in (
  'friend_request', 'friend_accepted', 'match', 'friend_live',
  'night_soon', 'room_open', 'room_closing', 'room_message', 'reply',
  'digest', 'dj_live', 'wave', 'spark', 'spark_in'));

-- "fri 22:00", in the zone of the phone of the person.
create or replace function public.push_when(p_user uuid, p_at timestamptz)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select lower(to_char(p_at at time zone public.push_zone(p_user), 'Dy HH24:MI'));
$$;

create or replace function public.push_spark_to(p_user uuid, p_spark public.sparks, p_wave int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user = p_spark.host_id then
    return;
  end if;
  if coalesce(p_wave, 1) > 1
     and (select count(*) from public.push_outbox o
          where o.user_id = p_user and o.created_at > now() - interval '1 day'
            and o.kind in ('room_message', 'digest', 'dj_live', 'wave', 'spark')) >= 10 then
    return;
  end if;
  perform public.push_enqueue(p_user, 'spark',
    format('spark:%s:%s', p_spark.id, p_user),
    jsonb_build_object(
      'name',  public.push_name(p_spark.host_id),
      'title', p_spark.title,
      'when',  public.push_when(p_user, p_spark.starts_at),
      'url',   format('/spark/%s?invite=%s', p_spark.kind, p_spark.id)));
end;
$$;
revoke execute on function public.push_spark_to(uuid, public.sparks, int) from public, anon, authenticated;

-- A spark for a wave: everyone inside it, at the moment it is started.
create or replace function public.push_on_spark()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  w record;
begin
  if new.reach is null then
    return new;   -- the old way: the invite rows say who (below)
  end if;
  for w in select person, hops from public.spark_waves(new.host_id) where hops <= new.reach loop
    perform public.push_spark_to(w.person, new, w.hops);
  end loop;
  return new;
exception when others then
  raise warning 'spark push skipped: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists push_spark on public.sparks;
create trigger push_spark
  after insert on public.sparks
  for each row execute function public.push_on_spark();

-- An invite row: ticked by name (27) → "spark". An answer turning to "in" → the
-- host hears it. Rows written by someone in a wave answering are not new
-- invites: they arrive already answered.
create or replace function public.push_on_spark_invite()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.sparks;
begin
  select * into s from public.sparks where id = new.spark_id;
  if not found then
    return new;
  end if;
  if tg_op = 'INSERT' and new.answer = 'waiting' then
    perform public.push_spark_to(new.user_id, s, 1);
  end if;
  if new.answer = 'in' and (tg_op = 'INSERT' or old.answer is distinct from 'in') then
    perform public.push_enqueue(s.host_id, 'spark_in',
      format('spark_in:%s:%s', s.id, new.user_id),
      jsonb_build_object(
        'name',  public.push_name(new.user_id),
        'title', s.title,
        'url',   '/account'));
  end if;
  return new;
exception when others then
  raise warning 'spark push skipped: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists push_spark_invite on public.spark_invites;
create trigger push_spark_invite
  after insert or update of answer on public.spark_invites
  for each row execute function public.push_on_spark_invite();

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('34_spark_push.sql', 'f56eac9a17c399e886530487d5bc7b7351bb107f7cce550591559202a2bbdc65');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('34_spark_push.sql');
  end if;
end $$;


-- ============================================================
--  WHO ANSWERED A SPARK — NAMES FOR THE HOST AND FOR WHOEVER IS IN   (35_spark_people.sql)
-- ============================================================

-- afterhours — who answered a spark, by name
-- spark_mine (27, 28) counts the answers; the host could not see WHO. Now:
--
--   spark_people(spark)   names and answers (in first), newest answer first
--
-- Read by the host, and by anyone who is in themselves (people going to the
-- same thing may know who else is going). Someone who said out sees nothing;
-- an unanswered invite is not listed. The name is the handle, else the
-- display name, as everywhere.

create or replace function public.spark_people(p_spark uuid)
returns table (name text, answer text, answered_at timestamptz, me boolean)
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p.handle, p.display_name, 'someone'), i.answer, i.answered_at, i.user_id = auth.uid()
  from public.spark_invites i
  join public.profiles p on p.id = i.user_id
  join public.sparks s on s.id = i.spark_id
  where i.spark_id = p_spark
    and i.answer in ('in', 'out')
    and auth.uid() is not null
    and (
      s.host_id = auth.uid()
      or exists (select 1 from public.spark_invites m
                 where m.spark_id = p_spark and m.user_id = auth.uid() and m.answer = 'in')
    )
    -- someone who is in sees the others who are in, not who said no
    and (s.host_id = auth.uid() or i.answer = 'in')
  order by (i.answer = 'in') desc, i.answered_at desc nulls last;
$$;

revoke execute on function public.spark_people(uuid) from public, anon;
grant execute on function public.spark_people(uuid) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('35_spark_people.sql', '796468d9e9f4598be3cb72f4610369a1866c08b105699e1855a4ef9fc8fb37fb');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('35_spark_people.sql');
  end if;
end $$;


-- ============================================================
--  THE COLLECTION OF A FRIEND, ON THEIR PROFILE   (36_person_cards.sql)
-- ============================================================

-- afterhours — the collection of someone else, for their profile page
-- my_cards (19) is yours only. Now:
--
--   person_cards(handle)   their cards, newest first, same shape as my_cards
--
-- Friends only (and you): the check-ins of a stranger say where they were, so
-- nobody else gets a row. The room lines and crew initials are the same
-- ones the owner sees on their own card.

drop function if exists public.person_cards(text);
create or replace function public.person_cards(p_handle text)
returns table (
  card_no     bigint,
  checked_at  timestamptz,
  freeze_at   timestamptz,
  frozen      boolean,
  slug        text,
  title       text,
  type_name   text,
  venue_name  text,
  city_name   text,
  starts_at   timestamptz,
  image_url   text,
  crew        text[],
  crew_more   int,
  who_count   int,
  post_count  int,
  q1_body     text,
  q1_who      text,
  q1_at       timestamptz,
  q2_body     text,
  q2_who      text,
  q2_at       timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with target as (
    select p.id from public.profiles p
    where p.handle = lower(btrim(p_handle))
      and (p.id = auth.uid() or public.is_friend(p.id))
  ),
  mine as (
    select c.*, public.room_freeze_at(c.event_id) as freeze_at
    from public.checkins c where c.user_id = (select id from target)
  ),
  others as (
    select c.event_id,
           array_agg(lower(left(coalesce(p.display_name, p.handle, 's'), 1)) order by c.checked_at) as initials,
           count(*)::int as n
    from public.checkins c
    join public.profiles p on p.id = c.user_id
    where c.user_id <> (select id from target) and c.event_id in (select event_id from mine)
    group by c.event_id
  ),
  posts as (
    select r.event_id, r.body, lower(left(coalesce(p.display_name, p.handle, 's'), 1)) as who, r.created_at,
           row_number() over (partition by r.event_id order by r.created_at) as rn,
           count(*) over (partition by r.event_id)::int as total
    from public.room_posts r
    left join public.profiles p on p.id = r.user_id
    where r.event_id in (select event_id from mine)
  )
  select m.card_no, m.checked_at, m.freeze_at, now() >= m.freeze_at,
         e.slug, e.title, t.name, v.name, ci.name, e.starts_at, e.image_url,
         coalesce(o.initials[1:4], '{}'), greatest(coalesce(o.n, 0) - 4, 0),
         coalesce(o.n, 0) + 1,
         coalesce((select total from posts p where p.event_id = m.event_id limit 1), 0),
         (select body from posts p where p.event_id = m.event_id and rn = 1),
         (select who  from posts p where p.event_id = m.event_id and rn = 1),
         (select created_at from posts p where p.event_id = m.event_id and rn = 1),
         (select body from posts p where p.event_id = m.event_id and rn = 2),
         (select who  from posts p where p.event_id = m.event_id and rn = 2),
         (select created_at from posts p where p.event_id = m.event_id and rn = 2)
  from mine m
  join public.events e on e.id = m.event_id
  join public.event_types t on t.id = e.type_id
  join public.cities ci on ci.id = e.city_id
  left join public.venues v on v.id = e.venue_id
  left join others o on o.event_id = m.event_id
  order by m.checked_at desc;
$$;

revoke all on function public.person_cards(text) from public, anon;
grant execute on function public.person_cards(text) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('36_person_cards.sql', '234ed583b13e73533ee052fbaff4146a65e8141ac4a2b772b80bb980c05329da');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('36_person_cards.sql');
  end if;
end $$;


-- ============================================================
--  WRITES MADE OFFLINE — A SECOND TRY CHANGES NOTHING   (37_offline.sql)
-- ============================================================

-- afterhours — writes made offline (37)
--
-- The app now keeps every write in an outbox on the phone and sends it when the
-- connection returns (app/src/lib/offline.ts). A job can go out twice: the first try
-- reaches the server but the answer is lost, so the phone tries again. Each job carries
-- an id made on the phone; with it the second try finds the first and changes nothing.
--
--   comments.client_id     a topic or reply sent twice is stored once
--   room_posts.client_id   the same for lines in a room
--   room_post(slug, body, client_id)   returns the line already stored for that id
--   check_in(slug, lat, lng, at)       at: when you pressed the button on the phone;
--                                      checked_at of the card, never in the future and
--                                      never more than 12 hours back (else now)
--
-- The freeze rule of a room still goes by the clock of the server: a line written offline
-- that arrives after the room froze is refused (the app says so).
-- Old app versions keep working: the new parameters have defaults.

-- ------------------------------------------------------------ comments

alter table public.comments add column if not exists client_id uuid;
create unique index if not exists comments_client_idx on public.comments (author_id, client_id);
grant insert (event_id, parent_id, author_id, body, client_id) on public.comments to authenticated;

-- ------------------------------------------------------------ room lines

alter table public.room_posts add column if not exists client_id uuid;
create unique index if not exists room_posts_client_idx on public.room_posts (user_id, client_id);

drop function if exists public.room_post(text, text);
drop function if exists public.room_post(text, text, uuid);
create or replace function public.room_post(p_slug text, p_body text, p_client_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  ev uuid;
  n  uuid;
begin
  if auth.uid() is null or public.is_guest() then raise exception 'signedout'; end if;
  if p_client_id is not null then
    select id into n from public.room_posts where user_id = auth.uid() and client_id = p_client_id;
    if found then return n; end if;
  end if;
  select id into ev from public.events where slug = p_slug;
  if ev is null then raise exception 'nonight'; end if;
  if not public.checked_in(ev) then raise exception 'notthere'; end if;
  if now() >= public.room_freeze_at(ev) then raise exception 'frozen'; end if;
  insert into public.room_posts (event_id, user_id, body, client_id)
  values (ev, auth.uid(), btrim(p_body), p_client_id)
  returning id into n;
  return n;
end;
$$;

-- ------------------------------------------------------------ check-in

drop function if exists public.check_in(text, double precision, double precision);
drop function if exists public.check_in(text, double precision, double precision, timestamptz);
create or replace function public.check_in(
  p_slug text,
  p_lat  double precision default null,
  p_lng  double precision default null,
  p_at   timestamptz default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  e  public.events%rowtype;
  n  bigint;
  at timestamptz := least(coalesce(p_at, now()), now());
begin
  if auth.uid() is null or public.is_guest() then raise exception 'signedout'; end if;
  select * into e from public.events where slug = p_slug and is_published;
  if not found then raise exception 'nonight'; end if;

  -- One card per person per night: a second try returns the first card.
  select card_no into n from public.checkins where user_id = auth.uid() and event_id = e.id;
  if found then return n; end if;

  if at < now() - interval '12 hours' then at := now(); end if;
  insert into public.checkins (user_id, event_id, checked_at) values (auth.uid(), e.id, at) returning card_no into n;
  return n;
end;
$$;

revoke all on function public.room_post(text, text, uuid) from public, anon;
revoke all on function public.check_in(text, double precision, double precision, timestamptz) from public, anon;
grant execute on function public.room_post(text, text, uuid) to authenticated;
grant execute on function public.check_in(text, double precision, double precision, timestamptz) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('37_offline.sql', 'c7de2e6b7ae4b4ccef3496ddce998f61bb25a3d576eb909a9505d5227ab14144');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('37_offline.sql');
  end if;
end $$;


-- ============================================================
--  WHATSAPP AMONG THE LINKS, AND THE LISTS UNDER A PROFILE   (38_profile_lists.sql)
-- ============================================================

-- afterhours — WhatsApp among the links, and the two lists under a profile (38)
--
--   profile_links  new kind: whatsapp, a phone number in digits (country code
--                  first, no plus); spaces, dashes and a leading + are dropped
--   person_kept(handle)     the nights they kept, newest first
--   person_people(handle)   their confirmed friends (handle and name)
--
-- Both lists follow the same rules as the rest of a profile: you see your own,
-- and those of your CONFIRMED friends. person_kept also needs their kept
-- nights to be visible to friends (kept_visible). Anyone else gets no rows.

-- ------------------------------------------------------------------ links

alter table public.profile_links drop constraint if exists profile_links_kind_check;
alter table public.profile_links add constraint profile_links_kind_check
  check (kind in ('instagram', 'tiktok', 'spotify', 'soundcloud', 'x', 'website', 'whatsapp'));
alter table public.profile_links drop constraint if exists profile_links_value;
alter table public.profile_links add constraint profile_links_value check (
  (kind = 'website' and value ~ '^https?://[^[:space:]]{3,200}$')
  or (kind = 'whatsapp' and value ~ '^[0-9]{6,16}$')
  or (kind not in ('website', 'whatsapp') and value ~ '^[A-Za-z0-9._-]{1,40}$')
);

-- Every kind present in p_links is set (or cleared when empty); kinds that are
-- not mentioned stay as they are. A leading @ is dropped; for whatsapp everything
-- but the digits. Returns ok, or format:<kind> for the first value that does not
-- fit (nothing is written then).
drop function if exists public.profile_links_set(jsonb);
create or replace function public.profile_links_set(p_links jsonb)
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  k text;
  v text;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_links is null or jsonb_typeof(p_links) <> 'object' then
    return 'format';
  end if;
  for k, v in select key, btrim(coalesce(value, '')) from jsonb_each_text(p_links) loop
    if k not in ('instagram', 'tiktok', 'spotify', 'soundcloud', 'x', 'website', 'whatsapp') then
      return 'format:' || k;
    end if;
    if k = 'whatsapp' then
      -- Something was typed but no digit in it: not a number (empty clears it).
      if v <> '' and v !~ '[0-9]' then
        return 'format:' || k;
      end if;
      v := regexp_replace(v, '[^0-9]', '', 'g');
    elsif k <> 'website' then
      v := regexp_replace(v, '^@+', '');
    end if;
    if v <> '' and not (
      (k = 'website' and v ~ '^https?://[^[:space:]]{3,200}$')
      or (k = 'whatsapp' and v ~ '^[0-9]{6,16}$')
      or (k not in ('website', 'whatsapp') and v ~ '^[A-Za-z0-9._-]{1,40}$')
    ) then
      return 'format:' || k;
    end if;
  end loop;

  for k, v in select key, btrim(coalesce(value, '')) from jsonb_each_text(p_links) loop
    if k = 'whatsapp' then
      v := regexp_replace(v, '[^0-9]', '', 'g');
    elsif k <> 'website' then
      v := regexp_replace(v, '^@+', '');
    end if;
    if v = '' then
      delete from public.profile_links where user_id = auth.uid() and kind = k;
    else
      insert into public.profile_links (user_id, kind, value) values (auth.uid(), k, v)
      on conflict (user_id, kind) do update set value = excluded.value, updated_at = now();
    end if;
  end loop;
  return 'ok';
end;
$$;

-- ------------------------------------------------------------------ lists

drop function if exists public.person_kept(text);
create or replace function public.person_kept(p_handle text)
returns setof public.events_public
language sql
stable
security definer
set search_path = public
as $$
  select e.*
  from public.profiles p
  join public.swipes s on s.user_id = p.id and s.direction = 'right'
  join public.events_public e on e.id = s.event_id
  where p.handle = lower(btrim(p_handle))
    and (p.id = auth.uid() or (public.is_friend(p.id) and public.kept_visible(p.id)))
  order by s.created_at desc;
$$;

drop function if exists public.person_people(text);
create or replace function public.person_people(p_handle text)
returns table (handle text, display_name text)
language sql
stable
security definer
set search_path = public
as $$
  with target as (
    select p.id from public.profiles p
    where p.handle = lower(btrim(p_handle))
      and (p.id = auth.uid() or public.is_friend(p.id))
  )
  select o.handle, o.display_name
  from public.friendships f
  join public.profiles o on o.id = case when f.requester_id = (select id from target) then f.addressee_id else f.requester_id end
  where f.status = 'accepted'
    and (f.requester_id = (select id from target) or f.addressee_id = (select id from target))
  order by coalesce(o.handle, o.display_name);
$$;

revoke all on function public.profile_links_set(jsonb) from public, anon;
revoke all on function public.person_kept(text) from public, anon;
revoke all on function public.person_people(text) from public, anon;
grant execute on function public.profile_links_set(jsonb) to authenticated;
grant execute on function public.person_kept(text) to authenticated;
grant execute on function public.person_people(text) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('38_profile_lists.sql', '8bc6454831b9aa30bc2cceb0cf760eae823442d2301a43e99ffb967b15862b2b');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('38_profile_lists.sql');
  end if;
end $$;


-- ============================================================
--  EIGHT MORE SPARKS   (39_spark_kinds.sql)
-- ============================================================

-- afterhours — eight more sparks (39)
--
-- The app has eleven sparks now (app/src/content/sparks.ts). The table only
-- took the first three: this widens the list. Nothing else changes; a kind
-- is just a word the app turns into a photo and a text.
--
--   sunrise · breakfast · rooftop · swim · quiz · newplace · camera · festival

alter table public.sparks drop constraint if exists sparks_kind_check;
alter table public.sparks add constraint sparks_kind_check check (kind in (
  'derby', 'grill', 'hike',
  'sunrise', 'breakfast', 'rooftop', 'swim', 'quiz', 'newplace', 'camera', 'festival'
));

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('39_spark_kinds.sql', 'b88ef1a1bd7de9f0c23bb2dfc0308ad085af09b40145bd109a347621933ecf92');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('39_spark_kinds.sql');
  end if;
end $$;


-- ============================================================
--  WHO IS THIS — A FEW LINES ABOUT THE ACT ON A NIGHT   (40_event_about.sql)
-- ============================================================

-- afterhours — "who is this?": a few lines about the act on a night (40)
--
-- A night card can carry a short text about who is playing: what they are, two or
-- three sentences, two facts, and where it comes from. The texts are written ahead
-- of time (from a source such as Wikipedia, summarised; never invented) and stored
-- here per night and language. A night without a row simply has no "who is this?".
--
--   event_about        one row per night and language (en · de · tr)
--   about_for(ids, lang)   the rows for these nights, in that language
--
-- Anyone may read them (they are about public nights). Only the service role
-- writes: the texts come from the sync job or from a reviewed SQL file.

create table if not exists public.event_about (
  event_id    uuid not null references public.events on delete cascade,
  lang        text not null check (lang in ('en', 'de', 'tr')),
  name        text not null,
  kicker      text not null,
  who         text,
  facts       text[] not null default '{}',
  source_url  text not null check (source_url ~ '^https://'),
  made_at     timestamptz not null default now(),
  primary key (event_id, lang)
);

alter table public.event_about enable row level security;
revoke all on public.event_about from public, anon, authenticated;

drop function if exists public.about_for(uuid[], text);
create or replace function public.about_for(p_events uuid[], p_lang text)
returns table (event_id uuid, name text, kicker text, who text, facts text[], source_url text)
language sql
stable
security definer
set search_path = public
as $$
  select a.event_id, a.name, a.kicker, a.who, a.facts, a.source_url
  from public.event_about a
  join public.events e on e.id = a.event_id and e.is_published
  where a.event_id = any(p_events)
    and a.lang = case when p_lang in ('en', 'de', 'tr') then p_lang else 'en' end;
$$;

grant execute on function public.about_for(uuid[], text) to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('40_event_about.sql', '82ae672f8c140a23ae9f8e62042e3d06125789c1f39b675e3c4804564289ffe6');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('40_event_about.sql');
  end if;
end $$;


-- ============================================================
--  ACCOUNT TYPES — USER, DJ, COMMUNITY MANAGER, ADMIN   (41_account_types.sql)
-- ============================================================

-- afterhours — account types: normal user, dj, community manager, admin (41)
--
-- Every profile carries a type, chosen in the settings of the app. Changing it takes
-- a code, and the code is the name of the type as the list shows it ("dj", "admin" …),
-- so for now it is a label, not a lock. Nothing reads it yet: no type may do
-- anything another cannot.
--
-- This "admin" is NOT profiles.is_admin. is_admin is the real one (02_rls.sql)
-- and stays where it was; no code here touches it.
--
--   profiles.account_type        user · dj · community_manager · admin
--   set_account_type(type, code) changes your own type when the code is right;
--                                returns ok · code · typeaa

alter table public.profiles add column if not exists account_type text not null default 'user';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_account_type_check') then
    alter table public.profiles add constraint profiles_account_type_check
      check (account_type in ('user', 'dj', 'community_manager', 'admin'));
  end if;
end $$;

-- A plain profile update may not change the type: only set_account_type may,
-- and it says so with a flag that lives for its own transaction only.
create or replace function public.guard_account_type()
returns trigger
language plpgsql
as $$
begin
  if new.account_type is distinct from old.account_type
     and auth.uid() is not null
     and coalesce(current_setting('afterhours.account_type', true), '') <> 'on' then
    raise exception 'account_type changes only through set_account_type';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_account_type on public.profiles;
create trigger profiles_guard_account_type
  before update on public.profiles
  for each row execute function public.guard_account_type();

create or replace function public.set_account_type(p_type text, p_code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  name text := case p_type
    when 'user' then 'normal user'
    when 'dj' then 'dj'
    when 'community_manager' then 'community manager'
    when 'admin' then 'admin'
  end;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if name is null then return 'type'; end if;
  if lower(btrim(coalesce(p_code, ''))) <> name then return 'code'; end if;
  perform set_config('afterhours.account_type', 'on', true);
  update public.profiles set account_type = p_type where id = auth.uid();
  perform set_config('afterhours.account_type', '', true);
  return 'ok';
end;
$$;

revoke all on function public.set_account_type(text, text) from public, anon;
grant execute on function public.set_account_type(text, text) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('41_account_types.sql', '48a29b4f27e4bfbc0f234c9d3ac0438a6818eccdbfb0b31d64e62931a1532c36');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('41_account_types.sql');
  end if;
end $$;


-- ============================================================
--  THE STAFF — ADMIN PANEL, COMMUNITY MANAGERS, DJ PAGES, THE LOG   (42_staff.sql)
-- ============================================================

-- afterhours — the staff: admin, community managers, djs who run their own page (42)
--
-- 41 gave every profile a type as a label. Here the types start to mean something:
--
--   normal user        as before.
--   dj                 opens and edits one dj page of their own, and lists the
--                      nights they play (dj_save_mine, dj_set_add).
--   community manager  creates and edits nights, rooms (venues) and djs, hides
--                      comments. Only an admin makes someone one.
--   admin              everything a community manager can, plus: people and
--                      their types, feedback, the log. An admin is
--                      profiles.is_admin, appointed in the SQL editor as before.
--
-- Because the types now carry power, the code that equals the name can no longer
-- reach them: set_account_type only switches between normal user and dj.
-- Anyone who typed their way to "admin" or "community manager" under 41 goes back
-- to normal user below.
--
-- Every write by the staff goes through a function here (security definer, with
-- its own check) and leaves a line in staff_log, so it is always clear who made
-- what. Nights made here carry source = staff; the ticketmaster sync and the seed
-- cleanup never touch them.

-- ------------------------------------------------------------- who is who

-- Under 41 anyone could pick admin or community manager with the name as code.
update public.profiles set account_type = 'user'
  where account_type in ('admin', 'community_manager') and not is_admin;
update public.profiles set account_type = 'admin' where is_admin and account_type <> 'admin';

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select p.is_admin or p.account_type = 'community_manager'
                   from public.profiles p where p.id = auth.uid()), false);
$$;

create or replace function public.my_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when p.is_admin then 'admin' else p.account_type end
  from public.profiles p where p.id = auth.uid();
$$;

grant execute on function public.is_staff() to authenticated;
grant execute on function public.my_role() to authenticated;

-- The code still switches between normal user and dj; the other two are given.
create or replace function public.set_account_type(p_type text, p_code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  name text := case p_type when 'user' then 'normal user' when 'dj' then 'dj' end;
  me public.profiles%rowtype;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if p_type in ('community_manager', 'admin') then return 'locked'; end if;
  if name is null then return 'type'; end if;
  select * into me from public.profiles where id = auth.uid();
  if me.is_admin or me.account_type = 'community_manager' then return 'locked'; end if;
  if lower(btrim(coalesce(p_code, ''))) <> name then return 'code'; end if;
  perform set_config('afterhours.account_type', 'on', true);
  update public.profiles set account_type = p_type where id = auth.uid();
  perform set_config('afterhours.account_type', '', true);
  return 'ok';
end;
$$;

-- --------------------------------------------------------------- the log

create table if not exists public.staff_log (
  id          bigserial primary key,
  actor_id    uuid references public.profiles on delete set null,
  action      text not null,
  target      text not null,
  target_id   text,
  note        text,
  at          timestamptz not null default now()
);
create index if not exists staff_log_at_idx on public.staff_log (at desc);
alter table public.staff_log enable row level security;
revoke all on public.staff_log from public, anon, authenticated;

create or replace function public.staff_note(p_action text, p_target text, p_id text, p_note text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.staff_log (actor_id, action, target, target_id, note)
  values (auth.uid(), p_action, p_target, p_id, left(p_note, 200));
$$;
revoke all on function public.staff_note(text, text, text, text) from public, anon, authenticated;

-- ------------------------------------------------------------- the columns

alter table public.events add column if not exists created_by uuid references public.profiles on delete set null;
alter table public.venues add column if not exists created_by uuid references public.profiles on delete set null;
alter table public.djs add column if not exists created_by uuid references public.profiles on delete set null;
alter table public.djs add column if not exists owner_id uuid references public.profiles on delete set null;
alter table public.djs add column if not exists bio text check (bio is null or length(bio) <= 600);
alter table public.dj_sets add column if not exists created_by uuid references public.profiles on delete set null;
create unique index if not exists djs_owner_idx on public.djs (owner_id) where owner_id is not null;

create or replace function public.make_slug(p_text text)
returns text
language sql
volatile
as $$
  select coalesce(nullif(trim(both '-' from left(regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]+', '-', 'g'), 60)), ''), 'x')
         || '-' || substr(md5(random()::text), 1, 6);
$$;

create or replace function public.need_staff()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
end;
$$;

-- ----------------------------------------------------------------- venues

-- p_id null makes a new room; otherwise edits it. Returns the id.
create or replace function public.staff_venue_save(p_id uuid, p_city text, p_name text, p_lat double precision, p_lng double precision)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  c uuid;
  v uuid;
  n text := btrim(coalesce(p_name, ''));
begin
  perform public.need_staff();
  if length(n) not between 2 and 80 then raise exception 'name: 2 to 80 characters'; end if;
  select id into c from public.cities where slug = p_city;
  if c is null then raise exception 'unknown city'; end if;
  if p_lat is not null and (p_lat not between -90 and 90 or p_lng is null or p_lng not between -180 and 180) then
    raise exception 'that point is not on the map';
  end if;
  if p_id is null then
    insert into public.venues (city_id, slug, name, lat, lng, created_by)
    values (c, public.make_slug(n), n, p_lat, p_lng, auth.uid()) returning id into v;
    perform public.staff_note('create', 'venue', v::text, n);
  else
    update public.venues set city_id = c, name = n, lat = p_lat, lng = p_lng where id = p_id returning id into v;
    if v is null then raise exception 'no such room'; end if;
    perform public.staff_note('edit', 'venue', v::text, n);
  end if;
  return v;
end;
$$;

-- ----------------------------------------------------------------- nights

-- p_date YYYY-MM-DD and p_time HH:MM are the local time of the night, stored
-- the way the ticketmaster sync stores it. Returns the slug.
create or replace function public.staff_event_save(
  p_id uuid, p_title text, p_city text, p_type text, p_venue uuid,
  p_date text, p_time text, p_body text, p_ticket_url text, p_image_url text, p_published boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.cities%rowtype;
  ty uuid;
  v public.venues%rowtype;
  t text := btrim(coalesce(p_title, ''));
  d date;
  hm text := coalesce(nullif(btrim(p_time), ''), '22:00');
  short text;
  s text;
  old public.events%rowtype;
begin
  perform public.need_staff();
  if length(t) not between 2 and 120 then raise exception 'title: 2 to 120 characters'; end if;
  select * into c from public.cities where slug = p_city;
  if c.id is null then raise exception 'unknown city'; end if;
  select id into ty from public.event_types where slug = p_type;
  if ty is null then raise exception 'unknown kind'; end if;
  if p_venue is not null then
    select * into v from public.venues where id = p_venue;
    if v.id is null or v.city_id <> c.id then raise exception 'that room is not in this city'; end if;
  end if;
  begin d := p_date::date; exception when others then raise exception 'date: YYYY-MM-DD'; end;
  if hm !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'time: HH:MM'; end if;
  if d < current_date - 1 then raise exception 'that night is over'; end if;
  if coalesce(p_ticket_url, '') <> '' and p_ticket_url !~ '^https://' then raise exception 'ticket link: https:// only'; end if;
  if coalesce(p_image_url, '') <> '' and p_image_url !~ '^https://' then raise exception 'photo link: https:// only'; end if;
  if length(coalesce(p_body, '')) > 2000 then raise exception 'text: at most 2000 characters'; end if;

  short := to_char(d, 'DD.MM.YY');
  if p_id is null then
    insert into public.events (slug, city_id, type_id, venue_id, title, meta, body, starts_at, starts_at_estimated,
                               date_text, is_published, source, image_url, ticket_url, lat, lng, created_by)
    values (public.make_slug(t), c.id, ty, v.id, t, concat_ws(' · ', coalesce(v.name, c.name), short, hm),
            coalesce(btrim(p_body), ''), (d::text || 'T' || hm)::timestamptz, false, short || ' · ' || hm,
            coalesce(p_published, true), 'staff', nullif(btrim(p_image_url), ''), nullif(btrim(p_ticket_url), ''),
            v.lat, v.lng, auth.uid())
    returning slug into s;
    perform public.staff_note('create', 'night', s, t);
  else
    select * into old from public.events where id = p_id;
    if old.id is null then raise exception 'no such night'; end if;
    if old.source <> 'staff' then raise exception 'only nights made here can be edited here'; end if;
    update public.events set city_id = c.id, type_id = ty, venue_id = v.id, title = t,
           meta = concat_ws(' · ', coalesce(v.name, c.name), short, hm), body = coalesce(btrim(p_body), ''),
           starts_at = (d::text || 'T' || hm)::timestamptz, date_text = short || ' · ' || hm,
           is_published = coalesce(p_published, true), image_url = nullif(btrim(p_image_url), ''),
           ticket_url = nullif(btrim(p_ticket_url), ''), lat = v.lat, lng = v.lng, updated_at = now()
     where id = p_id returning slug into s;
    perform public.staff_note('edit', 'night', s, t);
  end if;
  return s;
end;
$$;

-- An admin deletes any night made here; a community manager only their own.
create or replace function public.staff_event_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.events%rowtype;
begin
  perform public.need_staff();
  select * into e from public.events where id = p_id;
  if e.id is null then return; end if;
  if e.source <> 'staff' then raise exception 'only nights made here can be deleted here'; end if;
  if not public.is_admin() and e.created_by is distinct from auth.uid() then
    raise exception 'only the admin or whoever made it' using errcode = '42501';
  end if;
  delete from public.events where id = p_id;
  perform public.staff_note('delete', 'night', e.slug, e.title);
end;
$$;

-- The nights the staff made, newest first, unpublished ones too. (43 widens it;
-- the drop lets this file run again after that.)
drop function if exists public.staff_events(int);
create or replace function public.staff_events(p_limit int default 100)
returns table (id uuid, slug text, title text, city_slug text, type_slug text, venue_id uuid,
               starts_at timestamptz, body text, ticket_url text, image_url text, is_published boolean,
               created_by uuid, maker text)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.slug, e.title, c.slug, t.slug, e.venue_id, e.starts_at, e.body, e.ticket_url, e.image_url,
         e.is_published, e.created_by, p.display_name
  from public.events e
  join public.cities c on c.id = e.city_id
  join public.event_types t on t.id = e.type_id
  left join public.profiles p on p.id = e.created_by
  where e.source = 'staff' and public.is_staff()
  order by e.created_at desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

-- -------------------------------------------------------------------- djs

create or replace function public.dj_check(p_name text, p_genre text, p_sound text, p_bio text, p_photo text)
returns void
language plpgsql
immutable
as $$
begin
  if length(btrim(coalesce(p_name, ''))) not between 2 and 60 then raise exception 'name: 2 to 60 characters'; end if;
  if length(btrim(coalesce(p_genre, ''))) not between 2 and 60 then raise exception 'genre: 2 to 60 characters'; end if;
  if p_sound not in ('house', 'techno', 'rap') then raise exception 'sound: house, techno or rap'; end if;
  if length(coalesce(p_bio, '')) > 600 then raise exception 'about: at most 600 characters'; end if;
  if coalesce(p_photo, '') <> '' and p_photo !~ '^https://' then raise exception 'photo link: https:// only'; end if;
end;
$$;

-- Staff: p_id null makes a new dj page; otherwise edits one. Returns the slug.
create or replace function public.staff_dj_save(p_id uuid, p_name text, p_genre text, p_sound text,
                                                p_city text, p_bio text, p_photo text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  c uuid;
  s text;
begin
  perform public.need_staff();
  perform public.dj_check(p_name, p_genre, p_sound, p_bio, p_photo);
  select id into c from public.cities where slug = p_city;
  if p_id is null then
    insert into public.djs (slug, name, genre, sound, city_id, bio, photo_url, source, sort_order, created_by)
    values (public.make_slug(p_name), btrim(p_name), btrim(p_genre), p_sound, c, nullif(btrim(p_bio), ''),
            nullif(btrim(p_photo), ''), 'staff', 100, auth.uid())
    returning slug into s;
    perform public.staff_note('create', 'dj', s, btrim(p_name));
  else
    update public.djs set name = btrim(p_name), genre = btrim(p_genre), sound = p_sound, city_id = c,
           bio = nullif(btrim(p_bio), ''), photo_url = nullif(btrim(p_photo), '')
     where id = p_id returning slug into s;
    if s is null then raise exception 'no such dj'; end if;
    perform public.staff_note('edit', 'dj', s, btrim(p_name));
  end if;
  return s;
end;
$$;

-- A dj: the one page that is theirs.
create or replace function public.dj_mine()
returns table (id uuid, slug text, name text, genre text, sound text, city_slug text, bio text, photo_url text)
language sql
stable
security definer
set search_path = public
as $$
  select d.id, d.slug, d.name, d.genre, d.sound, c.slug, d.bio, d.photo_url
  from public.djs d left join public.cities c on c.id = d.city_id
  where d.owner_id = auth.uid();
$$;

create or replace function public.dj_save_mine(p_name text, p_genre text, p_sound text,
                                               p_city text, p_bio text, p_photo text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  c uuid;
  s text;
begin
  if coalesce(public.my_role(), '') <> 'dj' then
    raise exception 'switch your account to dj first' using errcode = '42501';
  end if;
  perform public.dj_check(p_name, p_genre, p_sound, p_bio, p_photo);
  select id into c from public.cities where slug = p_city;
  update public.djs set name = btrim(p_name), genre = btrim(p_genre), sound = p_sound, city_id = c,
         bio = nullif(btrim(p_bio), ''), photo_url = nullif(btrim(p_photo), '')
   where owner_id = auth.uid() returning slug into s;
  if s is null then
    insert into public.djs (slug, name, genre, sound, city_id, bio, photo_url, source, sort_order, owner_id, created_by)
    values (public.make_slug(p_name), btrim(p_name), btrim(p_genre), p_sound, c, nullif(btrim(p_bio), ''),
            nullif(btrim(p_photo), ''), 'self', 100, auth.uid(), auth.uid())
    returning slug into s;
    perform public.staff_note('create', 'dj', s, 'own page: ' || btrim(p_name));
  end if;
  return s;
end;
$$;

-- A night a dj plays: the staff for any dj, a dj for their own page.
create or replace function public.dj_set_add(p_dj uuid, p_venue text, p_city text, p_date text, p_time text, p_hours numeric)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  d date;
  hm text := coalesce(nullif(btrim(p_time), ''), '23:00');
  r uuid;
begin
  if not public.is_staff() and not exists (select 1 from public.djs where id = p_dj and owner_id = auth.uid()) then
    raise exception 'not your page' using errcode = '42501';
  end if;
  if not exists (select 1 from public.djs where id = p_dj) then raise exception 'no such dj'; end if;
  if length(btrim(coalesce(p_venue, ''))) not between 2 and 80 then raise exception 'room: 2 to 80 characters'; end if;
  begin d := p_date::date; exception when others then raise exception 'date: YYYY-MM-DD'; end;
  if hm !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'time: HH:MM'; end if;
  if d < current_date - 1 then raise exception 'that night is over'; end if;
  if coalesce(p_hours, 3) not between 0.5 and 24 then raise exception 'hours: 0.5 to 24'; end if;
  insert into public.dj_sets (dj_id, venue, city_id, starts_at, hours, created_by)
  values (p_dj, btrim(p_venue), (select id from public.cities where slug = p_city),
          (d::text || 'T' || hm)::timestamptz, coalesce(p_hours, 3), auth.uid())
  returning id into r;
  perform public.staff_note('create', 'set', r::text, btrim(p_venue) || ' · ' || p_date);
  return r;
end;
$$;

create or replace function public.dj_set_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_staff() and not exists (
    select 1 from public.dj_sets s join public.djs d on d.id = s.dj_id where s.id = p_id and d.owner_id = auth.uid()) then
    raise exception 'not your page' using errcode = '42501';
  end if;
  delete from public.dj_sets where id = p_id;
  perform public.staff_note('delete', 'set', p_id::text, null);
end;
$$;

-- The sets of one dj from today on, with their ids (for deleting).
create or replace function public.dj_sets_of(p_dj uuid)
returns table (id uuid, venue text, starts_at timestamptz, hours numeric)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.venue, s.starts_at, s.hours from public.dj_sets s
  where s.dj_id = p_dj and s.starts_at > now() - interval '12 hours'
  order by s.starts_at;
$$;

-- --------------------------------------------------------------- comments

-- Hiding was for the admin alone (02_rls.sql); now for the staff.
create or replace function public.guard_comment_hidden()
returns trigger
language plpgsql
as $$
begin
  if new.is_hidden is distinct from old.is_hidden
     and auth.uid() is not null
     and not public.is_staff() then
    raise exception 'is_hidden can only be changed by the staff';
  end if;
  return new;
end;
$$;

-- Staff hide (or show again) a comment; the author is not told.
create or replace function public.staff_comment_hide(p_id uuid, p_hidden boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  update public.comments set is_hidden = coalesce(p_hidden, true) where id = p_id;
  perform public.staff_note(case when coalesce(p_hidden, true) then 'hide' else 'show' end, 'comment', p_id::text, null);
end;
$$;

create or replace function public.staff_comments(p_limit int default 60)
returns table (id uuid, body text, author text, night text, night_slug text, is_hidden boolean, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.body, coalesce(p.display_name, m.author_name), e.title, e.slug, m.is_hidden, m.created_at
  from public.comments m
  join public.events e on e.id = m.event_id
  left join public.profiles p on p.id = m.author_id
  where public.is_staff()
  order by m.created_at desc
  limit greatest(1, least(coalesce(p_limit, 60), 300));
$$;

-- ------------------------------------------------------------------ admin

create or replace function public.need_admin()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
end;
$$;

-- Find people by handle or name; empty query: the staff first, then the newest.
create or replace function public.admin_people(p_query text)
returns table (id uuid, handle text, display_name text, role text, created_at timestamptz)
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
           case when p.is_admin then 'admin' else p.account_type end, p.created_at
    from public.profiles p
    where q = '' or lower(coalesce(p.handle, '')) like '%' || q || '%' or lower(coalesce(p.display_name, '')) like '%' || q || '%'
    order by (p.is_admin or p.account_type <> 'user') desc, p.created_at desc
    limit 60;
end;
$$;

-- The admin gives a type: normal user, dj or community manager. Admins are
-- appointed in the SQL editor, and an admin cannot be changed from here.
create or replace function public.admin_set_type(p_user uuid, p_type text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  who public.profiles%rowtype;
begin
  perform public.need_admin();
  if p_type not in ('user', 'dj', 'community_manager') then return 'type'; end if;
  select * into who from public.profiles where id = p_user;
  if who.id is null then return 'none'; end if;
  if who.is_admin then return 'admin'; end if;
  perform set_config('afterhours.account_type', 'on', true);
  update public.profiles set account_type = p_type where id = p_user;
  perform set_config('afterhours.account_type', '', true);
  perform public.staff_note('role', 'person', p_user::text, coalesce(who.handle, who.display_name) || ': ' || who.account_type || ' → ' || p_type);
  return 'ok';
end;
$$;

-- The numbers on the first page of the panel.
create or replace function public.admin_overview()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  return json_build_object(
    'people', (select count(*) from public.profiles),
    'people_week', (select count(*) from public.profiles where created_at > now() - interval '7 days'),
    'managers', (select count(*) from public.profiles where account_type = 'community_manager'),
    'djs', (select count(*) from public.profiles where account_type = 'dj'),
    'nights_ahead', (select count(*) from public.events where is_published and starts_at > now()),
    'nights_staff', (select count(*) from public.events where source = 'staff'),
    'venues', (select count(*) from public.venues),
    'comments_week', (select count(*) from public.comments where created_at > now() - interval '7 days'),
    'feedback_open', case when public.is_admin() then (select count(*) from public.feedback where not handled) end
  );
end;
$$;

create or replace function public.admin_log(p_limit int default 100)
returns table (at timestamptz, who text, action text, target text, target_id text, note text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_admin();
  return query
    select l.at, coalesce(p.handle, p.display_name, 'gone'), l.action, l.target, l.target_id, l.note
    from public.staff_log l left join public.profiles p on p.id = l.actor_id
    order by l.at desc
    limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;

-- --------------------------------------------------------------- the doors

do $$
declare f text;
begin
  foreach f in array array[
    'staff_venue_save(uuid, text, text, double precision, double precision)',
    'staff_event_save(uuid, text, text, text, uuid, text, text, text, text, text, boolean)',
    'staff_event_delete(uuid)', 'staff_events(int)',
    'staff_dj_save(uuid, text, text, text, text, text, text)',
    'dj_mine()', 'dj_save_mine(text, text, text, text, text, text)',
    'dj_set_add(uuid, text, text, text, text, numeric)', 'dj_set_delete(uuid)', 'dj_sets_of(uuid)',
    'staff_comment_hide(uuid, boolean)', 'staff_comments(int)',
    'admin_people(text)', 'admin_set_type(uuid, text)', 'admin_overview()', 'admin_log(int)'
  ] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;
revoke all on function public.need_staff() from public, anon;
revoke all on function public.need_admin() from public, anon;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('42_staff.sql', '7df8ea9bbca457f354c134e99f19b72a828a75a2f69a96ab56453be0f7f5c629');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('42_staff.sql');
  end if;
end $$;


-- ============================================================
--  NIGHTS SENT IN BY PEOPLE, LET THROUGH BY THE STAFF   (43_event_submit.sql)
-- ============================================================

-- afterhours — anyone with an account suggests a ticketed night; the staff decide (43)
--
-- The + on the flow opens "with a ticket" or "among friends" (a spark). With a
-- ticket: the staff publish at once (42_staff.sql); everyone else sends it in,
-- and it waits, unseen, until a community manager or an admin lets it through.
--
--   events.review         pending · rejected · null (decided, or never asked)
--   event_submit(…)       a signed-in person (not a guest) sends a night in;
--                         at most 5 waiting at a time. A ticket link is required.
--   event_submissions()   your own, with where they stand
--   staff_pending()       the staff: what waits
--   staff_review(id, ok, note)  publish it, or turn it down with a line why
--
-- Nights sent in carry source = user. Once let through they show like any other;
-- the staff can still edit or delete them in the panel.

alter table public.events add column if not exists review text check (review in ('pending', 'rejected'));
alter table public.events add column if not exists review_note text;
create index if not exists events_review_idx on public.events (review) where review is not null;

-- ------------------------------------------------- one writer for both doors

-- No check of who calls: the two doors below each check first. Nobody else may call it.
create or replace function public.night_write(
  p_id uuid, p_title text, p_city text, p_type text, p_venue uuid,
  p_date text, p_time text, p_body text, p_ticket_url text, p_image_url text,
  p_published boolean, p_source text, p_review text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.cities%rowtype;
  ty uuid;
  v public.venues%rowtype;
  t text := btrim(coalesce(p_title, ''));
  d date;
  hm text := coalesce(nullif(btrim(p_time), ''), '22:00');
  short text;
  s text;
begin
  if length(t) not between 2 and 120 then raise exception 'title: 2 to 120 characters'; end if;
  select * into c from public.cities where slug = p_city;
  if c.id is null then raise exception 'unknown city'; end if;
  select id into ty from public.event_types where slug = p_type;
  if ty is null then raise exception 'unknown kind'; end if;
  if p_venue is not null then
    select * into v from public.venues where id = p_venue;
    if v.id is null or v.city_id <> c.id then raise exception 'that room is not in this city'; end if;
  end if;
  begin d := p_date::date; exception when others then raise exception 'date: YYYY-MM-DD'; end;
  if hm !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'time: HH:MM'; end if;
  if d < current_date - 1 then raise exception 'that night is over'; end if;
  if coalesce(p_ticket_url, '') <> '' and p_ticket_url !~ '^https://' then raise exception 'ticket link: https:// only'; end if;
  if coalesce(p_image_url, '') <> '' and p_image_url !~ '^https://' then raise exception 'photo link: https:// only'; end if;
  if length(coalesce(p_body, '')) > 2000 then raise exception 'text: at most 2000 characters'; end if;

  short := to_char(d, 'DD.MM.YY');
  if p_id is null then
    insert into public.events (slug, city_id, type_id, venue_id, title, meta, body, starts_at, starts_at_estimated,
                               date_text, is_published, source, image_url, ticket_url, lat, lng, created_by, review)
    values (public.make_slug(t), c.id, ty, v.id, t, concat_ws(' · ', coalesce(v.name, c.name), short, hm),
            coalesce(btrim(p_body), ''), (d::text || 'T' || hm)::timestamptz, false, short || ' · ' || hm,
            coalesce(p_published, true), p_source, nullif(btrim(p_image_url), ''), nullif(btrim(p_ticket_url), ''),
            v.lat, v.lng, auth.uid(), p_review)
    returning slug into s;
  else
    update public.events set city_id = c.id, type_id = ty, venue_id = v.id, title = t,
           meta = concat_ws(' · ', coalesce(v.name, c.name), short, hm), body = coalesce(btrim(p_body), ''),
           starts_at = (d::text || 'T' || hm)::timestamptz, date_text = short || ' · ' || hm,
           is_published = coalesce(p_published, true), image_url = nullif(btrim(p_image_url), ''),
           ticket_url = nullif(btrim(p_ticket_url), ''), lat = v.lat, lng = v.lng, updated_at = now()
     where id = p_id returning slug into s;
  end if;
  return s;
end;
$$;
revoke all on function public.night_write(uuid, text, text, text, uuid, text, text, text, text, text, boolean, text, text) from public, anon, authenticated;

-- The staff door, as in 42, now through night_write, and nights sent in by
-- people can be edited too.
create or replace function public.staff_event_save(
  p_id uuid, p_title text, p_city text, p_type text, p_venue uuid,
  p_date text, p_time text, p_body text, p_ticket_url text, p_image_url text, p_published boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  old public.events%rowtype;
  s text;
begin
  perform public.need_staff();
  if p_id is not null then
    select * into old from public.events where id = p_id;
    if old.id is null then raise exception 'no such night'; end if;
    if old.source not in ('staff', 'user') then raise exception 'only nights made here can be edited here'; end if;
    if old.review = 'pending' and coalesce(p_published, true) then
      raise exception 'let it through first (waiting for review)';
    end if;
  end if;
  s := public.night_write(p_id, p_title, p_city, p_type, p_venue, p_date, p_time, p_body, p_ticket_url, p_image_url,
                          p_published, coalesce(old.source, 'staff'), old.review);
  perform public.staff_note(case when p_id is null then 'create' else 'edit' end, 'night', s, btrim(p_title));
  return s;
end;
$$;

create or replace function public.staff_event_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.events%rowtype;
begin
  perform public.need_staff();
  select * into e from public.events where id = p_id;
  if e.id is null then return; end if;
  if e.source not in ('staff', 'user') then raise exception 'only nights made here can be deleted here'; end if;
  if not public.is_admin() and e.source = 'staff' and e.created_by is distinct from auth.uid() then
    raise exception 'only the admin or whoever made it' using errcode = '42501';
  end if;
  delete from public.events where id = p_id;
  perform public.staff_note('delete', 'night', e.slug, e.title);
end;
$$;

-- The panel list: nights made by the staff, and the ones sent in that were decided.
drop function if exists public.staff_events(int);
create or replace function public.staff_events(p_limit int default 100)
returns table (id uuid, slug text, title text, city_slug text, type_slug text, venue_id uuid,
               starts_at timestamptz, body text, ticket_url text, image_url text, is_published boolean,
               created_by uuid, maker text, source text, review text)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.slug, e.title, c.slug, t.slug, e.venue_id, e.starts_at, e.body, e.ticket_url, e.image_url,
         e.is_published, e.created_by, p.display_name, e.source, e.review
  from public.events e
  join public.cities c on c.id = e.city_id
  join public.event_types t on t.id = e.type_id
  left join public.profiles p on p.id = e.created_by
  where e.source in ('staff', 'user') and public.is_staff()
  order by e.created_at desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

-- ------------------------------------------------------- the door for people

create or replace function public.event_submit(
  p_title text, p_city text, p_type text, p_venue uuid,
  p_date text, p_time text, p_body text, p_ticket_url text, p_image_url text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  s text;
begin
  if auth.uid() is null or public.is_guest() then
    raise exception 'make an account first' using errcode = '42501';
  end if;
  if coalesce(btrim(p_ticket_url), '') = '' then raise exception 'ticket link: needed'; end if;
  if (select count(*) from public.events where created_by = auth.uid() and review = 'pending') >= 5 then
    raise exception 'five are already waiting; wait until they are looked at';
  end if;
  s := public.night_write(null, p_title, p_city, p_type, p_venue, p_date, p_time, p_body, p_ticket_url, p_image_url,
                          false, 'user', 'pending');
  perform public.staff_note('submit', 'night', s, btrim(p_title));
  return s;
end;
$$;

create or replace function public.event_submissions()
returns table (id uuid, slug text, title text, starts_at timestamptz, review text, review_note text, is_published boolean)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.slug, e.title, e.starts_at, e.review, e.review_note, e.is_published
  from public.events e
  where e.created_by = auth.uid() and e.source = 'user'
  order by e.created_at desc
  limit 50;
$$;

create or replace function public.staff_pending()
returns table (id uuid, slug text, title text, city_slug text, type_slug text, venue_name text,
               starts_at timestamptz, body text, ticket_url text, image_url text, maker text, handle text, sent_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.slug, e.title, c.slug, t.slug, v.name, e.starts_at, e.body, e.ticket_url, e.image_url,
         p.display_name, p.handle, e.created_at
  from public.events e
  join public.cities c on c.id = e.city_id
  join public.event_types t on t.id = e.type_id
  left join public.venues v on v.id = e.venue_id
  left join public.profiles p on p.id = e.created_by
  where e.review = 'pending' and public.is_staff()
  order by e.created_at;
$$;

create or replace function public.staff_review(p_id uuid, p_ok boolean, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.events%rowtype;
begin
  perform public.need_staff();
  select * into e from public.events where id = p_id and review = 'pending';
  if e.id is null then raise exception 'nothing waiting with that id'; end if;
  if p_ok then
    update public.events set review = null, review_note = null, is_published = true, updated_at = now() where id = p_id;
  else
    update public.events set review = 'rejected', review_note = left(nullif(btrim(p_note), ''), 300), is_published = false, updated_at = now() where id = p_id;
  end if;
  perform public.staff_note(case when p_ok then 'approve' else 'reject' end, 'night', e.slug, e.title);
end;
$$;

-- The first page of the panel counts what waits.
create or replace function public.admin_overview()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  return json_build_object(
    'people', (select count(*) from public.profiles),
    'people_week', (select count(*) from public.profiles where created_at > now() - interval '7 days'),
    'managers', (select count(*) from public.profiles where account_type = 'community_manager'),
    'djs', (select count(*) from public.profiles where account_type = 'dj'),
    'nights_ahead', (select count(*) from public.events where is_published and starts_at > now()),
    'nights_staff', (select count(*) from public.events where source = 'staff'),
    'venues', (select count(*) from public.venues),
    'comments_week', (select count(*) from public.comments where created_at > now() - interval '7 days'),
    'pending', (select count(*) from public.events where review = 'pending'),
    'feedback_open', case when public.is_admin() then (select count(*) from public.feedback where not handled) end
  );
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'staff_event_save(uuid, text, text, text, uuid, text, text, text, text, text, boolean)',
    'staff_event_delete(uuid)', 'staff_events(int)',
    'event_submit(text, text, text, uuid, text, text, text, text, text)', 'event_submissions()',
    'staff_pending()', 'staff_review(uuid, boolean, text)', 'admin_overview()'
  ] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('43_event_submit.sql', '2fad57d8c4ba1bcaf884a71be4fddd6d07126aab1d732c8d4eb176b596de2ef6');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('43_event_submit.sql');
  end if;
end $$;


-- ============================================================
--  GROUPS — FRIENDS WHO FIND A NIGHT TOGETHER   (44_groups.sql)
-- ============================================================

-- afterhours — groups: friends who find a night together (44)
--
-- A group is a few people (2 to 12) who swipe one deck together. Each swipes in
-- their own time; when everyone said yes it is a match, when more than half did,
-- most are in. Or all at once: a live session, where the same card is in front of
-- everyone and moves on when all who are there have answered.
--
--   groups           name, emoji, colour, a cover photo, lasting or once (a once
--                    group has dates and is put away when they are over), and the
--                    deck it swipes: a city and a window of days
--   group_members    who is in; the one who made it is the owner
--   group_invites    a code for a link or a QR: whoever has it may join (14 days,
--                    20 uses), friends or not
--   group_swipes     the answer of each member to each night, inside this group only;
--                    the personal deck is not touched
--   group_live       a live session: who is there (seen in the last 40 s), and the
--                    cards skipped
--
-- The tables are closed; everything goes through the functions below, and each
-- one asks first whether you are in the group. Members see what the others answered:
-- it is a group of friends deciding together.
--
-- The deck of a group is sorted by the taste of the group before anyone swipes: a night a
-- member already kept on their own counts most, then nights of the kinds the
-- members keep most often.

create table if not exists public.groups (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 40),
  emoji       text not null default '✦' check (length(emoji) between 1 and 8),
  color       text not null default 'red' check (color in ('red', 'gold', 'blue', 'green', 'violet', 'paper')),
  cover_path  text,
  kind        text not null default 'lasting' check (kind in ('lasting', 'once')),
  city_slug   text,
  date_from   date,
  date_to     date,
  created_by  uuid references public.profiles on delete set null,
  created_at  timestamptz not null default now(),
  constraint groups_window check (date_to is null or date_from is null or date_to >= date_from),
  constraint groups_once_dated check (kind = 'lasting' or date_to is not null)
);

create table if not exists public.group_members (
  group_id   uuid not null references public.groups on delete cascade,
  user_id    uuid not null references public.profiles on delete cascade,
  role       text not null default 'member' check (role in ('owner', 'member')),
  joined_at  timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index if not exists group_members_user_idx on public.group_members (user_id);

create table if not exists public.group_invites (
  code        text primary key,
  group_id    uuid not null references public.groups on delete cascade,
  created_by  uuid references public.profiles on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '14 days',
  uses        int not null default 0,
  max_uses    int not null default 20
);

create table if not exists public.group_swipes (
  group_id   uuid not null references public.groups on delete cascade,
  user_id    uuid not null references public.profiles on delete cascade,
  event_id   uuid not null references public.events on delete cascade,
  direction  text not null check (direction in ('left', 'right')),
  at         timestamptz not null default now(),
  primary key (group_id, user_id, event_id)
);
create index if not exists group_swipes_event_idx on public.group_swipes (group_id, event_id);

create table if not exists public.group_live (
  group_id  uuid not null references public.groups on delete cascade,
  user_id   uuid not null references public.profiles on delete cascade,
  seen_at   timestamptz not null default now(),
  primary key (group_id, user_id)
);
create table if not exists public.group_live_skips (
  group_id  uuid not null references public.groups on delete cascade,
  event_id  uuid not null references public.events on delete cascade,
  primary key (group_id, event_id)
);

alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.group_invites enable row level security;
alter table public.group_swipes enable row level security;
alter table public.group_live enable row level security;
alter table public.group_live_skips enable row level security;
revoke all on public.groups, public.group_members, public.group_invites, public.group_swipes,
              public.group_live, public.group_live_skips from public, anon, authenticated;

-- ------------------------------------------------------------- helpers

create or replace function public.in_group(p_group uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.group_members where group_id = p_group and user_id = auth.uid());
$$;

create or replace function public.need_member(p_group uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.in_group(p_group) then
    raise exception 'not in this group' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.need_account()
returns void
language plpgsql
stable
as $$
begin
  if auth.uid() is null or public.is_guest() then
    raise exception 'make an account first' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.group_check(p_name text, p_emoji text, p_color text, p_kind text,
                                              p_city text, p_from date, p_to date)
returns void
language plpgsql
stable
set search_path = public
as $$
begin
  if length(btrim(coalesce(p_name, ''))) not between 1 and 40 then raise exception 'name: 1 to 40 characters'; end if;
  if length(coalesce(p_emoji, '')) not between 1 and 8 then raise exception 'one emoji'; end if;
  if coalesce(p_color, 'red') not in ('red', 'gold', 'blue', 'green', 'violet', 'paper') then raise exception 'unknown colour'; end if;
  if coalesce(p_kind, 'lasting') not in ('lasting', 'once') then raise exception 'lasting or once'; end if;
  if p_kind = 'once' and p_to is null then raise exception 'a group for once needs its last day'; end if;
  if p_from is not null and p_to is not null and p_to < p_from then raise exception 'the last day comes after the first'; end if;
  if p_to is not null and p_to < current_date then raise exception 'those days are over'; end if;
  if p_city is not null and not exists (select 1 from public.cities where slug = p_city) then raise exception 'unknown city'; end if;
end;
$$;

-- ---------------------------------------------------------- the group

-- Members: friends of the maker only (strangers come in by an invite code).
create or replace function public.group_create(p_name text, p_emoji text, p_color text, p_kind text,
                                               p_city text, p_from date, p_to date, p_members uuid[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  g uuid;
  m uuid;
  others uuid[] := array(select x from unnest(coalesce(p_members, '{}')) with ordinality as u(x, i)
                         where x <> auth.uid() group by x order by min(i));
begin
  perform public.need_account();
  perform public.group_check(p_name, p_emoji, p_color, p_kind, p_city, p_from, p_to);
  if cardinality(others) > 11 then raise exception 'at most 12 in a group'; end if;
  if (select count(*) from public.group_members where user_id = auth.uid()) >= 30 then
    raise exception 'at most 30 groups';
  end if;
  foreach m in array others loop
    if not public.is_friend(m) then raise exception 'only friends can be added; send the others a link'; end if;
  end loop;
  insert into public.groups (name, emoji, color, kind, city_slug, date_from, date_to, created_by)
  values (btrim(p_name), p_emoji, coalesce(p_color, 'red'), coalesce(p_kind, 'lasting'), p_city, p_from, p_to, auth.uid())
  returning id into g;
  insert into public.group_members (group_id, user_id, role) values (g, auth.uid(), 'owner');
  -- in the order they were picked, a microsecond apart, so "the oldest member" is never a tie
  insert into public.group_members (group_id, user_id, joined_at)
  select g, x, now() + make_interval(secs => i / 1e6) from unnest(others) with ordinality as u(x, i);
  return g;
end;
$$;

-- Any member may change the name, the look and the deck.
create or replace function public.group_update(p_id uuid, p_name text, p_emoji text, p_color text, p_kind text,
                                               p_city text, p_from date, p_to date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_id);
  perform public.group_check(p_name, p_emoji, p_color, p_kind, p_city, p_from, p_to);
  update public.groups set name = btrim(p_name), emoji = p_emoji, color = coalesce(p_color, 'red'),
         kind = coalesce(p_kind, 'lasting'), city_slug = p_city, date_from = p_from, date_to = p_to
   where id = p_id;
end;
$$;

-- The cover: a photo the member uploaded into their own folder of the photos bucket.
create or replace function public.group_set_cover(p_id uuid, p_path text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  was text;
begin
  perform public.need_member(p_id);
  if p_path is not null and p_path not like auth.uid()::text || '/%' then raise exception 'not your file'; end if;
  select cover_path into was from public.groups where id = p_id;
  update public.groups set cover_path = p_path where id = p_id;
  return was;
end;
$$;

-- A member adds their own friends.
create or replace function public.group_add(p_id uuid, p_users uuid[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  m uuid;
  n int := 0;
begin
  perform public.need_member(p_id);
  foreach m in array coalesce(p_users, '{}') loop
    if exists (select 1 from public.group_members where group_id = p_id and user_id = m) then continue; end if;
    if not public.is_friend(m) then raise exception 'only friends can be added; send the others a link'; end if;
    if (select count(*) from public.group_members where group_id = p_id) >= 12 then raise exception 'at most 12 in a group'; end if;
    insert into public.group_members (group_id, user_id) values (p_id, m);
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- Leaving: the oldest member becomes the owner; the last one out takes the group along.
create or replace function public.group_leave(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  was text;
begin
  perform public.need_member(p_id);
  select role into was from public.group_members where group_id = p_id and user_id = auth.uid();
  delete from public.group_members where group_id = p_id and user_id = auth.uid();
  delete from public.group_live where group_id = p_id and user_id = auth.uid();
  if not exists (select 1 from public.group_members where group_id = p_id) then
    delete from public.groups where id = p_id;
  elsif was = 'owner' then
    update public.group_members set role = 'owner'
     where group_id = p_id and user_id = (select user_id from public.group_members where group_id = p_id order by joined_at, user_id limit 1);
  end if;
end;
$$;

-- The owner takes someone out (their answers stay out of the counts from then on).
create or replace function public.group_remove(p_id uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_id);
  if p_user = auth.uid() then perform public.group_leave(p_id); return; end if;
  if not exists (select 1 from public.group_members where group_id = p_id and user_id = auth.uid() and role = 'owner') then
    raise exception 'only the owner' using errcode = '42501';
  end if;
  delete from public.group_members where group_id = p_id and user_id = p_user;
  delete from public.group_swipes where group_id = p_id and user_id = p_user;
  delete from public.group_live where group_id = p_id and user_id = p_user;
end;
$$;

create or replace function public.group_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from public.group_members where group_id = p_id and user_id = auth.uid() and role = 'owner') then
    raise exception 'only the owner' using errcode = '42501';
  end if;
  delete from public.groups where id = p_id;
end;
$$;

-- --------------------------------------------------------- invitations

-- A code for a link or a QR; the same one while it is still good.
create or replace function public.group_invite(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  c text;
begin
  perform public.need_member(p_id);
  select code into c from public.group_invites
   where group_id = p_id and expires_at > now() + interval '1 day' and uses < max_uses
   order by created_at desc limit 1;
  if c is not null then return c; end if;
  loop
    -- no 0/O, 1/I: it may be read out loud or typed
    c := array_to_string(array(select substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1)
                               from generate_series(1, 8)), '');
    exit when not exists (select 1 from public.group_invites where code = c);
  end loop;
  insert into public.group_invites (code, group_id, created_by) values (c, p_id, auth.uid());
  return c;
end;
$$;

-- What a code leads to, before joining. (49 widens it; the drop lets this file run again.)
drop function if exists public.group_peek(text);
create or replace function public.group_peek(p_code text)
returns table (id uuid, name text, emoji text, color text, cover_path text, members int, mine boolean, open boolean)
language sql
stable
security definer
set search_path = public
as $$
  select g.id, g.name, g.emoji, g.color, g.cover_path,
         (select count(*)::int from public.group_members m where m.group_id = g.id),
         public.in_group(g.id),
         i.expires_at > now() and i.uses < i.max_uses
  from public.group_invites i join public.groups g on g.id = i.group_id
  where i.code = upper(btrim(p_code));
$$;

create or replace function public.group_join(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  i public.group_invites%rowtype;
begin
  perform public.need_account();
  select * into i from public.group_invites where code = upper(btrim(p_code));
  if i.code is null then raise exception 'no group with that code'; end if;
  if public.in_group(i.group_id) then return i.group_id; end if;
  if i.expires_at <= now() or i.uses >= i.max_uses then raise exception 'that code is used up; ask for a new one'; end if;
  if (select count(*) from public.group_members where group_id = i.group_id) >= 12 then raise exception 'the group is full (12)'; end if;
  if (select count(*) from public.group_members where user_id = auth.uid()) >= 30 then raise exception 'at most 30 groups'; end if;
  insert into public.group_members (group_id, user_id) values (i.group_id, auth.uid());
  update public.group_invites set uses = uses + 1 where code = i.code;
  return i.group_id;
end;
$$;

-- ------------------------------------------------------------ reading

create or replace function public.group_get(p_id uuid)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_id);
  return (
    select json_build_object(
      'id', g.id, 'name', g.name, 'emoji', g.emoji, 'color', g.color, 'cover_path', g.cover_path,
      'kind', g.kind, 'city_slug', g.city_slug, 'date_from', g.date_from, 'date_to', g.date_to,
      'archived', g.kind = 'once' and g.date_to < current_date,
      'me', auth.uid(),
      'members', (select json_agg(json_build_object('id', p.id, 'handle', p.handle, 'name', p.display_name, 'role', m.role) order by m.joined_at)
                  from public.group_members m join public.profiles p on p.id = m.user_id where m.group_id = g.id))
    from public.groups g where g.id = p_id);
end;
$$;

-- ------------------------------------------------------------ the deck

-- The nights the group looks at: its city (or everywhere) and its days (from today
-- when it has no first day), ordered by the taste of the group. No check here: callers check.
create or replace function public.group_window(p_id uuid)
returns setof public.events_public
language sql
stable
security definer
set search_path = public
as $$
  with g as (select * from public.groups where id = p_id),
       members as (select user_id from public.group_members where group_id = p_id),
       liked_types as (
         select e.type_id, count(*) as n
         from public.swipes s join public.events e on e.id = s.event_id
         where s.direction = 'right' and s.user_id in (select user_id from members)
         group by e.type_id)
  select e.* from public.events_public e, g
  where e.is_published
    and (g.city_slug is null or e.city_slug = g.city_slug)
    and (e.starts_at is null or e.starts_at::date >= greatest(coalesce(g.date_from, current_date), current_date))
    and (g.date_to is null or e.starts_at::date <= g.date_to)
  order by
    3 * (select count(*) from public.swipes s where s.event_id = e.id and s.direction = 'right' and s.user_id in (select user_id from members))
    + coalesce((select least(n, 20) from liked_types lt join public.events x on x.type_id = lt.type_id where x.id = e.id), 0) / 5.0 desc,
    e.starts_at nulls last, e.id
  limit 400;
$$;
revoke all on function public.group_window(uuid) from public, anon, authenticated;

-- Your deck in the group: what you have not answered yet.
create or replace function public.group_deck(p_id uuid, p_limit int default 60)
returns setof public.events_public
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_id);
  return query
    select e.* from public.group_window(p_id) e
    where not exists (select 1 from public.group_swipes s where s.group_id = p_id and s.user_id = auth.uid() and s.event_id = e.id)
    limit greatest(1, least(coalesce(p_limit, 60), 200));
end;
$$;

create or replace function public.group_swipe(p_id uuid, p_event uuid, p_direction text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_id);
  if p_direction not in ('left', 'right') then raise exception 'left or right'; end if;
  insert into public.group_swipes (group_id, user_id, event_id, direction) values (p_id, auth.uid(), p_event, p_direction)
  on conflict (group_id, user_id, event_id) do update set direction = excluded.direction, at = now();
end;
$$;

create or replace function public.group_unswipe(p_id uuid, p_event uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_id);
  delete from public.group_swipes where group_id = p_id and user_id = auth.uid() and event_id = p_event;
end;
$$;

-- Nights at least one member said yes to: match (everyone), most (more than half), some.
create or replace function public.group_matches(p_id uuid)
returns table (id uuid, slug text, title text, starts_at timestamptz, venue_name text, city_name text,
               image_url text, poster_no int, poster_path text, yes int, no int, members int, status text, yes_ids uuid[])
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  n int;
begin
  perform public.need_member(p_id);
  select count(*) into n from public.group_members where group_id = p_id;
  return query
    with votes as (
      select s.event_id,
             count(*) filter (where s.direction = 'right')::int as y,
             count(*) filter (where s.direction = 'left')::int as l,
             array_agg(s.user_id) filter (where s.direction = 'right') as ids
      from public.group_swipes s
      join public.group_members m on m.group_id = s.group_id and m.user_id = s.user_id
      where s.group_id = p_id
      group by s.event_id)
    select e.id, e.slug, e.title, e.starts_at, v.name, c.name, e.image_url, e.poster_no, e.poster_path,
           vo.y, vo.l, n,
           case when vo.y = n then 'match' when vo.y * 2 > n then 'most' else 'some' end,
           vo.ids
    from votes vo
    join public.events e on e.id = vo.event_id and e.is_published
    join public.cities c on c.id = e.city_id
    left join public.venues v on v.id = e.venue_id
    where vo.y > 0 and (e.starts_at is null or e.starts_at > now() - interval '12 hours')
    order by vo.y desc, vo.l, e.starts_at nulls last;
end;
$$;

-- Who answered what on one night.
create or replace function public.group_votes(p_id uuid, p_event uuid)
returns table (user_id uuid, name text, direction text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_id);
  return query
    select m.user_id, coalesce(p.display_name, p.handle), s.direction
    from public.group_members m
    join public.profiles p on p.id = m.user_id
    left join public.group_swipes s on s.group_id = m.group_id and s.user_id = m.user_id and s.event_id = p_event
    where m.group_id = p_id
    order by m.joined_at;
end;
$$;

-- Your groups, the live ones first; a once group whose days are over is archived.
create or replace function public.my_groups()
returns table (id uuid, name text, emoji text, color text, cover_path text, kind text, city_slug text,
               date_from date, date_to date, members int, faces uuid[], matches int, to_swipe int,
               live int, archived boolean)
language sql
stable
security definer
set search_path = public
as $$
  with mine as (
    select g.* from public.groups g join public.group_members m on m.group_id = g.id and m.user_id = auth.uid()
  )
  select g.id, g.name, g.emoji, g.color, g.cover_path, g.kind, g.city_slug, g.date_from, g.date_to,
         (select count(*)::int from public.group_members m where m.group_id = g.id),
         array(select m.user_id from public.group_members m where m.group_id = g.id order by m.joined_at limit 4),
         (select count(*)::int from public.group_matches(g.id) x where x.status = 'match'),
         (select count(*)::int from public.group_window(g.id) e
           where not exists (select 1 from public.group_swipes s where s.group_id = g.id and s.user_id = auth.uid() and s.event_id = e.id)),
         (select count(*)::int from public.group_live l where l.group_id = g.id and l.seen_at > now() - interval '40 seconds'),
         g.kind = 'once' and g.date_to < current_date
  from mine g
  order by (g.kind = 'once' and g.date_to < current_date), g.created_at desc;
$$;

-- ------------------------------------------------------------ live

-- Being in the session: call it every few seconds. Who has not called for 40 s
-- is no longer counted.
create or replace function public.group_live_here(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_id);
  insert into public.group_live (group_id, user_id) values (p_id, auth.uid())
  on conflict (group_id, user_id) do update set seen_at = now();
end;
$$;

create or replace function public.group_live_leave(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_id);
  delete from public.group_live where group_id = p_id and user_id = auth.uid();
end;
$$;

-- The card everyone sees: the first night of the deck of the group that not everyone
-- who is there has answered and nobody skipped; with who is there and what each said.
create or replace function public.group_live_state(p_id uuid)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  here uuid[];
  card public.events_public%rowtype;
  left_ int;
begin
  perform public.need_member(p_id);
  here := array(select l.user_id from public.group_live l
                join public.group_members m on m.group_id = l.group_id and m.user_id = l.user_id
                where l.group_id = p_id and l.seen_at > now() - interval '40 seconds' order by l.user_id);
  if cardinality(here) = 0 then here := array[auth.uid()]; end if;
  select e.* into card from public.group_window(p_id) e
   where not exists (select 1 from public.group_live_skips k where k.group_id = p_id and k.event_id = e.id)
     and (select count(*) from public.group_swipes s where s.group_id = p_id and s.event_id = e.id and s.user_id = any(here)) < cardinality(here)
   limit 1;
  select count(*)::int into left_ from public.group_window(p_id) e
   where not exists (select 1 from public.group_live_skips k where k.group_id = p_id and k.event_id = e.id)
     and (select count(*) from public.group_swipes s where s.group_id = p_id and s.event_id = e.id and s.user_id = any(here)) < cardinality(here);
  return json_build_object(
    'card', case when card.id is null then null else row_to_json(card) end,
    'left', left_,
    'people', (select json_agg(json_build_object('id', p.id, 'name', coalesce(p.display_name, p.handle),
                                                 'answer', (select s.direction from public.group_swipes s
                                                            where s.group_id = p_id and s.user_id = p.id and s.event_id = card.id)))
               from public.profiles p where p.id = any(here)));
end;
$$;

-- Anyone in the session moves past a card nobody can agree on.
create or replace function public.group_live_skip(p_id uuid, p_event uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_id);
  insert into public.group_live_skips (group_id, event_id) values (p_id, p_event) on conflict do nothing;
end;
$$;

-- ------------------------------------------------------- a group to make

-- Friends who kept the same nights as you lately: the start of a group.
create or replace function public.group_suggest()
returns table (user_id uuid, handle text, name text, shared int)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.handle, p.display_name, count(*)::int
  from public.swipes mine
  join public.swipes theirs on theirs.event_id = mine.event_id and theirs.direction = 'right' and theirs.user_id <> mine.user_id
  join public.profiles p on p.id = theirs.user_id
  where mine.user_id = auth.uid() and mine.direction = 'right'
    and mine.created_at > now() - interval '45 days'
    and public.is_friend(theirs.user_id)
  group by p.id, p.handle, p.display_name
  having count(*) >= 2
  order by count(*) desc
  limit 8;
$$;

-- --------------------------------------------------------------- doors

do $$
declare f text;
begin
  foreach f in array array[
    'group_create(text, text, text, text, text, date, date, uuid[])',
    'group_update(uuid, text, text, text, text, text, date, date)',
    'group_set_cover(uuid, text)', 'group_add(uuid, uuid[])', 'group_leave(uuid)', 'group_remove(uuid, uuid)',
    'group_delete(uuid)', 'group_invite(uuid)', 'group_peek(text)', 'group_join(text)',
    'my_groups()', 'group_get(uuid)', 'group_deck(uuid, int)', 'group_swipe(uuid, uuid, text)',
    'group_unswipe(uuid, uuid)', 'group_matches(uuid)', 'group_votes(uuid, uuid)',
    'group_live_here(uuid)', 'group_live_leave(uuid)', 'group_live_state(uuid)', 'group_live_skip(uuid, uuid)',
    'group_suggest()'
  ] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;
revoke all on function public.need_member(uuid) from public, anon;
revoke all on function public.in_group(uuid) from public, anon;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('44_groups.sql', 'b0fa59493217b5c5ba29a1ac218427227ba470501108b1ce906501775c6344fd');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('44_groups.sql');
  end if;
end $$;


-- ============================================================
--  POSTS — A PHOTO AND A FEW WORDS FOR YOUR FRIENDS   (45_posts.sql)
-- ============================================================

-- afterhours — posts: a photo and a few words for your friends (45)
--
-- The + on the yours tab makes a post: a photo (from the phone, into your own
-- folder of the photos bucket), a few words, and if you like the night it was
-- about. Your friends see it in their yours tab, newest first; so do you.
--
--   posts                 author, text, photo, night, hidden (by the staff)
--   post_reports          who reported what and why; the staff look at them
--   post_create(…)        an account (not a guest), at most 20 a day
--   post_delete(id)       the author, or the staff
--   posts_feed(before, n) you and your confirmed friends, a page at a time
--   post_report(id, why)  anyone who can see it; once per person
--   staff_posts_reported() / staff_post_hide(id, hidden)   the staff
--
-- A report is the store requirement for anything people write: there must be a
-- way to flag it and someone who looks.

create table if not exists public.posts (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null references public.profiles on delete cascade,
  body        text not null default '' check (length(body) <= 500),
  photo_path  text,
  event_id    uuid references public.events on delete set null,
  is_hidden   boolean not null default false,
  created_at  timestamptz not null default now(),
  constraint posts_something check (length(btrim(body)) > 0 or photo_path is not null)
);
create index if not exists posts_author_idx on public.posts (author_id, created_at desc);
create index if not exists posts_recent_idx on public.posts (created_at desc);

create table if not exists public.post_reports (
  post_id     uuid not null references public.posts on delete cascade,
  reporter_id uuid not null references public.profiles on delete cascade,
  reason      text check (reason is null or length(reason) <= 300),
  created_at  timestamptz not null default now(),
  handled     boolean not null default false,
  primary key (post_id, reporter_id)
);

alter table public.posts enable row level security;
alter table public.post_reports enable row level security;
revoke all on public.posts, public.post_reports from public, anon, authenticated;

create or replace function public.can_see_post(p_author uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_author = auth.uid() or public.is_friend(p_author);
$$;
revoke all on function public.can_see_post(uuid) from public, anon;

create or replace function public.post_create(p_body text, p_photo text, p_event uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  r uuid;
begin
  perform public.need_account();
  if length(coalesce(p_body, '')) > 500 then raise exception 'at most 500 characters'; end if;
  if length(btrim(coalesce(p_body, ''))) = 0 and p_photo is null then raise exception 'a photo or a few words'; end if;
  if p_photo is not null and p_photo not like auth.uid()::text || '/%' then raise exception 'not your file'; end if;
  if p_event is not null and not exists (select 1 from public.events where id = p_event) then raise exception 'no such night'; end if;
  if (select count(*) from public.posts where author_id = auth.uid() and created_at > now() - interval '1 day') >= 20 then
    raise exception 'twenty today is enough; more tomorrow';
  end if;
  insert into public.posts (author_id, body, photo_path, event_id)
  values (auth.uid(), btrim(coalesce(p_body, '')), p_photo, p_event)
  returning id into r;
  return r;
end;
$$;

-- Returns the photo path, so the app can remove the file.
create or replace function public.post_delete(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.posts%rowtype;
begin
  select * into p from public.posts where id = p_id;
  if p.id is null then return null; end if;
  if p.author_id <> auth.uid() and not public.is_staff() then raise exception 'not your post' using errcode = '42501'; end if;
  delete from public.posts where id = p_id;
  if p.author_id <> auth.uid() then perform public.staff_note('delete', 'post', p_id::text, left(p.body, 80)); end if;
  return p.photo_path;
end;
$$;

-- 55 adds columns; a second run of the setup meets that shape first.
drop function if exists public.posts_feed(timestamptz, int);
create or replace function public.posts_feed(p_before timestamptz default null, p_limit int default 20)
returns table (id uuid, author_id uuid, handle text, name text, body text, photo_path text,
               event_slug text, event_title text, created_at timestamptz, mine boolean)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.author_id, pr.handle, pr.display_name, p.body, p.photo_path, e.slug, e.title, p.created_at,
         p.author_id = auth.uid()
  from public.posts p
  join public.profiles pr on pr.id = p.author_id
  left join public.events e on e.id = p.event_id
  where auth.uid() is not null
    and not p.is_hidden
    and public.can_see_post(p.author_id)
    and (p_before is null or p.created_at < p_before)
  order by p.created_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;

create or replace function public.post_report(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a uuid;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select author_id into a from public.posts where id = p_id;
  if a is null or not public.can_see_post(a) then raise exception 'no such post'; end if;
  if a = auth.uid() then raise exception 'your own post: delete it instead'; end if;
  insert into public.post_reports (post_id, reporter_id, reason)
  values (p_id, auth.uid(), left(nullif(btrim(p_reason), ''), 300))
  on conflict (post_id, reporter_id) do nothing;
end;
$$;

create or replace function public.staff_posts_reported()
returns table (id uuid, body text, photo_path text, author text, reports int, reasons text[], is_hidden boolean, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  return query
    select p.id, p.body, p.photo_path, coalesce(pr.handle, pr.display_name), count(r.*)::int,
           array_remove(array_agg(r.reason), null), p.is_hidden, p.created_at
    from public.post_reports r
    join public.posts p on p.id = r.post_id
    join public.profiles pr on pr.id = p.author_id
    where not r.handled
    group by p.id, pr.handle, pr.display_name
    order by count(r.*) desc, max(r.created_at) desc;
end;
$$;

-- Hiding settles the reports; showing again (a wrong report) settles them too.
create or replace function public.staff_post_hide(p_id uuid, p_hidden boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  update public.posts set is_hidden = coalesce(p_hidden, true) where id = p_id;
  update public.post_reports set handled = true where post_id = p_id;
  perform public.staff_note(case when coalesce(p_hidden, true) then 'hide' else 'show' end, 'post', p_id::text, null);
end;
$$;

-- The panel counts what waits.
create or replace function public.admin_overview()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  return json_build_object(
    'people', (select count(*) from public.profiles),
    'people_week', (select count(*) from public.profiles where created_at > now() - interval '7 days'),
    'managers', (select count(*) from public.profiles where account_type = 'community_manager'),
    'djs', (select count(*) from public.profiles where account_type = 'dj'),
    'nights_ahead', (select count(*) from public.events where is_published and starts_at > now()),
    'nights_staff', (select count(*) from public.events where source = 'staff'),
    'venues', (select count(*) from public.venues),
    'comments_week', (select count(*) from public.comments where created_at > now() - interval '7 days'),
    'pending', (select count(*) from public.events where review = 'pending'),
    'reported', (select count(distinct post_id) from public.post_reports where not handled),
    'feedback_open', case when public.is_admin() then (select count(*) from public.feedback where not handled) end
  );
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'post_create(text, text, uuid)', 'post_delete(uuid)', 'posts_feed(timestamptz, int)',
    'post_report(uuid, text)', 'staff_posts_reported()', 'staff_post_hide(uuid, boolean)', 'admin_overview()'
  ] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('45_posts.sql', '466a971652fc35d228348cb57c334e6e0f9cd2f9347c31e343d8b7f7bcb29ae5');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('45_posts.sql');
  end if;
end $$;


-- ============================================================
--  A GROUP DECIDES — VOTES, THE PLAN, TICKETS, THE CHAT   (46_group_plans.sql)
-- ============================================================

-- afterhours — a group decides and makes a plan (46, after 44_groups.sql)
--
-- From the matches to one night:
--
--   a vote      any member puts two or three nights to a vote for 1, 3, 12 or 24
--               hours; one vote each, changeable until it closes. It closes when
--               the time is up or everyone has voted; the night with most votes
--               wins (a tie goes to the one more members kept in the group, then
--               the earlier one) and becomes the plan. One vote open at a time.
--   the plan    one night per group. Any member can set it straight from the
--               matches too. Who comes is the usual in · maybe · out (32_rsvp.sql:
--               rsvp_set), shown here for the members; and each says whether they
--               have a ticket, so the group sees who still needs one.
--   the chat    a thread for the group. Setting a plan, starting a vote and its
--               result are written into it as well.
--
-- Closed tables again; every function checks membership first (need_member, 44).

alter table public.groups add column if not exists plan_event_id uuid references public.events on delete set null;
alter table public.groups add column if not exists plan_set_by uuid references public.profiles on delete set null;
alter table public.groups add column if not exists plan_set_at timestamptz;

create table if not exists public.group_rounds (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null references public.groups on delete cascade,
  started_by   uuid references public.profiles on delete set null,
  created_at   timestamptz not null default now(),
  closes_at    timestamptz not null,
  closed_at    timestamptz,
  winner_id    uuid references public.events on delete set null
);
create index if not exists group_rounds_group_idx on public.group_rounds (group_id, created_at desc);
create unique index if not exists group_rounds_one_open on public.group_rounds (group_id) where closed_at is null;

create table if not exists public.group_round_options (
  round_id  uuid not null references public.group_rounds on delete cascade,
  event_id  uuid not null references public.events on delete cascade,
  primary key (round_id, event_id)
);

create table if not exists public.group_ballots (
  round_id  uuid not null references public.group_rounds on delete cascade,
  user_id   uuid not null references public.profiles on delete cascade,
  event_id  uuid not null references public.events on delete cascade,
  at        timestamptz not null default now(),
  primary key (round_id, user_id)
);

create table if not exists public.group_tickets (
  group_id  uuid not null references public.groups on delete cascade,
  event_id  uuid not null references public.events on delete cascade,
  user_id   uuid not null references public.profiles on delete cascade,
  primary key (group_id, event_id, user_id)
);

create table if not exists public.group_messages (
  id          bigserial primary key,
  group_id    uuid not null references public.groups on delete cascade,
  user_id     uuid references public.profiles on delete set null,
  kind        text not null default 'say' check (kind in ('say', 'plan', 'round', 'won')),
  body        text not null check (length(body) between 1 and 1000),
  event_id    uuid references public.events on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists group_messages_group_idx on public.group_messages (group_id, id);

alter table public.group_rounds enable row level security;
alter table public.group_round_options enable row level security;
alter table public.group_ballots enable row level security;
alter table public.group_tickets enable row level security;
alter table public.group_messages enable row level security;
revoke all on public.group_rounds, public.group_round_options, public.group_ballots,
              public.group_tickets, public.group_messages from public, anon, authenticated;

-- ------------------------------------------------------------- helpers

create or replace function public.group_note(p_group uuid, p_kind text, p_body text, p_event uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.group_messages (group_id, user_id, kind, body, event_id)
  values (p_group, auth.uid(), p_kind, left(p_body, 1000), p_event);
$$;
revoke all on function public.group_note(uuid, text, text, uuid) from public, anon, authenticated;

-- A night a group can still go to.
create or replace function public.night_ahead(p_event uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.events e where e.id = p_event and e.is_published
                 and (e.starts_at is null or e.starts_at > now() - interval '6 hours'));
$$;

-- Closes a round whose time is up or that everyone voted in; the winner becomes the plan.
create or replace function public.round_settle(p_round uuid, p_force boolean default false)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.group_rounds%rowtype;
  members int;
  voted int;
  w uuid;
  title text;
begin
  select * into r from public.group_rounds where id = p_round for update;
  if r.id is null or r.closed_at is not null then return r.winner_id; end if;
  select count(*) into members from public.group_members where group_id = r.group_id;
  select count(*) into voted from public.group_ballots b
    join public.group_members m on m.group_id = r.group_id and m.user_id = b.user_id where b.round_id = r.id;
  if not p_force and r.closes_at > now() and voted < members then return null; end if;
  select o.event_id into w
  from public.group_round_options o
  join public.events e on e.id = o.event_id
  where o.round_id = r.id
  order by (select count(*) from public.group_ballots b where b.round_id = r.id and b.event_id = o.event_id) desc,
           (select count(*) from public.group_swipes s where s.group_id = r.group_id and s.event_id = o.event_id and s.direction = 'right') desc,
           e.starts_at nulls last, e.id
  limit 1;
  update public.group_rounds set closed_at = now(), winner_id = w where id = r.id;
  if w is not null and voted > 0 then
    update public.groups set plan_event_id = w, plan_set_by = r.started_by, plan_set_at = now() where id = r.group_id;
    select e.title into title from public.events e where e.id = w;
    insert into public.group_messages (group_id, user_id, kind, body, event_id) values (r.group_id, null, 'won', title, w);
  end if;
  return w;
end;
$$;
revoke all on function public.round_settle(uuid, boolean) from public, anon, authenticated;

-- --------------------------------------------------------------- votes

create or replace function public.round_start(p_group uuid, p_events uuid[], p_hours int)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  open_round uuid;
  r uuid;
  e uuid;
  picked uuid[] := array(select distinct x from unnest(coalesce(p_events, '{}')) x);
begin
  perform public.need_member(p_group);
  select id into open_round from public.group_rounds where group_id = p_group and closed_at is null;
  if open_round is not null then perform public.round_settle(open_round); end if;
  if exists (select 1 from public.group_rounds where group_id = p_group and closed_at is null) then
    raise exception 'a vote is already open';
  end if;
  if cardinality(picked) not between 2 and 3 then raise exception 'two or three nights'; end if;
  if coalesce(p_hours, 0) not in (1, 3, 12, 24) then raise exception '1, 3, 12 or 24 hours'; end if;
  foreach e in array picked loop
    if not public.night_ahead(e) then raise exception 'one of those nights is over or gone'; end if;
  end loop;
  insert into public.group_rounds (group_id, started_by, closes_at)
  values (p_group, auth.uid(), now() + make_interval(hours => p_hours)) returning id into r;
  insert into public.group_round_options (round_id, event_id) select r, x from unnest(picked) x;
  perform public.group_note(p_group, 'round', (select string_agg(title, ' · ') from public.events where id = any(picked)), null);
  return r;
end;
$$;

create or replace function public.round_vote(p_round uuid, p_event uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.group_rounds%rowtype;
begin
  select * into r from public.group_rounds where id = p_round;
  if r.id is null then raise exception 'no such vote'; end if;
  perform public.need_member(r.group_id);
  perform public.round_settle(r.id);
  if (select closed_at from public.group_rounds where id = r.id) is not null then raise exception 'this vote is closed'; end if;
  if not exists (select 1 from public.group_round_options where round_id = r.id and event_id = p_event) then
    raise exception 'not one of the choices';
  end if;
  insert into public.group_ballots (round_id, user_id, event_id) values (r.id, auth.uid(), p_event)
  on conflict (round_id, user_id) do update set event_id = excluded.event_id, at = now();
  perform public.round_settle(r.id);
end;
$$;

-- Whoever started it, or the owner, ends it early (the votes so far decide).
create or replace function public.round_close(p_round uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.group_rounds%rowtype;
begin
  select * into r from public.group_rounds where id = p_round;
  if r.id is null then raise exception 'no such vote'; end if;
  perform public.need_member(r.group_id);
  if r.started_by is distinct from auth.uid()
     and not exists (select 1 from public.group_members where group_id = r.group_id and user_id = auth.uid() and role = 'owner') then
    raise exception 'whoever started it, or the owner' using errcode = '42501';
  end if;
  return public.round_settle(r.id, true);
end;
$$;

-- ---------------------------------------------------------------- plan

create or replace function public.plan_set(p_group uuid, p_event uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_group);
  if p_event is null then
    update public.groups set plan_event_id = null, plan_set_by = auth.uid(), plan_set_at = now() where id = p_group;
    return;
  end if;
  if not public.night_ahead(p_event) then raise exception 'that night is over or gone'; end if;
  update public.groups set plan_event_id = p_event, plan_set_by = auth.uid(), plan_set_at = now() where id = p_group;
  perform public.group_note(p_group, 'plan', (select title from public.events where id = p_event), p_event);
end;
$$;

create or replace function public.plan_ticket(p_group uuid, p_got boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e uuid;
begin
  perform public.need_member(p_group);
  select plan_event_id into e from public.groups where id = p_group;
  if e is null then raise exception 'no plan yet'; end if;
  if p_got then
    insert into public.group_tickets (group_id, event_id, user_id) values (p_group, e, auth.uid()) on conflict do nothing;
  else
    delete from public.group_tickets where group_id = p_group and event_id = e and user_id = auth.uid();
  end if;
end;
$$;

-- Everything the plan tab shows, in one read. Settles a vote whose time is up.
create or replace function public.group_plan(p_group uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  g public.groups%rowtype;
  r public.group_rounds%rowtype;
  open_id uuid;
begin
  perform public.need_member(p_group);
  select id into open_id from public.group_rounds where group_id = p_group and closed_at is null;
  if open_id is not null then perform public.round_settle(open_id); end if;
  select * into g from public.groups where id = p_group;
  select * into r from public.group_rounds where group_id = p_group and closed_at is null;
  return json_build_object(
    'members', (select count(*) from public.group_members where group_id = p_group),
    'round', case when r.id is null then null else json_build_object(
      'id', r.id, 'closes_at', r.closes_at,
      'started_by', (select coalesce(p.display_name, p.handle) from public.profiles p where p.id = r.started_by),
      'mine', r.started_by = auth.uid(),
      'voted', (select count(*) from public.group_ballots where round_id = r.id),
      'my_vote', (select event_id from public.group_ballots where round_id = r.id and user_id = auth.uid()),
      'options', (select json_agg(json_build_object(
          'id', e.id, 'slug', e.slug, 'title', e.title, 'starts_at', e.starts_at, 'venue_name', v.name, 'image_url', e.image_url,
          'votes', (select count(*) from public.group_ballots b where b.round_id = r.id and b.event_id = e.id),
          'voters', (select coalesce(json_agg(coalesce(p.display_name, p.handle)), '[]'::json) from public.group_ballots b
                     join public.profiles p on p.id = b.user_id where b.round_id = r.id and b.event_id = e.id)) order by e.starts_at)
        from public.group_round_options o join public.events e on e.id = o.event_id left join public.venues v on v.id = e.venue_id
        where o.round_id = r.id)) end,
    'plan', case when g.plan_event_id is null or not public.night_ahead(g.plan_event_id) then null else (
      select json_build_object(
        'id', e.id, 'slug', e.slug, 'title', e.title, 'starts_at', e.starts_at, 'venue_name', v.name, 'city_name', c.name,
        'image_url', e.image_url, 'ticket_url', e.ticket_url,
        'set_by', (select coalesce(p.display_name, p.handle) from public.profiles p where p.id = g.plan_set_by),
        'people', (select json_agg(json_build_object(
            'id', p.id, 'name', coalesce(p.display_name, p.handle),
            'answer', (select a.answer from public.rsvps a where a.user_id = p.id and a.event_id = e.id),
            'ticket', exists (select 1 from public.group_tickets t where t.group_id = p_group and t.event_id = e.id and t.user_id = p.id))
            order by m.joined_at)
          from public.group_members m join public.profiles p on p.id = m.user_id where m.group_id = p_group))
      from public.events e join public.cities c on c.id = e.city_id left join public.venues v on v.id = e.venue_id
      where e.id = g.plan_event_id) end
  );
end;
$$;

-- ---------------------------------------------------------------- chat

create or replace function public.group_say(p_group uuid, p_body text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  r bigint;
begin
  perform public.need_member(p_group);
  if length(btrim(coalesce(p_body, ''))) not between 1 and 1000 then raise exception '1 to 1000 characters'; end if;
  if (select count(*) from public.group_messages where user_id = auth.uid() and created_at > now() - interval '1 minute') >= 20 then
    raise exception 'slow down a little';
  end if;
  insert into public.group_messages (group_id, user_id, body) values (p_group, auth.uid(), btrim(p_body)) returning id into r;
  return r;
end;
$$;

create or replace function public.group_unsay(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.group_messages where id = p_id and user_id = auth.uid() and kind = 'say';
end;
$$;

-- The thread after message p_after (0: the last 80), oldest first.
create or replace function public.group_thread(p_group uuid, p_after bigint default 0)
returns table (id bigint, user_id uuid, name text, kind text, body text, event_slug text, created_at timestamptz, mine boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_group);
  return query
    select * from (
      select m.id, m.user_id, coalesce(p.display_name, p.handle), m.kind, m.body, e.slug, m.created_at, m.user_id = auth.uid()
      from public.group_messages m
      left join public.profiles p on p.id = m.user_id
      left join public.events e on e.id = m.event_id
      where m.group_id = p_group and m.id > coalesce(p_after, 0)
      order by m.id desc
      limit 80) x
    order by x.id;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'night_ahead(uuid)', 'round_start(uuid, uuid[], int)', 'round_vote(uuid, uuid)', 'round_close(uuid)',
    'plan_set(uuid, uuid)', 'plan_ticket(uuid, boolean)', 'group_plan(uuid)',
    'group_say(uuid, text)', 'group_unsay(bigint)', 'group_thread(uuid, bigint)'
  ] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('46_group_plans.sql', '8f2895631eb58bb03e788cb0d06b2fb85bd9dfa6af3d34081d246d7501084feb');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('46_group_plans.sql');
  end if;
end $$;


-- ============================================================
--  THE NIGHT AND AFTER — GROUP NIGHTS, THE ALBUM, NUMBERS, ALSO THERE   (47_group_nights.sql)
-- ============================================================

-- afterhours — the night and after, for a group (47, after 44 and 46)
--
--   group nights   a night at least two members checked in to (19_checkins.sql).
--                  Nothing to press: checking in as usual is enough. It is the
--                  card of the group: who was there, their card numbers, and "all of
--                  us" when everyone was.
--   the shelf      those nights, newest first: the collection of the group.
--   the album      photos members add to one of those nights (or to the plan),
--                  each into their own folder of the photos bucket. Members see
--                  them; the one who added it, or the owner, takes it out.
--   numbers        nights this year, the room you go to most, who comes most,
--                  matches and votes; and the vibe: the kinds you say yes to most,
--                  the hour your nights start, your room.
--   also there     a group may let itself be seen (visible, off by default).
--                  When such a group has the same plan as yours and one of your
--                  friends is in it, your plan says so: name, emoji, which friends.

alter table public.groups add column if not exists visible boolean not null default false;

create table if not exists public.group_photos (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.groups on delete cascade,
  event_id    uuid not null references public.events on delete cascade,
  user_id     uuid references public.profiles on delete set null,
  path        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists group_photos_idx on public.group_photos (group_id, event_id, created_at);
alter table public.group_photos enable row level security;
revoke all on public.group_photos from public, anon, authenticated;

-- ---------------------------------------------------------- group nights

-- No membership check here: callers check.
create or replace function public.group_night_rows(p_group uuid)
returns table (event_id uuid, people uuid[], cards bigint[], first_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select c.event_id, array_agg(c.user_id order by c.checked_at), array_agg(c.card_no order by c.checked_at), min(c.checked_at)
  from public.checkins c
  join public.group_members m on m.group_id = p_group and m.user_id = c.user_id
  group by c.event_id
  having count(*) >= 2;
$$;
revoke all on function public.group_night_rows(uuid) from public, anon, authenticated;

create or replace function public.group_nights(p_group uuid)
returns table (id uuid, slug text, title text, starts_at timestamptz, venue_name text, city_name text, image_url text,
               people json, all_of_us boolean, photos int, cover text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  n int;
begin
  perform public.need_member(p_group);
  select count(*) into n from public.group_members where group_id = p_group;
  return query
    select e.id, e.slug, e.title, e.starts_at, v.name, c.name, e.image_url,
           (select json_agg(json_build_object('id', p.id, 'name', coalesce(p.display_name, p.handle), 'card', r.cards[i]) order by i)
              from generate_subscripts(r.people, 1) i join public.profiles p on p.id = r.people[i]),
           cardinality(r.people) >= n,
           (select count(*)::int from public.group_photos ph where ph.group_id = p_group and ph.event_id = e.id),
           (select ph.path from public.group_photos ph where ph.group_id = p_group and ph.event_id = e.id order by ph.created_at limit 1)
    from public.group_night_rows(p_group) r
    join public.events e on e.id = r.event_id
    join public.cities c on c.id = e.city_id
    left join public.venues v on v.id = e.venue_id
    order by coalesce(e.starts_at, r.first_at) desc;
end;
$$;

-- ------------------------------------------------------------ the album

-- A night a group may keep photos of: one of its nights, or its plan.
create or replace function public.group_album_ok(p_group uuid, p_event uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.group_night_rows(p_group) r where r.event_id = p_event)
      or exists (select 1 from public.groups g where g.id = p_group and g.plan_event_id = p_event);
$$;
revoke all on function public.group_album_ok(uuid, uuid) from public, anon, authenticated;

create or replace function public.group_photo_add(p_group uuid, p_event uuid, p_path text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  r uuid;
begin
  perform public.need_member(p_group);
  if p_path is null or p_path not like auth.uid()::text || '/%' then raise exception 'not your file'; end if;
  if not public.group_album_ok(p_group, p_event) then raise exception 'only nights the group went to (or its plan)'; end if;
  if (select count(*) from public.group_photos where group_id = p_group and event_id = p_event) >= 200 then
    raise exception 'this album is full (200)';
  end if;
  insert into public.group_photos (group_id, event_id, user_id, path) values (p_group, p_event, auth.uid(), p_path) returning id into r;
  return r;
end;
$$;

-- Returns the file path, so the app can remove the file when the caller added it.
create or replace function public.group_photo_remove(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  ph public.group_photos%rowtype;
begin
  select * into ph from public.group_photos where id = p_id;
  if ph.id is null then return null; end if;
  perform public.need_member(ph.group_id);
  if ph.user_id is distinct from auth.uid()
     and not exists (select 1 from public.group_members where group_id = ph.group_id and user_id = auth.uid() and role = 'owner') then
    raise exception 'whoever added it, or the owner' using errcode = '42501';
  end if;
  delete from public.group_photos where id = p_id;
  return ph.path;
end;
$$;

create or replace function public.group_album(p_group uuid, p_event uuid)
returns table (id uuid, path text, user_id uuid, name text, created_at timestamptz, mine boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_group);
  return query
    select ph.id, ph.path, ph.user_id, coalesce(p.display_name, p.handle), ph.created_at, ph.user_id = auth.uid()
    from public.group_photos ph left join public.profiles p on p.id = ph.user_id
    where ph.group_id = p_group and ph.event_id = p_event
    order by ph.created_at;
end;
$$;

-- -------------------------------------------------------------- numbers

create or replace function public.group_stats(p_group uuid)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  members uuid[];
begin
  perform public.need_member(p_group);
  members := array(select user_id from public.group_members where group_id = p_group);
  return json_build_object(
    'nights', (select count(*) from public.group_night_rows(p_group)),
    'nights_year', (select count(*) from public.group_night_rows(p_group) r join public.events e on e.id = r.event_id
                    where coalesce(e.starts_at, r.first_at) >= date_trunc('year', now())),
    'room', (select v.name from public.group_night_rows(p_group) r join public.events e on e.id = r.event_id
             join public.venues v on v.id = e.venue_id group by v.name order by count(*) desc, v.name limit 1),
    'regular', (select json_build_object('name', coalesce(p.display_name, p.handle), 'n', count(*))
                from public.group_night_rows(p_group) r cross join lateral unnest(r.people) u(uid) join public.profiles p on p.id = u.uid
                group by p.id, p.display_name, p.handle order by count(*) desc, p.display_name limit 1),
    'matches', (select count(*) from (
                  select s.event_id from public.group_swipes s where s.group_id = p_group and s.direction = 'right'
                    and s.user_id = any(members)
                  group by s.event_id having count(*) = cardinality(members)) x),
    'votes', (select count(*) from public.group_rounds where group_id = p_group),
    'photos', (select count(*) from public.group_photos where group_id = p_group),
    -- the vibe: from every yes said in the group and every night gone to together
    'kinds', (select coalesce(json_agg(k.name), '[]'::json) from (
                select t.name from (
                  select s.event_id from public.group_swipes s where s.group_id = p_group and s.direction = 'right'
                  union all select r.event_id from public.group_night_rows(p_group) r) x
                join public.events e on e.id = x.event_id join public.event_types t on t.id = e.type_id
                group by t.name order by count(*) desc, t.name limit 2) k),
    -- averaged from 18:00, so 23:00 and 01:00 make midnight, not noon
    'hour', (select ((round(avg(((extract(hour from e.starts_at) + 6)::int % 24)))::int + 18) % 24)
             from (select s.event_id from public.group_swipes s where s.group_id = p_group and s.direction = 'right'
                   union all select r.event_id from public.group_night_rows(p_group) r) x
             join public.events e on e.id = x.event_id where e.starts_at is not null)
  );
end;
$$;

-- ------------------------------------------------------------ also there

create or replace function public.group_set_visible(p_group uuid, p_visible boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_group);
  if not exists (select 1 from public.group_members where group_id = p_group and user_id = auth.uid() and role = 'owner') then
    raise exception 'only the owner' using errcode = '42501';
  end if;
  update public.groups set visible = coalesce(p_visible, false) where id = p_group;
end;
$$;

-- Visible groups with the same plan as this one, that have a friend of yours in them.
create or replace function public.group_also_there(p_group uuid)
returns table (id uuid, name text, emoji text, color text, friends text[])
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  e uuid;
begin
  perform public.need_member(p_group);
  select g0.plan_event_id into e from public.groups g0 where g0.id = p_group;
  if e is null then return; end if;
  return query
    select g.id, g.name, g.emoji, g.color,
           array(select coalesce(p.display_name, p.handle) from public.group_members m join public.profiles p on p.id = m.user_id
                 where m.group_id = g.id and public.is_friend(m.user_id) order by p.display_name)
    from public.groups g
    where g.id <> p_group and g.visible and g.plan_event_id = e
      and not public.in_group(g.id)
      and exists (select 1 from public.group_members m where m.group_id = g.id and public.is_friend(m.user_id))
    order by g.name
    limit 10;
end;
$$;

-- group_get now says whether the group can be seen.
create or replace function public.group_get(p_id uuid)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_id);
  return (
    select json_build_object(
      'id', g.id, 'name', g.name, 'emoji', g.emoji, 'color', g.color, 'cover_path', g.cover_path,
      'kind', g.kind, 'city_slug', g.city_slug, 'date_from', g.date_from, 'date_to', g.date_to,
      'archived', g.kind = 'once' and g.date_to < current_date, 'visible', g.visible,
      'me', auth.uid(),
      'members', (select json_agg(json_build_object('id', p.id, 'handle', p.handle, 'name', p.display_name, 'role', m.role) order by m.joined_at)
                  from public.group_members m join public.profiles p on p.id = m.user_id where m.group_id = g.id))
    from public.groups g where g.id = p_id);
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'group_nights(uuid)', 'group_photo_add(uuid, uuid, text)', 'group_photo_remove(uuid)', 'group_album(uuid, uuid)',
    'group_stats(uuid)', 'group_set_visible(uuid, boolean)', 'group_also_there(uuid)', 'group_get(uuid)'
  ] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('47_group_nights.sql', '7d742346236655ea89cbb76c5bcc08bc3a959115c306282529b347ac6c86b921');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('47_group_nights.sql');
  end if;
end $$;


-- ============================================================
--  GROUPS AND POSTS SAY SO — PUSH NOTIFICATIONS   (48_group_push.sql)
-- ============================================================

-- afterhours — groups and posts say so: push notifications (48, after 26, 34, 44 to 47)
--
-- The same path as every other push (26_push.sql): a trigger writes a row to
-- push_outbox, the outbox sends it. Two new switches in the settings:
--
--   notify_groups   group_added    someone put you in a group
--                   group_joined   someone came in with the code
--                   group_match    a night everyone in the group said yes to
--                   group_round    a vote started
--                   group_won      a vote is decided
--                   group_plan     a member set the plan
--                   group_message  a line in the chat; at most one per group and
--                                  ten minutes, so a lively chat is one buzz
--                   group_live     someone opened live and nobody else is there;
--                                  at once, also in quiet hours (it is now or never),
--                                  at most once per group and half hour
--                   group_ticket   the plan is tomorrow, you said in or maybe and
--                                  have no ticket (the hourly job below)
--   notify_posts    post           a friend posted (counts against the ten a day)
--
-- Nobody hears about what they did themselves. Every trigger swallows its own
-- errors: a push that fails never stops the thing that caused it.
--
-- push_wants, push_enqueue and push_text are the ones from 26 with the new kinds
-- added; nothing else in them changes.

alter table public.profile_settings add column if not exists notify_groups boolean not null default true;
alter table public.profile_settings add column if not exists notify_posts boolean not null default true;

alter table public.push_outbox drop constraint if exists push_outbox_kind_check;
alter table public.push_outbox add constraint push_outbox_kind_check check (kind in (
  'friend_request', 'friend_accepted', 'match', 'friend_live',
  'night_soon', 'room_open', 'room_closing', 'room_message', 'reply',
  'digest', 'dj_live', 'wave', 'spark', 'spark_in',
  'group_added', 'group_joined', 'group_match', 'group_round', 'group_won', 'group_plan',
  'group_message', 'group_live', 'group_ticket', 'post',
  -- 54_upkeep.sql: the staff, when something waits in the panel
  'staff',
  -- 55_post_social.sql: someone liked or commented on your post
  'post_like', 'post_comment'));

create or replace function public.push_wants(p_user uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select case
             when p_kind = 'friend_request'  then s.notify_requests
             when p_kind = 'friend_accepted' then s.notify_accepts
             when p_kind = 'match'           then s.notify_matches
             when p_kind = 'friend_live'     then s.notify_live
             when p_kind = 'night_soon'      then s.notify_nights
             when p_kind in ('room_open', 'room_closing', 'room_message') then s.notify_rooms
             when p_kind = 'reply'           then s.notify_replies
             when p_kind = 'digest'          then s.notify_digest
             when p_kind = 'dj_live'         then s.notify_djs
             when p_kind = 'wave'            then s.notify_waves
             when p_kind in ('spark', 'spark_in') then s.notify_sparks
             when p_kind like 'group\_%' then s.notify_groups
             when p_kind in ('post', 'post_like', 'post_comment') then s.notify_posts
           end
    from public.profile_settings s where s.user_id = p_user), true);
$$;


create or replace function public.push_enqueue(p_user uuid, p_kind text, p_key text, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  zone  text;
  here  timestamp;
  due   timestamptz := now();
begin
  if not public.push_wants(p_user, p_kind) then
    return;
  end if;
  -- the daily cap for the chattier kinds
  if p_kind in ('room_message', 'digest', 'dj_live', 'wave', 'post', 'post_like')
     and (select count(*) from public.push_outbox o
          where o.user_id = p_user and o.created_at > now() - interval '1 day'
            and o.kind in ('room_message', 'digest', 'dj_live', 'wave', 'post', 'post_like')) >= 10 then
    return;
  end if;
  -- quiet hours: wait for 09:00 on the phone
  if p_kind not in ('friend_live', 'room_open', 'room_closing', 'room_message', 'night_soon', 'dj_live', 'group_live') then
    zone := public.push_zone(p_user);
    here := now() at time zone zone;
    if extract(hour from here) < 9 then
      due := (date_trunc('day', here) + interval '9 hours') at time zone zone;
    end if;
  end if;
  insert into public.push_outbox (user_id, kind, key, data, send_after)
  values (p_user, p_kind, p_key, p_data, due)
  on conflict (key) do nothing;
end;
$$;


-- ------------------------------------------------------------ the words

create or replace function public.push_text(p_kind text, p_lang text, p_data jsonb)
returns table (title text, body text)
language plpgsql
immutable
as $$
declare
  pair record;
begin
  select x.title, x.body into title, body
  from (values
    ('friend_request',  'en', 'friend request',                '{name} wants to add you'),
    ('friend_request',  'de', 'freundschaftsanfrage',          '{name} möchte dich hinzufügen'),
    ('friend_request',  'tr', 'arkadaşlık isteği',             '{name} seni eklemek istiyor'),
    ('friend_accepted', 'en', 'you are friends now',           '{name} accepted your request'),
    ('friend_accepted', 'de', 'ihr seid jetzt freunde',        '{name} hat deine anfrage angenommen'),
    ('friend_accepted', 'tr', 'artık arkadaşsınız',            '{name} isteğini kabul etti'),
    ('match',           'en', '{name} is going too',           '{title}'),
    ('match',           'de', '{name} geht auch hin',          '{title}'),
    ('match',           'tr', '{name} de gidiyor',             '{title}'),
    ('friend_live',     'en', '{name} is out now',             '{title}'),
    ('friend_live',     'de', '{name} ist gerade unterwegs',   '{title}'),
    ('friend_live',     'tr', '{name} şu an dışarıda',         '{title}'),
    ('night_soon',      'en', 'tonight · {time}',              '{title}'),
    ('night_soon',      'de', 'heute nacht · {time}',          '{title}'),
    ('night_soon',      'tr', 'bu gece · {time}',              '{title}'),
    ('room_open',       'en', 'your room is open',             '{title} · 48 hours to write'),
    ('room_open',       'de', 'dein raum ist offen',           '{title} · 48 stunden zum schreiben'),
    ('room_open',       'tr', 'odan açık',                     '{title} · 48 saat yazabilirsin'),
    ('room_closing',    'en', 'your room closes soon',         '{title} · the last two hours'),
    ('room_closing',    'de', 'dein raum schließt bald',       '{title} · die letzten zwei stunden'),
    ('room_closing',    'tr', 'odan birazdan kapanıyor',       '{title} · son iki saat'),
    ('room_message',    'en', '{name} in {title}',             '{text}'),
    ('room_message',    'de', '{name} in {title}',             '{text}'),
    ('room_message',    'tr', '{title} · {name}',              '{text}'),
    ('reply',           'en', '{name} replied',                '{text}'),
    ('reply',           'de', '{name} hat geantwortet',        '{text}'),
    ('reply',           'tr', '{name} cevap verdi',            '{text}'),
    ('digest',          'en', 'this weekend in {city}',        '{n} nights · {friends} kept by friends'),
    ('digest',          'de', 'dieses wochenende in {city}',   '{n} nächte · {friends} von freunden behalten'),
    ('digest',          'tr', 'bu hafta sonu {city}',          '{n} gece · {friends} tanesini arkadaşların sakladı'),
    ('dj_live',         'en', '{name} plays soon',             '{where} · {time}'),
    ('dj_live',         'de', '{name} legt bald auf',          '{where} · {time}'),
    ('dj_live',         'tr', '{name} birazdan çalıyor',       '{where} · {time}'),
    ('wave',            'en', '2nd wave',                      'a friend of {via} kept {title}'),
    ('wave',            'de', '2. welle',                      'ein freund von {via} hat {title} behalten'),
    ('wave',            'tr', '2. dalga',                      '{via} üzerinden biri {title} gecesini sakladı'),
    ('spark',           'en', '{name} is starting something',  '{title} · {when}'),
    ('spark',           'de', '{name} startet etwas',          '{title} · {when}'),
    ('spark',           'tr', '{name} bir şey başlatıyor',     '{title} · {when}'),
    ('spark_in',        'en', '{name} is in',                  '{title}'),
    ('spark_in',        'de', '{name} ist dabei',              '{title}'),
    ('spark_in',        'tr', '{name} geliyor',                '{title}'),
    ('group_added',     'en', 'you are in {group}',            '{name} added you · swipe nights together'),
    ('group_added',     'de', 'du bist in {group}',            '{name} hat dich hinzugefügt · wischt zusammen'),
    ('group_added',     'tr', '{group} grubundasın',           '{name} seni ekledi · birlikte gece seçin'),
    ('group_joined',    'en', '{group}',                       '{name} joined'),
    ('group_joined',    'de', '{group}',                       '{name} ist dazugekommen'),
    ('group_joined',    'tr', '{group}',                       '{name} gruba katıldı'),
    ('group_match',     'en', '{group} · everyone is in',      '{title}'),
    ('group_match',     'de', '{group} · alle sind dabei',     '{title}'),
    ('group_match',     'tr', '{group} · herkes var',          '{title}'),
    ('group_round',     'en', '{group} · vote',                '{name} put {title} to a vote'),
    ('group_round',     'de', '{group} · abstimmung',          '{name} lässt abstimmen: {title}'),
    ('group_round',     'tr', '{group} · oylama',              '{name} oylamaya sundu: {title}'),
    ('group_won',       'en', '{group} · the vote is in',      '{title}'),
    ('group_won',       'de', '{group} · abgestimmt',          '{title}'),
    ('group_won',       'tr', '{group} · oylama bitti',        '{title}'),
    ('group_plan',      'en', '{group} · the plan',            '{name}: {title}'),
    ('group_plan',      'de', '{group} · der plan',            '{name}: {title}'),
    ('group_plan',      'tr', '{group} · plan',                '{name}: {title}'),
    ('group_message',   'en', '{group} · {name}',              '{text}'),
    ('group_message',   'de', '{group} · {name}',              '{text}'),
    ('group_message',   'tr', '{group} · {name}',              '{text}'),
    ('group_live',      'en', '{group} · live now',            '{name} wants to swipe together, now'),
    ('group_live',      'de', '{group} · gerade live',         '{name} will jetzt zusammen wischen'),
    ('group_live',      'tr', '{group} · şimdi canlı',         '{name} şimdi birlikte kaydırmak istiyor'),
    ('group_ticket',    'en', '{group} · tomorrow',            'you are in for {title} but have no ticket yet'),
    ('group_ticket',    'de', '{group} · morgen',              'du bist bei {title} dabei, hast aber noch kein ticket'),
    ('group_ticket',    'tr', '{group} · yarın',               '{title} için geliyorsun ama henüz biletin yok'),
    ('post',            'en', '{name} posted',                 '{text}'),
    ('post',            'de', '{name} hat gepostet',           '{text}'),
    ('post',            'tr', '{name} paylaştı',               '{text}'),
    ('post_like',       'en', '{name} likes your post',        '{text}'),
    ('post_like',       'de', '{name} gefällt dein post',      '{text}'),
    ('post_like',       'tr', '{name} gönderini beğendi',      '{text}'),
    ('post_comment',    'en', '{name} commented',              '{text}'),
    ('post_comment',    'de', '{name} hat kommentiert',        '{text}'),
    ('post_comment',    'tr', '{name} yorum yaptı',            '{text}'),
    ('staff',           'en', 'the panel',                     '{n} waiting: reports, nights sent in, dj pages'),
    ('staff',           'de', 'das panel',                     '{n} warten: meldungen, eingesandte nächte, dj-seiten'),
    ('staff',           'tr', 'panel',                         '{n} iş bekliyor: şikayetler, gönderilen geceler, dj sayfaları')
  ) as x(kind, lang, title, body)
  where x.kind = p_kind and x.lang = coalesce(nullif(p_lang, ''), 'en');

  for pair in select * from jsonb_each_text(coalesce(p_data, '{}')) loop
    title := replace(title, '{' || pair.key || '}', coalesce(pair.value, ''));
    body  := replace(body,  '{' || pair.key || '}', coalesce(pair.value, ''));
  end loop;
  return next;
end;
$$;


-- ------------------------------------------------------------ helpers

-- Everyone in the group but p_skip, with the words every group push carries.
create or replace function public.push_group(p_group uuid, p_skip uuid, p_kind text, p_key text, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
  g public.groups%rowtype;
begin
  select * into g from public.groups where id = p_group;
  if g.id is null then return; end if;
  for m in select user_id from public.group_members where group_id = p_group and user_id is distinct from p_skip loop
    perform public.push_enqueue(m.user_id, p_kind, replace(p_key, '{user}', m.user_id::text),
      jsonb_build_object('group', g.emoji || ' ' || g.name, 'url', '/groups/' || g.id) || coalesce(p_data, '{}'));
  end loop;
end;
$$;
revoke execute on function public.push_group(uuid, uuid, text, text, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------ members

-- Added by someone else: the new one hears it. Came in with a code (they added
-- themselves): the others hear it. The maker of a new group hears nothing.
create or replace function public.push_on_group_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  g public.groups%rowtype;
begin
  select * into g from public.groups where id = new.group_id;
  if new.role = 'owner' then return new; end if;
  if auth.uid() is distinct from new.user_id then
    perform public.push_enqueue(new.user_id, 'group_added', format('group_added:%s:%s', g.id, new.user_id),
      jsonb_build_object('group', g.emoji || ' ' || g.name, 'name', public.push_name(coalesce(auth.uid(), g.created_by)), 'url', '/groups/' || g.id));
  else
    perform public.push_group(g.id, new.user_id, 'group_joined', format('group_joined:%s:%s:{user}', g.id, new.user_id),
      jsonb_build_object('name', public.push_name(new.user_id)));
  end if;
  return new;
exception when others then
  raise warning 'group push skipped: %', sqlerrm;
  return new;
end;
$$;
drop trigger if exists push_group_member on public.group_members;
create trigger push_group_member after insert on public.group_members
  for each row execute function public.push_on_group_member();

-- ------------------------------------------------------------ a match

-- The last yes, the one that makes it everyone: all members hear it, once per night.
create or replace function public.push_on_group_swipe()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
  y int;
begin
  if new.direction <> 'right' then return new; end if;
  select count(*) into n from public.group_members where group_id = new.group_id;
  if n < 2 then return new; end if;
  select count(*) into y from public.group_swipes s
    join public.group_members m on m.group_id = s.group_id and m.user_id = s.user_id
    where s.group_id = new.group_id and s.event_id = new.event_id and s.direction = 'right';
  if y = n then
    perform public.push_group(new.group_id, null, 'group_match', format('group_match:%s:%s:{user}', new.group_id, new.event_id),
      jsonb_build_object('title', (select title from public.events where id = new.event_id)));
  end if;
  return new;
exception when others then
  raise warning 'group push skipped: %', sqlerrm;
  return new;
end;
$$;
drop trigger if exists push_group_swipe on public.group_swipes;
create trigger push_group_swipe after insert or update of direction on public.group_swipes
  for each row execute function public.push_on_group_swipe();

-- ------------------------------------------------------------ the thread

-- The chat carries the moments too (46): a plan, a vote, a result, a line.
create or replace function public.push_on_group_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.kind = 'say' then
    -- one buzz per group, person and ten minutes
    perform public.push_group(new.group_id, new.user_id, 'group_message',
      format('group_message:%s:{user}:%s', new.group_id, floor(extract(epoch from new.created_at) / 600)),
      jsonb_build_object('name', public.push_name(new.user_id), 'text', left(new.body, 120), 'url', '/groups/chat?id=' || new.group_id));
  elsif new.kind = 'plan' then
    perform public.push_group(new.group_id, new.user_id, 'group_plan', format('group_plan:%s:%s:{user}', new.group_id, new.id),
      jsonb_build_object('name', public.push_name(new.user_id), 'title', new.body));
  elsif new.kind = 'round' then
    perform public.push_group(new.group_id, new.user_id, 'group_round', format('group_round:%s:%s:{user}', new.group_id, new.id),
      jsonb_build_object('name', public.push_name(new.user_id), 'title', new.body));
  elsif new.kind = 'won' then
    perform public.push_group(new.group_id, null, 'group_won', format('group_won:%s:%s:{user}', new.group_id, new.id),
      jsonb_build_object('title', new.body));
  end if;
  return new;
exception when others then
  raise warning 'group push skipped: %', sqlerrm;
  return new;
end;
$$;
drop trigger if exists push_group_message on public.group_messages;
create trigger push_group_message after insert on public.group_messages
  for each row execute function public.push_on_group_message();

-- ------------------------------------------------------------ live

-- Someone opens live and nobody else is there: the others are called.
create or replace function public.push_on_group_live()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.group_live l where l.group_id = new.group_id and l.user_id <> new.user_id
             and l.seen_at > now() - interval '40 seconds') then
    return new;
  end if;
  perform public.push_group(new.group_id, new.user_id, 'group_live',
    format('group_live:%s:{user}:%s', new.group_id, floor(extract(epoch from now()) / 1800)),
    jsonb_build_object('name', public.push_name(new.user_id)));
  return new;
exception when others then
  raise warning 'group push skipped: %', sqlerrm;
  return new;
end;
$$;
drop trigger if exists push_group_live on public.group_live;
create trigger push_group_live after insert on public.group_live
  for each row execute function public.push_on_group_live();


-- ------------------------------------------------------------ posts

create or replace function public.push_on_post()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  f record;
begin
  for f in
    select case when requester_id = new.author_id then addressee_id else requester_id end as friend
    from public.friendships
    where status = 'accepted' and (requester_id = new.author_id or addressee_id = new.author_id)
  loop
    perform public.push_enqueue(f.friend, 'post', format('post:%s:%s', new.id, f.friend),
      jsonb_build_object('name', public.push_name(new.author_id),
                         'text', coalesce(nullif(left(new.body, 120), ''), '📷'),
                         'url', '/yours'));
  end loop;
  return new;
exception when others then
  raise warning 'post push skipped: %', sqlerrm;
  return new;
end;
$$;
drop trigger if exists push_post on public.posts;
create trigger push_post after insert on public.posts
  for each row execute function public.push_on_post();

-- ------------------------------------------------------------ tickets

-- Hourly: a plan that starts in 20 to 28 hours, members who said in or maybe and
-- have no ticket, when the night has a ticket link. Once per plan and person.
create or replace function public.group_push_hourly()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select g.id as group_id, g.emoji, g.name, e.id as event_id, e.title, a.user_id
    from public.groups g
    join public.events e on e.id = g.plan_event_id and e.ticket_url is not null
    join public.group_members m on m.group_id = g.id
    join public.rsvps a on a.user_id = m.user_id and a.event_id = e.id and a.answer in ('in', 'maybe')
    where e.starts_at between now() + interval '20 hours' and now() + interval '28 hours'
      and not exists (select 1 from public.group_tickets t where t.group_id = g.id and t.event_id = e.id and t.user_id = m.user_id)
  loop
    perform public.push_enqueue(r.user_id, 'group_ticket', format('group_ticket:%s:%s:%s', r.group_id, r.event_id, r.user_id),
      jsonb_build_object('group', r.emoji || ' ' || r.name, 'title', r.title, 'url', '/groups/' || r.group_id));
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function public.group_push_hourly() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('afterhours-group-hourly')
      where exists (select 1 from cron.job where jobname = 'afterhours-group-hourly');
    perform cron.schedule('afterhours-group-hourly', '15 * * * *', $job$ select public.group_push_hourly(); $job$);
  end if;
end
$$;

revoke execute on function public.push_wants(uuid, text) from public, anon, authenticated;
revoke execute on function public.push_enqueue(uuid, text, text, jsonb) from public, anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('48_group_push.sql', 'a004216cd5f5813dd3b963040bbb977722b44aa59a099d56da3014b53bfa7cab');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('48_group_push.sql');
  end if;
end $$;


-- ============================================================
--  WHAT THE NEW DESIGNS READ — JOIN FACES, THE PHOTO WALL, PEOPLE BY ROLE   (49_design_reads.sql)
-- ============================================================

-- afterhours — what the chosen designs need to read (49, after 42 to 48)
--
--   group_peek(code)      now also says who is in (first names) and the plan, so
--                         the join screen can show faces and what the group is up to
--   group_wall(group)     every photo of every night of the group, newest night
--                         first, for the photo wall on "our nights"
--   admin_people_by(q, role)  people filtered by role, with how many nights each
--                         kept and how many groups each is in, and the counts per
--                         role for the filter chips

drop function if exists public.group_peek(text);
create or replace function public.group_peek(p_code text)
returns table (id uuid, name text, emoji text, color text, cover_path text, members int, mine boolean, open boolean,
               names text[], owner text, plan_title text)
language sql
stable
security definer
set search_path = public
as $$
  select g.id, g.name, g.emoji, g.color, g.cover_path,
         (select count(*)::int from public.group_members m where m.group_id = g.id),
         public.in_group(g.id),
         i.expires_at > now() and i.uses < i.max_uses,
         array(select coalesce(p.display_name, p.handle) from public.group_members m join public.profiles p on p.id = m.user_id
               where m.group_id = g.id order by m.joined_at limit 6),
         (select coalesce(p.display_name, p.handle) from public.profiles p where p.id = i.created_by),
         (select e.title from public.events e where e.id = g.plan_event_id and e.is_published)
  from public.group_invites i join public.groups g on g.id = i.group_id
  where i.code = upper(btrim(p_code));
$$;

create or replace function public.group_wall(p_group uuid)
returns table (id uuid, path text, event_id uuid, event_title text, starts_at timestamptz, name text, mine boolean, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_group);
  return query
    select ph.id, ph.path, e.id, e.title, e.starts_at, coalesce(p.display_name, p.handle), ph.user_id = auth.uid(), ph.created_at
    from public.group_photos ph
    join public.events e on e.id = ph.event_id
    left join public.profiles p on p.id = ph.user_id
    where ph.group_id = p_group
    order by e.starts_at desc nulls last, ph.created_at
    limit 300;
end;
$$;

-- 52 adds a column; a second run of the setup meets that shape first.
drop function if exists public.admin_people_by(text, text);
create or replace function public.admin_people_by(p_query text, p_role text)
returns table (id uuid, handle text, display_name text, role text, created_at timestamptz, nights int, groups int)
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
           (select count(*)::int from public.group_members m where m.user_id = p.id)
    from public.profiles p
    where (q = '' or lower(coalesce(p.handle, '')) like '%' || q || '%' or lower(coalesce(p.display_name, '')) like '%' || q || '%')
      and (coalesce(p_role, '') = ''
           or (p_role = 'new' and p.created_at > now() - interval '7 days')
           or (p_role = 'admin' and p.is_admin)
           or (p_role not in ('new', 'admin') and not p.is_admin and p.account_type = p_role))
    order by (p.is_admin or p.account_type <> 'user') desc, p.created_at desc
    limit 80;
end;
$$;

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
    'new', (select count(*) from public.profiles where created_at > now() - interval '7 days'));
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['group_peek(text)', 'group_wall(uuid)', 'admin_people_by(text, text)', 'admin_role_counts()'] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('49_design_reads.sql', '3d2a0a2e99252a337af815b80935c615c29d73beef1ed57297eeb9c93f791103');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('49_design_reads.sql');
  end if;
end $$;


-- ============================================================
--  BLOCKING SOMEONE — NO CARD, NO REQUEST, NO WAVE   (50_blocks.sql)
-- ============================================================

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


-- ============================================================
--  WHAT THE STORES REQUIRE — THE TERMS, REPORTS, CLIENT ERRORS   (51_safety.sql)
-- ============================================================

-- afterhours — what the stores require (51, after 42 to 50)
--
--   the terms     profiles.terms_version / terms_at / adult: accept_terms(version, adult),
--                 terms_status(). The app asks once, before anything else, and again
--                 when the terms change (a higher version).
--   reports       one table for everything but posts (45 keeps its own): comments,
--                 room messages, group messages, profiles, groups, sparks.
--                 report(kind, target, reason) for anyone with an account;
--                 staff_reports() and staff_report_settle(kind, target, remove)
--                 for the staff. Removing takes the content away (a comment is hidden,
--                 a message or spark or group deleted, a profile cleared of its words,
--                 links and photo); either way the reports are settled and logged.
--   client errors what crashed in the app: log_error() from any phone, admin_errors()
--                 and admin_errors_clear() for the admin.

-- ------------------------------------------------------------ the terms

alter table public.profiles add column if not exists terms_version int;
alter table public.profiles add column if not exists terms_at timestamptz;
alter table public.profiles add column if not exists adult boolean not null default false;

create or replace function public.accept_terms(p_version int, p_adult boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if not coalesce(p_adult, false) then raise exception 'eighteen or older only'; end if;
  if p_version is null or p_version < 1 then raise exception 'which terms?'; end if;
  update public.profiles
     set terms_version = greatest(coalesce(terms_version, 0), p_version), terms_at = now(), adult = true
   where id = auth.uid();
end;
$$;

create or replace function public.terms_status()
returns table (version int, adult boolean, at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select p.terms_version, p.adult, p.terms_at from public.profiles p where p.id = auth.uid();
$$;

revoke execute on function public.accept_terms(int, boolean) from public, anon;
revoke execute on function public.terms_status()             from public, anon;
grant execute on function public.accept_terms(int, boolean)  to authenticated;
grant execute on function public.terms_status()              to authenticated;

-- ------------------------------------------------------------ reports

create table if not exists public.reports (
  id           bigserial primary key,
  reporter_id  uuid not null references public.profiles on delete cascade,
  kind         text not null check (kind in ('comment', 'room_post', 'group_message', 'profile', 'group', 'spark', 'post_comment')),
  target       text not null check (length(target) between 1 and 64),
  reason       text check (reason is null or length(reason) <= 300),
  handled      boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (reporter_id, kind, target)
);
create index if not exists reports_open on public.reports (kind, target) where not handled;
alter table public.reports enable row level security;
revoke all on public.reports from public, anon, authenticated;

-- Comments on posts live in 55; until it ran these answer null.
create or replace function public.post_comment_body(p_id text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare r text;
begin
  if to_regclass('public.post_comments') is null then return null; end if;
  execute 'select body from public.post_comments where id::text = $1' into r using p_id;
  return r;
end;
$$;
create or replace function public.post_comment_author(p_id text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare r uuid;
begin
  if to_regclass('public.post_comments') is null then return null; end if;
  execute 'select author_id from public.post_comments where id::text = $1' into r using p_id;
  return r;
end;
$$;
revoke all on function public.post_comment_body(text) from public, anon, authenticated;
revoke all on function public.post_comment_author(text) from public, anon, authenticated;

-- Who wrote it, and whether it exists for you: null when it does not.
create or replace function public.report_author(p_kind text, p_target text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  a uuid;
begin
  if p_kind = 'comment' then
    select author_id into a from public.comments where id::text = p_target;
  elsif p_kind = 'room_post' then
    select user_id into a from public.room_posts where id::text = p_target;
  elsif p_kind = 'group_message' then
    select m.user_id into a from public.group_messages m
     where m.id::text = p_target and m.kind = 'say' and public.in_group(m.group_id);
  elsif p_kind = 'profile' then
    select id into a from public.profiles where id::text = p_target or handle = lower(p_target);
  elsif p_kind = 'group' then
    select g.created_by into a from public.groups g where g.id::text = p_target;
  elsif p_kind = 'spark' then
    select host_id into a from public.sparks where id::text = p_target;
  elsif p_kind = 'post_comment' and to_regclass('public.post_comments') is not null then
    execute 'select c.author_id from public.post_comments c join public.posts p on p.id = c.post_id
             where c.id::text = $1 and public.can_see_post(p.author_id)' into a using p_target;
  end if;
  return a;
end;
$$;
revoke all on function public.report_author(text, text) from public, anon, authenticated;

create or replace function public.report(p_kind text, p_target text, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a uuid;
  t text := btrim(coalesce(p_target, ''));
begin
  if auth.uid() is null or public.is_guest() then raise exception 'make an account first'; end if;
  a := public.report_author(p_kind, t);
  if a is null then raise exception 'nothing to report'; end if;
  if a = auth.uid() then raise exception 'that is yours'; end if;
  -- A profile is stored by its id, whichever way it was named.
  if p_kind = 'profile' then t := a::text; end if;
  if (select count(*) from public.reports where reporter_id = auth.uid() and created_at > now() - interval '1 day') >= 30 then
    raise exception 'thirty today is enough; the staff are on it';
  end if;
  insert into public.reports (reporter_id, kind, target, reason)
  values (auth.uid(), p_kind, t, left(nullif(btrim(p_reason), ''), 300))
  on conflict (reporter_id, kind, target) do update set reason = coalesce(excluded.reason, public.reports.reason), handled = false;
end;
$$;
revoke execute on function public.report(text, text, text) from public, anon;
grant execute on function public.report(text, text, text) to authenticated;

-- The open reports, one row per thing, most reported first. preview is what the
-- staff need to decide: the words, the name, the title.
drop function if exists public.staff_reports();
create or replace function public.staff_reports()
returns table (kind text, target text, preview text, author text, reports int, reasons text[], first_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  return query
    with open as (
      select r.kind, r.target, count(*)::int as n, array_remove(array_agg(r.reason order by r.created_at), null) as why, min(r.created_at) as first_at
      from public.reports r where not r.handled
      group by r.kind, r.target
    )
    select o.kind, o.target,
           case o.kind
             when 'comment'       then (select c.body from public.comments c where c.id::text = o.target)
             when 'room_post'     then (select x.body from public.room_posts x where x.id::text = o.target)
             when 'group_message' then (select x.body from public.group_messages x where x.id::text = o.target)
             when 'profile'       then (select concat_ws(' · ', p.display_name, p.bio, p.about) from public.profiles p where p.id::text = o.target)
             when 'group'         then (select g.name from public.groups g where g.id::text = o.target)
             when 'spark'         then (select concat_ws(' · ', s.title, s.place) from public.sparks s where s.id::text = o.target)
             when 'post_comment'  then public.post_comment_body(o.target)
           end,
           (select coalesce(p.handle, p.display_name) from public.profiles p where p.id = public.report_author_any(o.kind, o.target)),
           o.n, o.why, o.first_at
    from open o
    order by o.n desc, o.first_at;
end;
$$;

-- As report_author, without the "is it yours to see" test: for the staff.
create or replace function public.report_author_any(p_kind text, p_target text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select case p_kind
    when 'comment'       then (select author_id from public.comments where id::text = p_target)
    when 'room_post'     then (select user_id from public.room_posts where id::text = p_target)
    when 'group_message' then (select user_id from public.group_messages where id::text = p_target)
    when 'profile'       then (select id from public.profiles where id::text = p_target)
    when 'group'         then (select created_by from public.groups where id::text = p_target)
    when 'spark'         then (select host_id from public.sparks where id::text = p_target)
    when 'post_comment'  then public.post_comment_author(p_target)
  end;
$$;
revoke all on function public.report_author_any(text, text) from public, anon, authenticated;

create or replace function public.staff_report_settle(p_kind text, p_target text, p_remove boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  if coalesce(p_remove, false) then
    if p_kind = 'comment' then
      update public.comments set is_hidden = true where id::text = p_target;
    elsif p_kind = 'room_post' then
      delete from public.room_posts where id::text = p_target;
    elsif p_kind = 'group_message' then
      delete from public.group_messages where id::text = p_target;
    elsif p_kind = 'spark' then
      delete from public.sparks where id::text = p_target;
    elsif p_kind = 'group' then
      delete from public.groups where id::text = p_target;
    elsif p_kind = 'post_comment' then
      execute 'update public.post_comments set is_hidden = true where id::text = $1' using p_target;
    elsif p_kind = 'profile' then
      update public.profiles set bio = null, about = null where id::text = p_target;
      delete from public.profile_links where user_id::text = p_target;
      delete from public.profile_photos where user_id::text = p_target;
    else
      raise exception 'which kind?';
    end if;
  end if;
  update public.reports set handled = true where kind = p_kind and target = p_target and not handled;
  perform public.staff_note(case when coalesce(p_remove, false) then 'remove' else 'keep' end, 'report:' || p_kind, p_target, null);
end;
$$;

revoke execute on function public.staff_reports()                          from public, anon;
revoke execute on function public.staff_report_settle(text, text, boolean) from public, anon;
grant execute on function public.staff_reports()                           to authenticated;
grant execute on function public.staff_report_settle(text, text, boolean)  to authenticated;

-- ------------------------------------------------------------ client errors

create table if not exists public.client_errors (
  id          bigserial primary key,
  user_id     uuid references public.profiles on delete set null,
  message     text not null,
  stack       text,
  where_      text,
  platform    text,
  version     text,
  fatal       boolean not null default false,
  at          timestamptz not null default now()
);
create index if not exists client_errors_at on public.client_errors (at desc);
alter table public.client_errors enable row level security;
revoke all on public.client_errors from public, anon, authenticated;

-- Anyone may write one (a crash can come before sign-in); short, and at most
-- a hundred an hour across everyone, so a loop cannot fill the table.
create or replace function public.log_error(p_message text, p_stack text, p_where text, p_platform text, p_version text, p_fatal boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.client_errors where at > now() - interval '1 hour') >= 100 then return; end if;
  insert into public.client_errors (user_id, message, stack, where_, platform, version, fatal)
  values (auth.uid(), left(coalesce(nullif(btrim(p_message), ''), 'unknown'), 500), left(p_stack, 4000), left(p_where, 200),
          left(p_platform, 20), left(p_version, 40), coalesce(p_fatal, false));
end;
$$;

create or replace function public.admin_errors(p_limit int default 100)
returns table (id bigint, message text, stack text, where_ text, platform text, version text, fatal boolean, at timestamptz, who text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  return query
    select e.id, e.message, e.stack, e.where_, e.platform, e.version, e.fatal, e.at, p.handle
    from public.client_errors e left join public.profiles p on p.id = e.user_id
    order by e.at desc
    limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;

create or replace function public.admin_errors_clear()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  delete from public.client_errors;
end;
$$;

revoke execute on function public.log_error(text, text, text, text, text, boolean) from public;
grant execute on function public.log_error(text, text, text, text, text, boolean)  to anon, authenticated;
revoke execute on function public.admin_errors(int)    from public, anon;
revoke execute on function public.admin_errors_clear() from public, anon;
grant execute on function public.admin_errors(int)     to authenticated;
grant execute on function public.admin_errors_clear()  to authenticated;

-- A month of errors is enough.
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'client-errors-prune';
    perform cron.schedule('client-errors-prune', '40 4 * * *', $q$delete from public.client_errors where at < now() - interval '30 days'$q$);
  end if;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('51_safety.sql', '3b7465d17ddd94f12c1f8c5c38634997f605813c88d9784ca30e976d01104883');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('51_safety.sql');
  end if;
end $$;


-- ============================================================
--  CLOSING AN ACCOUNT — THE STAFF BAN, THE DATABASE REFUSES   (52_bans.sql)
-- ============================================================

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


-- ============================================================
--  TRUST — DJ PAGES CHECKED, ADMINS, NOTICES, LIMITS, BLOCKS IN GROUPS   (53_trust.sql)
-- ============================================================

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


-- ============================================================
--  UPKEEP — OLD GUESTS GO, THE STAFF ARE ALERTED   (54_upkeep.sql)
-- ============================================================

-- afterhours — upkeep (54, after 48 and 51 to 53)
--
--   guests        a guest account nobody has opened for 30 days is deleted, every night
--                 (guests_prune). Their comments stay, signed "someone", as on delete.
--   staff alerts  when something starts waiting in the panel (a report, a reported post,
--                 a night sent in, a dj page), every admin and community manager gets a
--                 push (kind staff, in 48) with how many things wait; at most one an hour
--                 each, so the 24-hour promise in the terms can be kept.
--   staff_waiting()  the same count, for the panel and the push.

-- ------------------------------------------------------------ guests

create or replace function public.guests_prune(p_days int default 30)
returns int
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  gone int := 0;
begin
  -- Supabase marks guests in auth.users.is_anonymous; without that column there is nothing to do.
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'auth' and table_name = 'users' and column_name = 'is_anonymous') then
    return 0;
  end if;
  create temp table if not exists _guests_gone (id uuid) on commit drop;
  truncate _guests_gone;
  execute format($q$
    insert into _guests_gone
    select u.id from auth.users u left join public.profiles p on p.id = u.id
    where u.is_anonymous
      and greatest(u.created_at, coalesce(u.last_sign_in_at, u.created_at), coalesce(p.last_seen_at, u.created_at)) < now() - interval '%s days'
  $q$, greatest(coalesce(p_days, 30), 7));
  update public.comments set author_id = null, author_name = 'someone'
   where author_id in (select id from _guests_gone);
  delete from auth.users where id in (select id from _guests_gone);
  get diagnostics gone = row_count;
  return gone;
end;
$$;
revoke all on function public.guests_prune(int) from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'afterhours-guests-prune';
    perform cron.schedule('afterhours-guests-prune', '50 4 * * *', $q$select public.guests_prune(30)$q$);
  end if;
end $$;

-- ------------------------------------------------------------ what waits for the staff

create or replace function public.staff_waiting_count()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select (select count(distinct (kind, target))::int from public.reports where not handled)
       + coalesce((select count(distinct post_id)::int from public.post_reports where not handled), 0)
       + (select count(*)::int from public.events where review = 'pending')
       + (select count(*)::int from public.djs d join public.profiles p on p.id = d.owner_id where not d.verified and p.account_type = 'dj');
$$;
revoke all on function public.staff_waiting_count() from public, anon, authenticated;

create or replace function public.staff_waiting()
returns int
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  return public.staff_waiting_count();
end;
$$;
revoke execute on function public.staff_waiting() from public, anon;
grant execute on function public.staff_waiting() to authenticated;

-- One push an hour at most per staff member, saying how many things wait.
create or replace function public.staff_ping()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
  n int;
begin
  if to_regprocedure('public.push_enqueue(uuid, text, text, jsonb)') is null then return; end if;
  n := public.staff_waiting_count();
  if n = 0 then return; end if;
  for s in select id from public.profiles where (is_admin or account_type = 'community_manager') and banned_at is null loop
    perform public.push_enqueue(s.id, 'staff', 'staff:' || s.id || ':' || to_char(date_trunc('hour', now()), 'YYYYMMDDHH24'),
                                jsonb_build_object('n', n::text, 'url', '/panel'));
  end loop;
end;
$$;
revoke all on function public.staff_ping() from public, anon, authenticated;

create or replace function public.staff_alert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.staff_ping();
  return null;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['reports', 'post_reports', 'djs'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop trigger if exists staff_alert on public.%I', t);
    execute format('create trigger staff_alert after insert on public.%I for each statement execute function public.staff_alert()', t);
  end loop;
end $$;

-- Nights sent in: only those that arrive waiting.
create or replace function public.staff_alert_night()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.review = 'pending' then
    perform public.staff_ping();
  end if;
  return null;
end;
$$;
drop trigger if exists staff_alert on public.events;
create trigger staff_alert after insert on public.events
  for each row execute function public.staff_alert_night();

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('54_upkeep.sql', '35d51a2f27242654fd57902d539828ad9875c0449af11b552f8f498c59e5ff0f');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('54_upkeep.sql');
  end if;
end $$;


-- ============================================================
--  LIKES AND COMMENTS ON POSTS   (55_post_social.sql)
-- ============================================================

-- afterhours — likes and comments on posts (55, after 45, 48, 51 to 53)
--
--   post_likes            one per person and post
--   post_comments         up to 300 characters; hidden by the staff, deleted by their
--                         author or the author of the post
--   post_like(id, on)     a double tap or the heart; anyone who can see the post
--   post_likers(id)       who liked it, newest first (blocked people left out)
--   post_comment_add(id, body) / post_comment_delete(id) / post_comments_of(id)
--   posts_feed(…)         as in 45, plus likes, liked (by you), comments and the
--                         first two comments, so the card needs one read
--
-- Whoever sees the post (its author and their confirmed friends) may like and
-- comment. The author is told by push (post_like, post_comment in 48). Reports
-- (51), bans (52), notices and limits (53) cover comments too.

create table if not exists public.post_likes (
  post_id     uuid not null references public.posts on delete cascade,
  user_id     uuid not null references public.profiles on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index if not exists post_likes_user on public.post_likes (user_id);

create table if not exists public.post_comments (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.posts on delete cascade,
  author_id   uuid not null references public.profiles on delete cascade,
  body        text not null check (length(btrim(body)) between 1 and 300),
  is_hidden   boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists post_comments_post on public.post_comments (post_id, created_at);

alter table public.post_likes enable row level security;
alter table public.post_comments enable row level security;
revoke all on public.post_likes, public.post_comments from public, anon, authenticated;

-- Reports may name a comment on a post (the table in 51 predates it).
alter table public.reports drop constraint if exists reports_kind_check;
alter table public.reports add constraint reports_kind_check
  check (kind in ('comment', 'room_post', 'group_message', 'profile', 'group', 'spark', 'post_comment'));

create or replace function public.need_post(p_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  a uuid;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select author_id into a from public.posts where id = p_id and not is_hidden;
  if a is null or not public.can_see_post(a) then raise exception 'no such post'; end if;
  return a;
end;
$$;
revoke all on function public.need_post(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ likes

create or replace function public.post_like(p_id uuid, p_on boolean)
returns int
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_post(p_id);
  if coalesce(p_on, true) then
    insert into public.post_likes (post_id, user_id) values (p_id, auth.uid()) on conflict do nothing;
  else
    delete from public.post_likes where post_id = p_id and user_id = auth.uid();
  end if;
  return (select count(*)::int from public.post_likes where post_id = p_id);
end;
$$;

create or replace function public.post_likers(p_id uuid)
returns table (id uuid, handle text, name text, mine boolean, at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_post(p_id);
  return query
    select p.id, p.handle, p.display_name, p.id = auth.uid(), l.created_at
    from public.post_likes l join public.profiles p on p.id = l.user_id
    where l.post_id = p_id and (p.id = auth.uid() or (not public.is_blocked(p.id) and p.banned_at is null))
    order by l.created_at desc
    limit 200;
end;
$$;

-- ------------------------------------------------------------ comments

create or replace function public.post_comment_add(p_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  r uuid;
begin
  perform public.need_account();
  perform public.need_post(p_id);
  if length(btrim(coalesce(p_body, ''))) = 0 then raise exception 'a few words'; end if;
  if length(p_body) > 300 then raise exception 'at most 300 characters'; end if;
  insert into public.post_comments (post_id, author_id, body) values (p_id, auth.uid(), btrim(p_body)) returning id into r;
  return r;
end;
$$;

-- Your own comment, or any comment under your post.
create or replace function public.post_comment_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
begin
  select pc.author_id, p.author_id as owner into c
  from public.post_comments pc join public.posts p on p.id = pc.post_id where pc.id = p_id;
  if c is null then return; end if;
  if auth.uid() is distinct from c.author_id and auth.uid() is distinct from c.owner and not public.is_staff() then
    raise exception 'not yours' using errcode = '42501';
  end if;
  delete from public.post_comments where id = p_id;
end;
$$;

create or replace function public.post_comments_of(p_id uuid)
returns table (id uuid, author_id uuid, handle text, name text, body text, created_at timestamptz, mine boolean, can_delete boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  owner uuid;
begin
  owner := public.need_post(p_id);
  return query
    select c.id, c.author_id, p.handle, p.display_name, c.body, c.created_at,
           c.author_id = auth.uid(), c.author_id = auth.uid() or owner = auth.uid()
    from public.post_comments c join public.profiles p on p.id = c.author_id
    where c.post_id = p_id and not c.is_hidden
      and (c.author_id = auth.uid() or (not public.is_blocked(c.author_id) and p.banned_at is null))
    order by c.created_at
    limit 300;
end;
$$;

revoke execute on function public.post_like(uuid, boolean)       from public, anon;
revoke execute on function public.post_likers(uuid)              from public, anon;
revoke execute on function public.post_comment_add(uuid, text)   from public, anon;
revoke execute on function public.post_comment_delete(uuid)      from public, anon;
revoke execute on function public.post_comments_of(uuid)         from public, anon;
grant execute on function public.post_like(uuid, boolean)        to authenticated;
grant execute on function public.post_likers(uuid)               to authenticated;
grant execute on function public.post_comment_add(uuid, text)    to authenticated;
grant execute on function public.post_comment_delete(uuid)       to authenticated;
grant execute on function public.post_comments_of(uuid)          to authenticated;

-- ------------------------------------------------------------ the feed

drop function if exists public.posts_feed(timestamptz, int);
create or replace function public.posts_feed(p_before timestamptz default null, p_limit int default 20)
returns table (id uuid, author_id uuid, handle text, name text, body text, photo_path text,
               event_slug text, event_title text, created_at timestamptz, mine boolean,
               likes int, liked boolean, comments int, first_comments jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.author_id, pr.handle, pr.display_name, p.body, p.photo_path, e.slug, e.title, p.created_at,
         p.author_id = auth.uid(),
         (select count(*)::int from public.post_likes l where l.post_id = p.id),
         exists (select 1 from public.post_likes l where l.post_id = p.id and l.user_id = auth.uid()),
         (select count(*)::int from public.post_comments c where c.post_id = p.id and not c.is_hidden),
         coalesce((select jsonb_agg(jsonb_build_object('who', coalesce(x.handle, x.display_name), 'text', x.body) order by x.created_at)
                   from (select c.body, c.created_at, q.handle, q.display_name
                         from public.post_comments c join public.profiles q on q.id = c.author_id
                         where c.post_id = p.id and not c.is_hidden
                           and (c.author_id = auth.uid() or (not public.is_blocked(c.author_id) and q.banned_at is null))
                         order by c.created_at limit 2) x), '[]'::jsonb)
  from public.posts p
  join public.profiles pr on pr.id = p.author_id
  left join public.events e on e.id = p.event_id
  where auth.uid() is not null
    and not p.is_hidden
    and public.can_see_post(p.author_id)
    and (p_before is null or p.created_at < p_before)
  order by p.created_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;
revoke execute on function public.posts_feed(timestamptz, int) from public, anon;
grant execute on function public.posts_feed(timestamptz, int) to authenticated;

-- ------------------------------------------------------------ guards, notices, push

do $$
declare t text;
begin
  foreach t in array array['post_likes', 'post_comments'] loop
    if to_regprocedure('public.guard_banned()') is not null then
      execute format('drop trigger if exists guard_banned on public.%I', t);
      execute format('create trigger guard_banned before insert or update on public.%I for each row execute function public.guard_banned()', t);
    end if;
  end loop;
  if to_regprocedure('public.guard_rate()') is not null then
    drop trigger if exists guard_rate on public.post_comments;
    create trigger guard_rate before insert on public.post_comments
      for each row execute function public.guard_rate('author_id', '1 hour', '60');
  end if;
  if to_regprocedure('public.notice_hidden()') is not null then
    drop trigger if exists notice_hidden on public.post_comments;
    create trigger notice_hidden after update of is_hidden on public.post_comments
      for each row execute function public.notice_hidden();
  end if;
end $$;

create or replace function public.push_post_social()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.posts%rowtype;
  -- the two tables name the person differently; read it by name
  who uuid := coalesce(to_jsonb(new) ->> 'user_id', to_jsonb(new) ->> 'author_id')::uuid;
begin
  if to_regprocedure('public.push_enqueue(uuid, text, text, jsonb)') is null then return null; end if;
  select * into p from public.posts where id = new.post_id;
  if p.author_id is null or p.author_id = who then return null; end if;
  if TG_TABLE_NAME = 'post_likes' then
    perform public.push_enqueue(p.author_id, 'post_like', format('post_like:%s:%s', p.id, who),
      jsonb_build_object('name', public.push_name(who), 'text', left(coalesce(nullif(p.body, ''), '📷'), 80), 'url', '/yours'));
  else
    perform public.push_enqueue(p.author_id, 'post_comment', format('post_comment:%s', to_jsonb(new) ->> 'id'),
      jsonb_build_object('name', public.push_name(who), 'text', left(to_jsonb(new) ->> 'body', 80), 'url', '/yours'));
  end if;
  return null;
end;
$$;
do $$ begin
  if to_regprocedure('public.push_name(uuid)') is not null then
    drop trigger if exists push_post_social on public.post_likes;
    create trigger push_post_social after insert on public.post_likes for each row execute function public.push_post_social();
    drop trigger if exists push_post_social on public.post_comments;
    create trigger push_post_social after insert on public.post_comments for each row execute function public.push_post_social();
  end if;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('55_post_social.sql', '56ec67e5452e57f8d7d44f8cc1424a5abf2d7bc1f46590c8de02439415414676');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('55_post_social.sql');
  end if;
end $$;


-- ============================================================
--  TWENTY MORE SPARKS   (56_spark_kinds_2.sql)
-- ============================================================

-- afterhours — twenty more sparks (56, after 39)
--
-- The app has thirty-one sparks since 11.10.2026 (app/src/content/sparks.ts).
-- The table takes them here; nothing else changes — a kind is a word the app
-- turns into a photo and a text.
--
--   karaoke · vinyl · openair · bike · cinema · boardgames · flea · skate · cook · sauna
--   openmic · pingpong · bouldering · picnic · crawl · stars · football · tram · jazz · walk

alter table public.sparks drop constraint if exists sparks_kind_check;
alter table public.sparks add constraint sparks_kind_check check (kind in (
  'derby', 'grill', 'hike',
  'sunrise', 'breakfast', 'rooftop', 'swim', 'quiz', 'newplace', 'camera', 'festival',
  'karaoke', 'vinyl', 'openair', 'bike', 'cinema',
  'boardgames', 'flea', 'skate', 'cook', 'sauna',
  'openmic', 'pingpong', 'bouldering', 'picnic', 'crawl',
  'stars', 'football', 'tram', 'jazz', 'walk'
));

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('56_spark_kinds_2.sql', 'dd7519b93add7f83e1a2c2fb291940ec62e8fb8c85b2ad1417adeac7db5729d2');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('56_spark_kinds_2.sql');
  end if;
end $$;


-- ============================================================
--  THE DOOR — WHO IS ASKING, WHO MAY BE SEEN   (57_doors.sql)
-- ============================================================

-- afterhours — the door (57, after 56)
--
-- Two questions every function used to answer on its own, each in its own words:
-- "who is asking?" and "may they see this person?". From here they have one answer
-- each, so a new function cannot forget a case the others remember (the lesson of
-- 50_blocks.sql, which had to touch four sieves one by one).
--
--   assert_member()              who is asking: a signed-in account that is not
--                                banned, else an exception (42501). Guests (anonymous
--                                sessions) pass: they are limited by the writes they
--                                are refused, not by the door. The write gates
--                                (need_member, need_post) and the big reads
--                                (people_search, people_suggested, posts_feed,
--                                past_feed, waves_kept) ask it first — in plpgsql,
--                                at declaration, so an empty table cannot skip it. A banned
--                                account used to keep reading; now it reads nothing.
--   reachable(viewer, other)     no block either way, the other not banned.
--   visible_to(viewer, other)    reachable, and a friend or discoverable (the one
--                                sieve card_visible of 52 already was, with the viewer
--                                named so a wave can ask it for someone else).
--   card_visible(other)          = visible_to(auth.uid(), other), kept for every caller.
--   spark_waves                  stops at a block and at a ban (reachable), as before
--                                at a block alone.

-- ------------------------------------------------------------ who is asking

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
revoke execute on function public.assert_member() from public, anon;
grant execute on function public.assert_member() to authenticated;

-- ------------------------------------------------------------ who may be seen

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
      and ((f.requester_id = p_a and f.addressee_id = p_b)
        or (f.requester_id = p_b and f.addressee_id = p_a))
  );
$$;
revoke execute on function public.are_friends(uuid, uuid) from public, anon, authenticated;

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
revoke execute on function public.reachable(uuid, uuid) from public, anon, authenticated;

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
                   or coalesce((select s.discoverable from public.profile_settings s
                                where s.user_id = p_other), true))));
$$;
revoke execute on function public.visible_to(uuid, uuid) from public, anon, authenticated;

create or replace function public.card_visible(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.visible_to(auth.uid(), other);
$$;

-- The wave walks friendships and stops where the host could not reach the person.
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
    and public.reachable(p_me, w.person)
  group by w.person;
$$;

-- ------------------------------------------------------------ the gates ask first

create or replace function public.need_member(p_group uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_member();
  if not public.in_group(p_group) then
    raise exception 'not in this group' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.need_post(p_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  a uuid;
begin
  perform public.assert_member();
  select author_id into a from public.posts where id = p_id and not is_hidden;
  if a is null or not public.can_see_post(a) then raise exception 'no such post'; end if;
  return a;
end;
$$;

-- ------------------------------------------------------------ the big reads ask first

create or replace function public.people_search(p_query text, p_limit int default 12)
returns table (
  id            uuid,
  handle        text,
  display_name  text,
  city_name     text,
  mutual        int,
  relation      text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me   uuid := public.assert_member();
  q    text := lower(btrim(regexp_replace(coalesce(p_query, ''), '^@', '')));
  safe text;
begin
  if length(q) < 2 then
    return;
  end if;
  safe := replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_');
  return query
    select p.id, p.handle, p.display_name, c.name,
           public.people_mutual(p.id), public.people_relation(p.id)
    from public.profiles p
    left join public.cities c on c.id = p.city_id
    where p.handle is not null
      and p.id <> me
      and public.visible_to(me, p.id)
      and (p.handle like safe || '%' or lower(coalesce(p.display_name, '')) like '%' || safe || '%')
    order by (p.handle = q) desc,
             (p.handle like safe || '%') desc,
             public.people_mutual(p.id) desc,
             p.handle
    limit least(greatest(coalesce(p_limit, 12), 1), 20);
end;
$$;

create or replace function public.people_suggested(p_limit int default 3)
returns table (
  id            uuid,
  handle        text,
  display_name  text,
  city_name     text,
  mutual        int,
  reason        text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  with mine as (
    select p.city_id from public.profiles p where p.id = me
  ),
  pool as (
    select p.id, p.handle, p.display_name, c.name as city_name,
           public.people_mutual(p.id) as mutual,
           (p.city_id is not null and p.city_id = (select city_id from mine)) as same_city,
           p.last_seen_at
    from public.profiles p
    left join public.cities c on c.id = p.city_id
    where p.handle is not null
      and p.id <> me
      and not public.is_linked(p.id)
      and public.visible_to(me, p.id)
  )
  select pool.id, pool.handle, pool.display_name, pool.city_name, pool.mutual,
         case when pool.mutual > 0 then 'mutual' when pool.same_city then 'city' else 'new' end
  from pool
  order by pool.mutual desc, pool.same_city desc, pool.last_seen_at desc nulls last, pool.handle
  limit least(greatest(coalesce(p_limit, 3), 1), 12);
end;
$$;

create or replace function public.posts_feed(p_before timestamptz default null, p_limit int default 20)
returns table (id uuid, author_id uuid, handle text, name text, body text, photo_path text,
               event_slug text, event_title text, created_at timestamptz, mine boolean,
               likes int, liked boolean, comments int, first_comments jsonb)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  select p.id, p.author_id, pr.handle, pr.display_name, p.body, p.photo_path, e.slug, e.title, p.created_at,
         p.author_id = me,
         (select count(*)::int from public.post_likes l where l.post_id = p.id),
         exists (select 1 from public.post_likes l where l.post_id = p.id and l.user_id = me),
         (select count(*)::int from public.post_comments c where c.post_id = p.id and not c.is_hidden),
         coalesce((select jsonb_agg(jsonb_build_object('who', coalesce(x.handle, x.display_name), 'text', x.body) order by x.created_at)
                   from (select c.body, c.created_at, q.handle, q.display_name
                         from public.post_comments c join public.profiles q on q.id = c.author_id
                         where c.post_id = p.id and not c.is_hidden
                           and (c.author_id = me or public.reachable(me, c.author_id))
                         order by c.created_at limit 2) x), '[]'::jsonb)
  from public.posts p
  join public.profiles pr on pr.id = p.author_id
  left join public.events e on e.id = p.event_id
  where not p.is_hidden
    and public.can_see_post(p.author_id)
    and (p_before is null or p.created_at < p_before)
  order by p.created_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 50));
end;
$$;

create or replace function public.past_feed(
  p_city   text default null,
  p_before    timestamptz default null,
  p_before_id uuid default null,
  p_limit     int default 12
)
returns table (
  id          uuid,
  slug        text,
  title       text,
  image_url   text,
  venue_name  text,
  city_name   text,
  type_slug   text,
  type_name   text,
  starts_at   timestamptz,
  people      text[],
  mine        boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  with circle as (
    select case when f.requester_id = me then f.addressee_id else f.requester_id end as id
    from public.friendships f
    where f.status = 'accepted' and me in (f.requester_id, f.addressee_id)
  ),
  -- who of yours was there, per night: checked in (shown to friends) or kept it
  went as (
    select c.event_id, c.user_id, c.checked_at as at
    from public.checkins c
    where c.user_id = me
       or (c.show_friends and c.user_id in (select circle.id from circle))
    union
    select s.event_id, s.user_id, s.created_at
    from public.swipes s
    where s.direction = 'right'
      and (s.user_id = me or (s.user_id in (select circle.id from circle) and public.kept_visible(s.user_id)))
  ),
  named as (
    select w.event_id,
           array_agg(distinct lower(coalesce(p.handle, p.display_name, 'someone'))) filter (where w.user_id <> me) as people,
           bool_or(w.user_id = me) as mine
    from went w
    join public.profiles p on p.id = w.user_id
    group by w.event_id
  )
  select e.id, e.slug, e.title, e.image_url, v.name, ci.name, t.slug, t.name, e.starts_at,
         coalesce(n.people, '{}'), coalesce(n.mine, false)
  from public.events e
  join public.event_types t on t.id = e.type_id
  join public.cities ci on ci.id = e.city_id
  left join public.venues v on v.id = e.venue_id
  left join named n on n.event_id = e.id
  where e.starts_at is not null
    and e.starts_at < now()
    and e.starts_at > now() - interval '365 days'
    and (p_before is null or e.starts_at < p_before
         or (e.starts_at = p_before and p_before_id is not null and e.id > p_before_id))
    and e.image_url is not null
    and (ci.slug = p_city or n.event_id is not null)
  order by e.starts_at desc, e.id
  limit least(greatest(coalesce(p_limit, 12), 1), 30);
end;
$$;

create or replace function public.waves_kept(p_limit int default 80)
returns table (
  wave        int,
  via         text[],
  kept_at     timestamptz,
  id          uuid,
  slug        text,
  title       text,
  poster_no   int,
  type_name   text,
  venue_name  text,
  city_slug   text,
  starts_at   timestamptz,
  image_url   text,
  ticket_url  text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  with near as (
    select w.person, w.hops, w.path
    from public.wave_paths(me) w
    where w.hops between 2 and 3
      -- everyone on the chain keeps their keeps open
      and not exists (
        select 1 from unnest(w.path) as link(id)
        where not public.kept_visible(link.id)
      )
  )
  select n.hops,
         array(select coalesce(p.handle, p.display_name, 'someone')
               from unnest(n.path) with ordinality as link(id, i)
               join public.profiles p on p.id = link.id
               order by link.i),
         s.created_at,
         e.id, e.slug, e.title, e.poster_no, e.type_name, e.venue_name,
         e.city_slug, e.starts_at, e.image_url, e.ticket_url
  from near n
  join public.swipes s on s.user_id = n.person and s.direction = 'right'
  join public.events_public e on e.id = s.event_id
  where e.starts_at > now() - interval '6 hours'
  order by e.starts_at, n.hops, s.created_at desc
  limit greatest(1, least(coalesce(p_limit, 80), 200));
end;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('57_doors.sql', '9f7b2b2356cfeb17a3dfcf7fc3dcb04c3c41c493384de2a0b426c1ea7dff8df0');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('57_doors.sql');
  end if;
end $$;


-- ============================================================
--  A PUSH SAYS A SENTENCE AND A NAME, NEVER THE WORDS   (58_push_words.sql)
-- ============================================================

-- afterhours — the words of a push, without those of the member (58)
--
-- Until here six kinds of push carried the text of a member to the lock screen: a room
-- line, a reply, a group message, a post, the words of a liked post, a comment. The
-- words of someone showed under the name afterhours on a phone lying on a table. The decision
-- (11.10.2026): a push says a fixed sentence and a name, never the content. The
-- rows below say so, and push_text drops `text` from its data whatever the caller
-- passes, so an old trigger cannot leak it. The function is that of 48, otherwise unchanged;
-- the triggers still pass the text, which goes nowhere now.

create or replace function public.push_text(p_kind text, p_lang text, p_data jsonb)
returns table (title text, body text)
language plpgsql
immutable
as $$
declare
  pair record;
begin
  select x.title, x.body into title, body
  from (values
    ('friend_request',  'en', 'friend request',                '{name} wants to add you'),
    ('friend_request',  'de', 'freundschaftsanfrage',          '{name} möchte dich hinzufügen'),
    ('friend_request',  'tr', 'arkadaşlık isteği',             '{name} seni eklemek istiyor'),
    ('friend_accepted', 'en', 'you are friends now',           '{name} accepted your request'),
    ('friend_accepted', 'de', 'ihr seid jetzt freunde',        '{name} hat deine anfrage angenommen'),
    ('friend_accepted', 'tr', 'artık arkadaşsınız',            '{name} isteğini kabul etti'),
    ('match',           'en', '{name} is going too',           '{title}'),
    ('match',           'de', '{name} geht auch hin',          '{title}'),
    ('match',           'tr', '{name} de gidiyor',             '{title}'),
    ('friend_live',     'en', '{name} is out now',             '{title}'),
    ('friend_live',     'de', '{name} ist gerade unterwegs',   '{title}'),
    ('friend_live',     'tr', '{name} şu an dışarıda',         '{title}'),
    ('night_soon',      'en', 'tonight · {time}',              '{title}'),
    ('night_soon',      'de', 'heute nacht · {time}',          '{title}'),
    ('night_soon',      'tr', 'bu gece · {time}',              '{title}'),
    ('room_open',       'en', 'your room is open',             '{title} · 48 hours to write'),
    ('room_open',       'de', 'dein raum ist offen',           '{title} · 48 stunden zum schreiben'),
    ('room_open',       'tr', 'odan açık',                     '{title} · 48 saat yazabilirsin'),
    ('room_closing',    'en', 'your room closes soon',         '{title} · the last two hours'),
    ('room_closing',    'de', 'dein raum schließt bald',       '{title} · die letzten zwei stunden'),
    ('room_closing',    'tr', 'odan birazdan kapanıyor',       '{title} · son iki saat'),
    ('room_message',    'en', '{name} in {title}',             'a new line in your room'),
    ('room_message',    'de', '{name} in {title}',             'eine neue zeile in deinem raum'),
    ('room_message',    'tr', '{title} · {name}',              'odanda yeni bir satır'),
    ('reply',           'en', '{name} replied',                'a new reply'),
    ('reply',           'de', '{name} hat geantwortet',        'eine neue antwort'),
    ('reply',           'tr', '{name} cevap verdi',            'yeni bir cevap'),
    ('digest',          'en', 'this weekend in {city}',        '{n} nights · {friends} kept by friends'),
    ('digest',          'de', 'dieses wochenende in {city}',   '{n} nächte · {friends} von freunden behalten'),
    ('digest',          'tr', 'bu hafta sonu {city}',          '{n} gece · {friends} tanesini arkadaşların sakladı'),
    ('dj_live',         'en', '{name} plays soon',             '{where} · {time}'),
    ('dj_live',         'de', '{name} legt bald auf',          '{where} · {time}'),
    ('dj_live',         'tr', '{name} birazdan çalıyor',       '{where} · {time}'),
    ('wave',            'en', '2nd wave',                      'a friend of {via} kept {title}'),
    ('wave',            'de', '2. welle',                      'ein freund von {via} hat {title} behalten'),
    ('wave',            'tr', '2. dalga',                      '{via} üzerinden biri {title} gecesini sakladı'),
    ('spark',           'en', '{name} is starting something',  '{title} · {when}'),
    ('spark',           'de', '{name} startet etwas',          '{title} · {when}'),
    ('spark',           'tr', '{name} bir şey başlatıyor',     '{title} · {when}'),
    ('spark_in',        'en', '{name} is in',                  '{title}'),
    ('spark_in',        'de', '{name} ist dabei',              '{title}'),
    ('spark_in',        'tr', '{name} geliyor',                '{title}'),
    ('group_added',     'en', 'you are in {group}',            '{name} added you · swipe nights together'),
    ('group_added',     'de', 'du bist in {group}',            '{name} hat dich hinzugefügt · wischt zusammen'),
    ('group_added',     'tr', '{group} grubundasın',           '{name} seni ekledi · birlikte gece seçin'),
    ('group_joined',    'en', '{group}',                       '{name} joined'),
    ('group_joined',    'de', '{group}',                       '{name} ist dazugekommen'),
    ('group_joined',    'tr', '{group}',                       '{name} gruba katıldı'),
    ('group_match',     'en', '{group} · everyone is in',      '{title}'),
    ('group_match',     'de', '{group} · alle sind dabei',     '{title}'),
    ('group_match',     'tr', '{group} · herkes var',          '{title}'),
    ('group_round',     'en', '{group} · vote',                '{name} put {title} to a vote'),
    ('group_round',     'de', '{group} · abstimmung',          '{name} lässt abstimmen: {title}'),
    ('group_round',     'tr', '{group} · oylama',              '{name} oylamaya sundu: {title}'),
    ('group_won',       'en', '{group} · the vote is in',      '{title}'),
    ('group_won',       'de', '{group} · abgestimmt',          '{title}'),
    ('group_won',       'tr', '{group} · oylama bitti',        '{title}'),
    ('group_plan',      'en', '{group} · the plan',            '{name}: {title}'),
    ('group_plan',      'de', '{group} · der plan',            '{name}: {title}'),
    ('group_plan',      'tr', '{group} · plan',                '{name}: {title}'),
    ('group_message',   'en', '{group} · {name}',              'a new message'),
    ('group_message',   'de', '{group} · {name}',              'eine neue nachricht'),
    ('group_message',   'tr', '{group} · {name}',              'yeni bir mesaj'),
    ('group_live',      'en', '{group} · live now',            '{name} wants to swipe together, now'),
    ('group_live',      'de', '{group} · gerade live',         '{name} will jetzt zusammen wischen'),
    ('group_live',      'tr', '{group} · şimdi canlı',         '{name} şimdi birlikte kaydırmak istiyor'),
    ('group_ticket',    'en', '{group} · tomorrow',            'you are in for {title} but have no ticket yet'),
    ('group_ticket',    'de', '{group} · morgen',              'du bist bei {title} dabei, hast aber noch kein ticket'),
    ('group_ticket',    'tr', '{group} · yarın',               '{title} için geliyorsun ama henüz biletin yok'),
    ('post',            'en', '{name} posted',                 'a new post'),
    ('post',            'de', '{name} hat gepostet',           'ein neuer post'),
    ('post',            'tr', '{name} paylaştı',               'yeni bir gönderi'),
    ('post_like',       'en', '{name} likes your post',        'open yours to see it'),
    ('post_like',       'de', '{name} gefällt dein post',      'in yours ansehen'),
    ('post_like',       'tr', '{name} gönderini beğendi',      'yours sekmesinde'),
    ('post_comment',    'en', '{name} commented',              'a new comment'),
    ('post_comment',    'de', '{name} hat kommentiert',        'ein neuer kommentar'),
    ('post_comment',    'tr', '{name} yorum yaptı',            'yeni bir yorum'),
    -- 59_dms.sql: a direct message; the name, never the words
    ('dm',              'en', '{name}',                        'a new message'),
    ('dm',              'de', '{name}',                        'eine neue nachricht'),
    ('dm',              'tr', '{name}',                        'yeni bir mesaj'),
    ('staff',           'en', 'the panel',                     '{n} waiting: reports, nights sent in, dj pages'),
    ('staff',           'de', 'das panel',                     '{n} warten: meldungen, eingesandte nächte, dj-seiten'),
    ('staff',           'tr', 'panel',                         '{n} iş bekliyor: şikayetler, gönderilen geceler, dj sayfaları')
  ) as x(kind, lang, title, body)
  where x.kind = p_kind and x.lang = coalesce(nullif(p_lang, ''), 'en');

  -- The words of a member never reach a lock screen (the decision of owner, 11.10.2026): what the
  -- triggers still pass as text is dropped here, whatever the caller.
  for pair in select * from jsonb_each_text(coalesce(p_data, '{}') - 'text') loop
    title := replace(title, '{' || pair.key || '}', coalesce(pair.value, ''));
    body  := replace(body,  '{' || pair.key || '}', coalesce(pair.value, ''));
  end loop;
  return next;
end;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('58_push_words.sql', '72170a2f1792910b26a1499e6b3c4a62421fa14729ca27caf674c4c1b996a948');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('58_push_words.sql');
  end if;
end $$;


-- ============================================================
--  DIRECT MESSAGES   (59_dms.sql)
-- ============================================================

-- afterhours — direct messages (59)
--
--   dm_threads            one row per pair of friends who wrote each other (a < b)
--   dm_messages           the lines, 1000 characters at most, 20 a minute a person
--   dm_start(handle)      opens (or finds) the thread with a confirmed friend you can reach
--   dm_send(thread, body) a line; dm_unsay(id) takes your own back
--   dm_thread(thread, after)  the lines after a given id (0: the last 80), oldest first
--   dm_list()             your threads, newest first: the other person, the last line
--   push dm               the name of the sender and a fixed sentence (58), switch notify_dms
-- Friends only, and only while neither has blocked the other and neither is banned
-- (reachable, 57). The tables are closed; these calls are the only way in. Who has
-- seen what is the business of the phone (data/messages.ts), as for rooms and groups.

create table if not exists public.dm_threads (
  id          uuid primary key default gen_random_uuid(),
  a           uuid not null references public.profiles(id) on delete cascade,
  b           uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  last_at     timestamptz not null default now(),
  check (a < b),
  unique (a, b)
);
create table if not exists public.dm_messages (
  id          bigserial primary key,
  thread_id   uuid not null references public.dm_threads(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  body        text not null check (length(body) between 1 and 1000),
  created_at  timestamptz not null default now()
);
create index if not exists dm_messages_thread on public.dm_messages (thread_id, id);
create index if not exists dm_threads_a on public.dm_threads (a, last_at desc);
create index if not exists dm_threads_b on public.dm_threads (b, last_at desc);
alter table public.dm_threads enable row level security;
alter table public.dm_messages enable row level security;
revoke all on public.dm_threads from public, anon, authenticated;
revoke all on public.dm_messages from public, anon, authenticated;

-- a banned author writes nothing (52), and nobody writes twenty lines a minute (53)
drop trigger if exists guard_banned on public.dm_messages;
create trigger guard_banned before insert or update on public.dm_messages for each row execute function public.guard_banned();
drop trigger if exists guard_rate on public.dm_messages;
create trigger guard_rate before insert on public.dm_messages for each row execute function public.guard_rate('user_id', '1 minute', '20');

-- the other end of a thread
create or replace function public.dm_other(p_thread uuid, p_me uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select case when t.a = p_me then t.b when t.b = p_me then t.a end
  from public.dm_threads t where t.id = p_thread;
$$;
revoke execute on function public.dm_other(uuid, uuid) from public, anon, authenticated;

create or replace function public.dm_start(p_handle text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me    uuid := public.assert_member();
  other uuid;
  t     uuid;
begin
  if public.is_guest() then raise exception 'sign up to write to someone'; end if;
  select p.id into other from public.profiles p where p.handle = lower(btrim(regexp_replace(coalesce(p_handle, ''), '^@', '')));
  if other is null or other = me then raise exception 'no such person'; end if;
  if not public.are_friends(me, other) then raise exception 'friends only'; end if;
  if not public.reachable(me, other) then raise exception 'no such person'; end if;
  insert into public.dm_threads (a, b) values (least(me, other), greatest(me, other))
  on conflict (a, b) do update set last_at = public.dm_threads.last_at
  returning id into t;
  return t;
end;
$$;
revoke execute on function public.dm_start(text) from public, anon;
grant execute on function public.dm_start(text) to authenticated;

create or replace function public.dm_send(p_thread uuid, p_body text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  me    uuid := public.assert_member();
  other uuid := public.dm_other(p_thread, me);
  r     bigint;
begin
  if other is null then raise exception 'no such conversation'; end if;
  if not public.are_friends(me, other) or not public.reachable(me, other) then raise exception 'no such conversation'; end if;
  if length(btrim(coalesce(p_body, ''))) not between 1 and 1000 then raise exception '1 to 1000 characters'; end if;
  insert into public.dm_messages (thread_id, user_id, body) values (p_thread, me, btrim(p_body)) returning id into r;
  update public.dm_threads set last_at = now() where id = p_thread;
  if to_regprocedure('public.push_enqueue(uuid, text, text, jsonb)') is not null then
    perform public.push_enqueue(other, 'dm', format('dm:%s', r),
      jsonb_build_object('name', public.push_name(me), 'url', '/dm/' || p_thread));
  end if;
  return r;
end;
$$;
revoke execute on function public.dm_send(uuid, text) from public, anon;
grant execute on function public.dm_send(uuid, text) to authenticated;

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
revoke execute on function public.dm_unsay(bigint) from public, anon;
grant execute on function public.dm_unsay(bigint) to authenticated;

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
    order by m.id desc
    limit case when p_after = 0 then 80 else 500 end
  ) last order by last.id;
end;
$$;
revoke execute on function public.dm_thread(uuid, bigint) from public, anon;
grant execute on function public.dm_thread(uuid, bigint) to authenticated;

-- 90 adds a column to what this returns; a re-run must not trip on the old shape
drop function if exists public.dm_list();
create or replace function public.dm_list()
returns table (id uuid, other_id uuid, handle text, name text, last_body text, last_mine boolean, last_id bigint, last_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  select t.id, o.id, o.handle, coalesce(o.display_name, o.handle),
         l.body, l.user_id = me, l.id, t.last_at
  from public.dm_threads t
  join public.profiles o on o.id = case when t.a = me then t.b else t.a end
  left join lateral (select m.id, m.body, m.user_id from public.dm_messages m where m.thread_id = t.id order by m.id desc limit 1) l on true
  where me in (t.a, t.b)
    and public.reachable(me, o.id)
  order by t.last_at desc;
end;
$$;
revoke execute on function public.dm_list() from public, anon;
grant execute on function public.dm_list() to authenticated;

-- the push: its own switch, its kind on the outbox
alter table public.profile_settings add column if not exists notify_dms boolean not null default true;
alter table public.push_outbox drop constraint if exists push_outbox_kind_check;
alter table public.push_outbox add constraint push_outbox_kind_check check (kind in (
  'friend_request', 'friend_accepted', 'match', 'friend_live',
  'night_soon', 'room_open', 'room_closing', 'room_message', 'reply',
  'digest', 'dj_live', 'wave', 'spark', 'spark_in',
  'group_added', 'group_joined', 'group_match', 'group_round', 'group_won', 'group_plan',
  'group_message', 'group_live', 'group_ticket', 'post',
  'staff', 'post_like', 'post_comment',
  'dm'));

create or replace function public.push_wants(p_user uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select case
             when p_kind = 'friend_request'  then s.notify_requests
             when p_kind = 'friend_accepted' then s.notify_accepts
             when p_kind = 'match'           then s.notify_matches
             when p_kind = 'friend_live'     then s.notify_live
             when p_kind = 'night_soon'      then s.notify_nights
             when p_kind in ('room_open', 'room_closing', 'room_message') then s.notify_rooms
             when p_kind = 'reply'           then s.notify_replies
             when p_kind = 'digest'          then s.notify_digest
             when p_kind = 'dj_live'         then s.notify_djs
             when p_kind = 'wave'            then s.notify_waves
             when p_kind in ('spark', 'spark_in') then s.notify_sparks
             when p_kind like 'group\_%' then s.notify_groups
             when p_kind in ('post', 'post_like', 'post_comment') then s.notify_posts
             when p_kind = 'dm'              then s.notify_dms
           end
    from public.profile_settings s where s.user_id = p_user), true);
$$;

-- what leaves with the account: the threads go with the profile (cascade); the export
-- (14) does not list them yet — a line in promises.md says so.

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('59_dms.sql', 'ff42a3de133b25de321f261391abc791c6ff92c428165841787a6f7a24d1032e');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('59_dms.sql');
  end if;
end $$;


-- ============================================================
--  DID YOU GET YOUR TICKET   (60_tickets.sql)
-- ============================================================

-- afterhours — did you get your ticket? (60)
--
-- Ticketmaster tells nobody who bought what, so the app asks you once, when you come
-- back from the ticket page: got it / not this time. The answer is yours alone.
--
--   tickets                   one row per person and night: got · no, and when
--   ticket_mark(slug, answer) your answer (members only; a guest is refused)
--   ticket_state(slug)        your answer for a night, or null
--   tickets_mine()            the nights you have a ticket for (ids)
-- Nobody else reads it; the row goes with the account. Not in the export yet (14).

create table if not exists public.tickets (
  user_id      uuid not null references public.profiles(id) on delete cascade,
  event_id     uuid not null references public.events(id) on delete cascade,
  answer       text not null check (answer in ('got', 'no')),
  answered_at  timestamptz not null default now(),
  primary key (user_id, event_id)
);
alter table public.tickets enable row level security;
revoke all on public.tickets from public, anon, authenticated;
drop trigger if exists guard_banned on public.tickets;
create trigger guard_banned before insert or update on public.tickets for each row execute function public.guard_banned();

create or replace function public.ticket_mark(p_slug text, p_answer text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  e  uuid;
begin
  if public.is_guest() then raise exception 'sign up first'; end if;
  if p_answer not in ('got', 'no') then raise exception 'got or no'; end if;
  select id into e from public.events where slug = p_slug and is_published;
  if e is null then raise exception 'no such night'; end if;
  insert into public.tickets (user_id, event_id, answer) values (me, e, p_answer)
  on conflict (user_id, event_id) do update set answer = excluded.answer, answered_at = now();
end;
$$;
revoke execute on function public.ticket_mark(text, text) from public, anon;
grant execute on function public.ticket_mark(text, text) to authenticated;

create or replace function public.ticket_state(p_slug text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select t.answer from public.tickets t join public.events e on e.id = t.event_id
  where e.slug = p_slug and t.user_id = auth.uid();
$$;
revoke execute on function public.ticket_state(text) from public, anon;
grant execute on function public.ticket_state(text) to authenticated;

create or replace function public.tickets_mine()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select t.event_id from public.tickets t where t.user_id = auth.uid() and t.answer = 'got';
$$;
revoke execute on function public.tickets_mine() from public, anon;
grant execute on function public.tickets_mine() to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('60_tickets.sql', '54fd0d0743f10a2c958b19fb80e0f7751fcfa920dea9f7cf6b69397bb15b8d60');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('60_tickets.sql');
  end if;
end $$;


-- ============================================================
--  TRAVEL GROUPS   (61_travel.sql)
-- ============================================================

-- afterhours — travel groups (61)
--
-- A group is for friends (as before) or for a trip. A travel group carries a route:
-- legs, one per city, each with the days there (berlin 03.11 to 05.11, wien 05.11 to
-- 07.11 ...). Its deck is the nights of those cities on those days, so the matches,
-- the plan and the live session work as in any group. The page in the app is a
-- passport: one page per leg with that leg of the route, the nights the group kept
-- there and the photos from there.
--
--   group_legs        the route: leg_no, city, first and last day
--   group_legs_set    any member writes the whole route at once (1 to 12 legs, in order)
--   group_legs        the route with counts: nights kept there, photos from there
--   group_leg_nights  the nights at least one member kept, on that leg, past ones too
--   group_leg_photos  the photos of the group from that leg
--   group_window      the deck of a travel group is the union of its legs
--
-- Chosen on 12.10.2026 (design A, prototypes/travel.html). Groups made before keep
-- their kind; the app offers friends or travel when a group is made.

-- the kind: friends (lasting), once (no longer offered) or travel
alter table public.groups drop constraint if exists groups_kind_check;
alter table public.groups add constraint groups_kind_check check (kind in ('lasting', 'once', 'travel'));
alter table public.groups drop constraint if exists groups_once_dated;
alter table public.groups add constraint groups_once_dated check (kind <> 'once' or date_to is not null);

create table if not exists public.group_legs (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.groups on delete cascade,
  leg_no    int  not null check (leg_no between 1 and 12),
  city_slug   text not null references public.cities (slug),
  date_from   date not null,
  date_to     date not null,
  constraint group_legs_window check (date_to >= date_from),
  unique (group_id, leg_no)
);
alter table public.group_legs enable row level security;
revoke all on public.group_legs from public, anon, authenticated;

-- The checks of a group, now with travel as a kind.
create or replace function public.group_check(p_name text, p_emoji text, p_color text, p_kind text,
                                              p_city text, p_from date, p_to date)
returns void
language plpgsql
stable
set search_path = public
as $$
begin
  if length(btrim(coalesce(p_name, ''))) not between 1 and 40 then raise exception 'name: 1 to 40 characters'; end if;
  if length(coalesce(p_emoji, '')) not between 1 and 8 then raise exception 'one emoji'; end if;
  if coalesce(p_color, 'red') not in ('red', 'gold', 'blue', 'green', 'violet', 'paper') then raise exception 'unknown colour'; end if;
  if coalesce(p_kind, 'lasting') not in ('lasting', 'once', 'travel') then raise exception 'friends, once or travel'; end if;
  if p_kind = 'once' and p_to is null then raise exception 'a group for once needs its last day'; end if;
  if p_from is not null and p_to is not null and p_to < p_from then raise exception 'the last day comes after the first'; end if;
  if p_kind <> 'travel' and p_to is not null and p_to < current_date then raise exception 'those days are over'; end if;
  if p_city is not null and not exists (select 1 from public.cities where slug = p_city) then raise exception 'unknown city'; end if;
end;
$$;

-- The route, written whole: [{"city": "berlin", "from": "2026-11-03", "to": "2026-11-05"}, ...].
-- In order of travel: a leg starts no earlier than the one before it. The window of the
-- group (date_from, date_to) follows the route, so the groups shelf can say when.
create or replace function public.group_legs_set(p_id uuid, p_legs jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  leg jsonb;
  i int := 0;
  prev date;
  d_from date;
  d_to date;
  city text;
begin
  perform public.need_member(p_id);
  if (select kind from public.groups where id = p_id) <> 'travel' then raise exception 'not a travel group'; end if;
  if p_legs is null or jsonb_typeof(p_legs) <> 'array' then raise exception 'a list of legs'; end if;
  if jsonb_array_length(p_legs) not between 1 and 12 then raise exception '1 to 12 cities'; end if;
  delete from public.group_legs where group_id = p_id;
  for leg in select * from jsonb_array_elements(p_legs) loop
    i := i + 1;
    city := leg ->> 'city';
    if city is null or not exists (select 1 from public.cities where slug = city) then raise exception 'unknown city'; end if;
    begin
      d_from := (leg ->> 'from')::date;
      d_to := (leg ->> 'to')::date;
    exception when others then
      raise exception 'days as yyyy-mm-dd';
    end;
    if d_from is null or d_to is null then raise exception 'each city needs its first and last day'; end if;
    if d_to < d_from then raise exception 'the last day comes after the first'; end if;
    if prev is not null and d_from < prev then raise exception 'the cities in the order of travel'; end if;
    insert into public.group_legs (group_id, leg_no, city_slug, date_from, date_to) values (p_id, i, city, d_from, d_to);
    prev := d_from;
  end loop;
  update public.groups g set city_slug = null,
         date_from = (select min(l.date_from) from public.group_legs l where l.group_id = p_id),
         date_to = (select max(l.date_to) from public.group_legs l where l.group_id = p_id)
   where g.id = p_id;
  return i;
end;
$$;

-- The nights at least one member kept, on one leg: the city and the days of the leg.
-- Past nights stay (a trip is also a memory), so this is not group_matches.
create or replace function public.group_leg_nights(p_id uuid, p_leg uuid)
returns table (id uuid, slug text, title text, starts_at timestamptz, venue_name text, image_url text,
               yes int, members int, status text, yes_ids uuid[])
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  n int;
  l public.group_legs;
begin
  perform public.need_member(p_id);
  select * into l from public.group_legs where group_legs.id = p_leg and group_id = p_id;
  if l.id is null then raise exception 'no such leg'; end if;
  select count(*) into n from public.group_members where group_id = p_id;
  return query
    with votes as (
      select s.event_id,
             count(*) filter (where s.direction = 'right')::int as y,
             array_agg(s.user_id) filter (where s.direction = 'right') as ids
      from public.group_swipes s
      join public.group_members m on m.group_id = s.group_id and m.user_id = s.user_id
      where s.group_id = p_id
      group by s.event_id)
    select e.id, e.slug, e.title, e.starts_at, v.name, e.image_url, vo.y, n,
           case when vo.y = n then 'match' when vo.y * 2 > n then 'most' else 'some' end, vo.ids
    from votes vo
    join public.events e on e.id = vo.event_id and e.is_published
    join public.cities c on c.id = e.city_id and c.slug = l.city_slug
    left join public.venues v on v.id = e.venue_id
    where vo.y > 0 and e.starts_at::date between l.date_from and l.date_to
    order by e.starts_at, e.id;
end;
$$;

-- The photos of the group from one leg: those of nights on that leg.
create or replace function public.group_leg_photos(p_id uuid, p_leg uuid)
returns table (id uuid, path text, event_id uuid, event_title text, starts_at timestamptz, name text, mine boolean, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  l public.group_legs;
begin
  perform public.need_member(p_id);
  select * into l from public.group_legs where group_legs.id = p_leg and group_id = p_id;
  if l.id is null then raise exception 'no such leg'; end if;
  return query
    select ph.id, ph.path, e.id, e.title, e.starts_at, coalesce(p.display_name, p.handle), ph.user_id = auth.uid(), ph.created_at
    from public.group_photos ph
    join public.events e on e.id = ph.event_id
    join public.cities c on c.id = e.city_id and c.slug = l.city_slug
    left join public.profiles p on p.id = ph.user_id
    where ph.group_id = p_id and e.starts_at::date between l.date_from and l.date_to
    order by e.starts_at, ph.created_at
    limit 300;
end;
$$;

-- The route with its counts, in order of travel.
create or replace function public.group_legs(p_id uuid)
returns table (id uuid, leg_no int, city_slug text, city_name text, country_slug text,
               date_from date, date_to date, kept int, photos int)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_id);
  return query
    select l.id, l.leg_no, l.city_slug, c.name, c.country_slug, l.date_from, l.date_to,
           (select count(*)::int from public.group_leg_nights(p_id, l.id)),
           (select count(*)::int from public.group_leg_photos(p_id, l.id))
    from public.group_legs l
    join public.cities c on c.slug = l.city_slug
    where l.group_id = p_id
    order by l.leg_no;
end;
$$;

-- The deck of a group: as before for friends; for a trip, the nights of each leg on
-- its days, all legs together.
create or replace function public.group_window(p_id uuid)
returns setof public.events_public
language sql
stable
security definer
set search_path = public
as $$
  with g as (select * from public.groups where id = p_id),
       members as (select user_id from public.group_members where group_id = p_id),
       liked_types as (
         select e.type_id, count(*) as n
         from public.swipes s join public.events e on e.id = s.event_id
         where s.direction = 'right' and s.user_id in (select user_id from members)
         group by e.type_id)
  select e.* from public.events_public e, g
  where e.is_published
    and (
      (g.kind <> 'travel'
        and (g.city_slug is null or e.city_slug = g.city_slug)
        and (e.starts_at is null or e.starts_at::date >= greatest(coalesce(g.date_from, current_date), current_date))
        and (g.date_to is null or e.starts_at::date <= g.date_to))
      or
      (g.kind = 'travel'
        and e.starts_at::date >= current_date
        and exists (select 1 from public.group_legs l
                    where l.group_id = p_id and l.city_slug = e.city_slug
                      and e.starts_at::date between l.date_from and l.date_to))
    )
  order by
    3 * (select count(*) from public.swipes s where s.event_id = e.id and s.direction = 'right' and s.user_id in (select user_id from members))
    + coalesce((select least(n, 20) from liked_types lt join public.events x on x.type_id = lt.type_id where x.id = e.id), 0) / 5.0 desc,
    e.starts_at nulls last, e.id
  limit 400;
$$;
revoke all on function public.group_window(uuid) from public, anon, authenticated;

-- group_get carries the route.
create or replace function public.group_get(p_id uuid)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_id);
  return (
    select json_build_object(
      'id', g.id, 'name', g.name, 'emoji', g.emoji, 'color', g.color, 'cover_path', g.cover_path,
      'kind', g.kind, 'city_slug', g.city_slug, 'date_from', g.date_from, 'date_to', g.date_to,
      'archived', g.kind = 'once' and g.date_to < current_date, 'visible', g.visible,
      'me', auth.uid(),
      'members', (select json_agg(json_build_object('id', p.id, 'handle', p.handle, 'name', p.display_name, 'role', m.role) order by m.joined_at)
                  from public.group_members m join public.profiles p on p.id = m.user_id where m.group_id = g.id),
      'legs', coalesce((select json_agg(json_build_object('id', l.id, 'leg_no', l.leg_no, 'city', l.city_slug, 'from', l.date_from, 'to', l.date_to) order by l.leg_no)
                        from public.group_legs l where l.group_id = g.id), '[]'::json))
    from public.groups g where g.id = p_id);
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'group_legs_set(uuid, jsonb)', 'group_legs(uuid)', 'group_leg_nights(uuid, uuid)', 'group_leg_photos(uuid, uuid)', 'group_get(uuid)'
  ] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('61_travel.sql', '6d88a4f65688cc0895eac7faf24d741dbb2c4758297bc4889d2ba2b5574ba4fd');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('61_travel.sql');
  end if;
end $$;


-- ============================================================
--  A GROUP COVER FROM THE SHELF   (62_group_covers.sql)
-- ============================================================

-- afterhours — a group cover from the shelf (62)
--
-- A group can wear one of the photos the app ships with as its cover (club, crowd,
-- friends), not only a photo uploaded by a member: the path is then preset/<name>
-- instead of <user>/<file>. The app maps the name to its bundled picture; nothing is
-- uploaded. Asked by owner on 12.10.2026 so a group has a face from the first minute.

create or replace function public.group_set_cover(p_id uuid, p_path text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  was text;
begin
  perform public.need_member(p_id);
  if p_path is not null and p_path not like auth.uid()::text || '/%' and p_path !~ '^preset/[a-z0-9-]{1,32}$' then
    raise exception 'not your file';
  end if;
  select cover_path into was from public.groups where id = p_id;
  update public.groups set cover_path = p_path where id = p_id;
  return was;
end;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('62_group_covers.sql', 'eb702e11de3ec89a90bfceca923dd764c80e2bb192bca1b827d781936580ec9d');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('62_group_covers.sql');
  end if;
end $$;


-- ============================================================
--  LISTEN TO THE ARTIST   (63_previews.sql)
-- ============================================================

-- afterhours — listen to the artist (63)
--
-- A night can carry a 30 second preview of the act: the most played track of the artist
-- on Apple, matched ahead of time by tools/previews.mjs (the artist name must match the
-- act on the night; no match, no row, no button). The app shows a listen button on the
-- card (design D in prototypes/listen.html) and plays the preview over the poster.
--
--   event_previews        one row per night: track, artist, the preview address, the link
--   previews_for(ids)     the rows for these nights (published nights only)
--
-- Anyone may read them (they are about public nights). Only the service role writes:
-- the rows come from the tool, pasted as a reviewed SQL file.

create table if not exists public.event_previews (
  event_id     uuid primary key references public.events on delete cascade,
  track        text not null check (length(track) between 1 and 200),
  artist       text not null check (length(artist) between 1 and 200),
  preview_url  text not null check (preview_url ~ '^https://'),
  link         text check (link is null or link ~ '^https://'),
  source       text not null default 'apple' check (source in ('apple', 'deezer')),
  made_at      timestamptz not null default now()
);

alter table public.event_previews enable row level security;
revoke all on public.event_previews from public, anon, authenticated;

create or replace function public.previews_for(p_events uuid[])
returns table (event_id uuid, track text, artist text, preview_url text, link text, source text)
language sql
stable
security definer
set search_path = public
as $$
  select p.event_id, p.track, p.artist, p.preview_url, p.link, p.source
  from public.event_previews p
  join public.events e on e.id = p.event_id and e.is_published
  where p.event_id = any(p_events);
$$;
revoke all on function public.previews_for(uuid[]) from public;
grant execute on function public.previews_for(uuid[]) to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('63_previews.sql', '68f08b2aca6230170b1b71d7d1449e89e8feb7b638587cf56c30babb6f0c5408');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('63_previews.sql');
  end if;
end $$;


-- ============================================================
--  THE EXPORT — YOUR MESSAGES AND TICKET ANSWERS TOO   (64_export_more.sql)
-- ============================================================

-- afterhours — the export, with your messages and your ticket answers (64)
--
-- export_me() (14) was written before direct messages (59) and ticket answers (60),
-- so it handed a person less than everything. The same function again, with two more
-- lists:
--   messages   the lines you wrote, each with the handle of the friend it went to
--   tickets    your answer for each night: got or no, and when
-- The lines the other person wrote are theirs, not yours, and stay out: the export
-- holds everything of yours and nothing of anybody else (promise 6).

create or replace function public.export_me()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'taken_at', now(),
    'about', 'Everything afterhours holds about you. Your account email lives'
             || ' with the sign-in provider, not in this database.',

    'profile', (
      select to_jsonb(x) from (
        select p.handle, p.display_name, p.bio, c.slug as city,
               p.created_at as joined, p.onboarded_at, p.last_seen_at
        from public.profiles p
        left join public.cities c on c.id = p.city_id
        where p.id = auth.uid()
      ) x),

    'settings', (
      select to_jsonb(x) from (
        select s.kept_visibility, s.discoverable, s.notify_email, s.locale
        from public.profile_settings s where s.user_id = auth.uid()
      ) x),

    'swipes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event', e.slug, 'title', e.title,
               'direction', w.direction, 'at', w.created_at)
             order by w.created_at)
      from public.swipes w
      join public.events e on e.id = w.event_id
      where w.user_id = auth.uid()
    ), '[]'::jsonb),

    'comments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event', e.slug, 'body', c.body,
               'reply_to', c.parent_id, 'at', c.created_at)
             order by c.created_at)
      from public.comments c
      join public.events e on e.id = c.event_id
      where c.author_id = auth.uid()
    ), '[]'::jsonb),

    'friendships', coalesce((
      select jsonb_agg(jsonb_build_object(
               'handle', p.handle, 'status', f.status,
               'direction', case when f.requester_id = auth.uid()
                                 then 'outgoing' else 'incoming' end,
               'at', f.created_at)
             order by f.created_at)
      from public.friendships f
      join public.profiles p
        on p.id = case when f.requester_id = auth.uid()
                       then f.addressee_id else f.requester_id end
      where f.requester_id = auth.uid() or f.addressee_id = auth.uid()
    ), '[]'::jsonb),

    'feedback', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', g.kind, 'body', g.body, 'at', g.created_at)
             order by g.created_at)
      from public.feedback g where g.author_id = auth.uid()
    ), '[]'::jsonb),

    -- The lines you wrote, named by the friend they went to.
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
               'to', p.handle, 'body', m.body, 'at', m.created_at)
             order by m.id)
      from public.dm_messages m
      join public.dm_threads t on t.id = m.thread_id
      left join public.profiles p
        on p.id = case when t.a = auth.uid() then t.b else t.a end
      where m.user_id = auth.uid()
    ), '[]'::jsonb),

    'tickets', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event', e.slug, 'title', e.title,
               'answer', k.answer, 'at', k.answered_at)
             order by k.answered_at)
      from public.tickets k
      join public.events e on e.id = k.event_id
      where k.user_id = auth.uid()
    ), '[]'::jsonb)
  )
  where auth.uid() is not null;
$$;

grant execute on function public.export_me() to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('64_export_more.sql', '75d37ddd068f002d692f299f8840fb3b69b703a57eae0d056f84cec6144a4bd4');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('64_export_more.sql');
  end if;
end $$;


-- ============================================================
--  DELETING AN ACCOUNT — THE LAST ADMIN, THE GROUP OWNER   (65_account_delete.sql)
-- ============================================================

-- afterhours — deleting an account, the two loose ends (65)
--
-- delete_account() (12) removes the auth user and lets the cascades do the rest; the
-- full sweep in delete-account.test.mjs shows no row of any table still points at the
-- person afterwards. Two things the cascade cannot know:
--   the last admin   guard_last_admin (53) keeps the last admin from being demoted,
--                    but a deletion went round it and left nobody to run the panel
--   a group owner    group_leave (44) hands a group to the longest member; a deletion
--                    took the owner row away and left a group nobody could manage,
--                    or, when the owner was alone, an empty group
-- The same function again, with both closed. Comments are still kept as someone (12).

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

  update public.comments
     set author_id = null, author_name = 'someone'
   where author_id = me;

  delete from auth.users where id = me;
end;
$$;

grant execute on function public.delete_account() to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('65_account_delete.sql', '4b82eceeb5cf323a09884a8024f5fe06ee48435a83bfcb089160c9f3b6a3aa8e');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('65_account_delete.sql');
  end if;
end $$;


-- ============================================================
--  A NIGHT THAT HAPPENED STAYS — RETIRED, NOT DELETED; PRUNED ONLY WHEN UNTOUCHED   (66_keep_past_nights.sql)
-- ============================================================

-- afterhours — a night that happened stays (66)
--
-- The morning sync used to DELETE every Ticketmaster night whose date had passed.
-- events is the parent of nearly everything a person does on a night: the check-in
-- card in their collection, the room posts, the swipes, the comments, the answers to
-- who is coming, the ticket answers, the group votes. All of it went with the row,
-- every morning at 04:10. Found by the first autonomous night (A1 / F1, 20.10.2026).
--
-- From now on a past night is RETIRED, not deleted: is_published = false, which the
-- deck, the map and the counters already honour (06, 15, 18), while the collection
-- (19), the past feed (31) and the export (14) keep reading it. The sync does this
-- with a PATCH; hide_past_events() (09) does the same on its own clock.
--
-- Rows that nobody ever touched are still pruned, after a year: a night no one
-- swiped, kept, checked in to, answered or voted on carries no memory, and the
-- feed only reaches back 365 days. events_prune_untouched() is the only place that
-- deletes a synced night now, and it refuses any row something still points at.
--
--   events_prune_untouched(days)   service only; returns how many rows went

drop function if exists public.events_prune_untouched(int);
create or replace function public.events_prune_untouched(p_days int default 400)
returns integer
language sql
security definer
set search_path = public
as $$
  with gone as (
    delete from public.events e
    where e.source = 'ticketmaster'
      and e.starts_at is not null
      and e.starts_at < now() - make_interval(days => greatest(coalesce(p_days, 400), 365))
      and not exists (select 1 from public.swipes              x where x.event_id = e.id)
      and not exists (select 1 from public.comments            x where x.event_id = e.id)
      and not exists (select 1 from public.checkins            x where x.event_id = e.id)
      and not exists (select 1 from public.room_posts          x where x.event_id = e.id)
      and not exists (select 1 from public.rsvps               x where x.event_id = e.id)
      and not exists (select 1 from public.tickets             x where x.event_id = e.id)
      and not exists (select 1 from public.event_about         x where x.event_id = e.id)
      and not exists (select 1 from public.group_swipes        x where x.event_id = e.id)
      and not exists (select 1 from public.group_live_skips    x where x.event_id = e.id)
      and not exists (select 1 from public.group_photos        x where x.event_id = e.id)
      and not exists (select 1 from public.group_round_options x where x.event_id = e.id)
      and not exists (select 1 from public.group_ballots       x where x.event_id = e.id)
      and not exists (select 1 from public.group_tickets       x where x.event_id = e.id)
      and not exists (select 1 from public.posts               x where x.event_id = e.id)
      and not exists (select 1 from public.groups              x where x.plan_event_id = e.id)
    returning 1
  )
  select count(*)::int from gone;
$$;

-- The sync calls it with the service key; no browser role may.
revoke execute on function public.events_prune_untouched(int) from public, anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('66_keep_past_nights.sql', 'c6bbe32a8697b1597cb2030db487d991b3ea853f0acc2413116ee63f59c143e6');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('66_keep_past_nights.sql');
  end if;
end $$;


-- ============================================================
--  THE DECK DOES NOT DEPEND ON THE CLOCK JOB — PAST SYNCED NIGHTS LEAVE BY DATE   (67_deck_today.sql)
-- ============================================================

-- afterhours — the deck does not depend on the clock job (67)
--
-- A synced night whose date has passed left the deck only when hide_past_events (09,
-- pg_cron) or the morning sync got to it. When neither ran, the deck and the counters
-- served last week: on 11.10.2026 health counted 680 past nights still published
-- (A7 / F11, 20.10.2026). The map already filtered by date (18); now the deck and the
-- counters do too. Only synced nights, whose dates are real: a seed or an admin-written
-- night with an estimated date is left to the jobs.
--
-- Same bodies as 15 and 06, plus one line: a synced night stays for eight hours after
-- its start (the night is still going), then it is gone from the deck.

create or replace function public.deck(
  p_city text default 'munchen',
  p_type text default null,
  p_limit int  default 60
)
returns setof public.events_public
language sql
stable
security definer
set search_path = public
as $$
  select e.*
  from public.events_public e
  where e.is_published
    and (p_city is null or e.city_slug = p_city)
    and (p_type is null or e.type_slug = p_type)
    and (e.source <> 'ticketmaster' or e.starts_at is null or e.starts_at > now() - interval '8 hours')
    and not exists (
      select 1 from public.swipes s
      where s.event_id = e.id and s.user_id = auth.uid()
    )
  order by e.poster_no nulls last, e.starts_at nulls last, e.slug
  limit p_limit;
$$;

create or replace function public.event_counts(p_city text default 'munchen')
returns table (type_slug text, type_name text, sort_order int, n bigint)
language sql
stable
as $$
  select e.type_slug, e.type_name, e.type_sort_order, count(*)
  from public.events_public e
  where e.is_published and e.city_slug = p_city
    and (e.source <> 'ticketmaster' or e.starts_at is null or e.starts_at > now() - interval '8 hours')
  group by e.type_slug, e.type_name, e.type_sort_order
  order by e.type_sort_order;
$$;

drop function if exists public.city_counts();
create or replace function public.city_counts()
returns table (
  slug            text,
  name            text,
  status          text,
  sort_order            int,
  country         text,
  country_slug    text,
  continent       text,
  continent_slug  text,
  n               bigint
)
language sql
stable
as $$
  select c.slug, c.name, c.status, c.sort_order, c.country, c.country_slug,
         c.continent, c.continent_slug,
         count(e.id) filter (where e.is_published
                             and (e.source <> 'ticketmaster' or e.starts_at is null or e.starts_at > now() - interval '8 hours'))
  from public.cities c
  left join public.events e on e.city_id = c.id
  group by c.slug, c.name, c.status, c.sort_order, c.country, c.country_slug,
           c.continent, c.continent_slug
  order by c.sort_order;
$$;

grant execute on function public.city_counts()         to anon, authenticated;
grant execute on function public.deck(text, text, int)  to anon, authenticated;
grant execute on function public.event_counts(text)     to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('67_deck_today.sql', '1f9c7019e1c0d8eca57c5a6ac4fb03e867cb2dfd721e72579df6348fb379045a');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('67_deck_today.sql');
  end if;
end $$;


-- ============================================================
--  THE PERSON WHO REPORTED HEARS THE OUTCOME   (68_report_answered.sql)
-- ============================================================

-- afterhours — the person who reported hears the outcome (68)
--
-- A report went into the panel and the reporter never heard of it again (F16,
-- 20.10.2026). The one reported already gets a notice when something of theirs is
-- hidden or removed (53); now the reporter gets one too, the moment the staff settle
-- the report: report_removed when the thing went, report_kept when it stayed. The
-- notice says what kind of thing it was and nothing about who; the staff never
-- answer in their own words (58).
--
-- staff_report_settle() is the same as in 51, with the notices added before the
-- reports are marked handled.

alter table public.notices drop constraint if exists notices_kind_check;
alter table public.notices add constraint notices_kind_check
  check (kind in ('comment_hidden', 'post_hidden', 'removed', 'profile_cleared',
                  'role', 'dj_verified', 'dj_hidden', 'report_removed', 'report_kept'));

create or replace function public.staff_report_settle(p_kind text, p_target text, p_remove boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  who record;
begin
  perform public.need_staff();
  if coalesce(p_remove, false) then
    if p_kind = 'comment' then
      update public.comments set is_hidden = true where id::text = p_target;
    elsif p_kind = 'room_post' then
      delete from public.room_posts where id::text = p_target;
    elsif p_kind = 'group_message' then
      delete from public.group_messages where id::text = p_target;
    elsif p_kind = 'spark' then
      delete from public.sparks where id::text = p_target;
    elsif p_kind = 'group' then
      delete from public.groups where id::text = p_target;
    elsif p_kind = 'post_comment' then
      execute 'update public.post_comments set is_hidden = true where id::text = $1' using p_target;
    elsif p_kind = 'profile' then
      update public.profiles set bio = null, about = null where id::text = p_target;
      delete from public.profile_links where user_id::text = p_target;
      delete from public.profile_photos where user_id::text = p_target;
    else
      raise exception 'which kind?';
    end if;
  end if;
  for who in select distinct r.reporter_id from public.reports r
             where r.kind = p_kind and r.target = p_target and not r.handled loop
    perform public.notice(who.reporter_id,
                          case when coalesce(p_remove, false) then 'report_removed' else 'report_kept' end,
                          jsonb_build_object('what', p_kind));
  end loop;
  update public.reports set handled = true where kind = p_kind and target = p_target and not handled;
  perform public.staff_note(case when coalesce(p_remove, false) then 'remove' else 'keep' end, 'report:' || p_kind, p_target, null);
end;
$$;

revoke execute on function public.staff_report_settle(text, text, boolean) from public, anon;
grant execute on function public.staff_report_settle(text, text, boolean)  to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('68_report_answered.sql', 'd31c57dbea50047478594749cc020ad351ba62ed92f4d92900ebac9714efe953');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('68_report_answered.sql');
  end if;
end $$;


-- ============================================================
--  I AM IN REACHES THE FRIENDS ON THAT NIGHT   (69_rsvp_push.sql)
-- ============================================================

-- afterhours — "I am in" reaches the friends on that night (69)
--
-- A friend answers who is coming with in (32) and nobody heard of it; a keep (a right
-- swipe) already tells the friends who kept the same night "{name} is going too"
-- (26, kind match). An answer is a louder keep: the same push, to the friends who
-- kept the night or answered in themselves, once per answerer and night. It rides on
-- the match switch (notify_matches) and the match words (58), so nothing new to set
-- or translate; the key says rsvp so it never collides with the push of the keep itself.
-- Nothing when the answerer keeps their keeps private (12: kept_visibility), as with
-- the keep itself. maybe and out say nothing. (C1, 20.10.2026)

create or replace function public.push_on_rsvp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  night record;
  them  record;
begin
  if new.answer <> 'in' or (tg_op = 'UPDATE' and old.answer = 'in') then
    return new;
  end if;
  if not public.kept_visible(new.user_id) then
    return new;
  end if;
  select e.title, e.slug into night from public.events e where e.id = new.event_id;

  for them in
    select distinct f.friend as user_id
    from public.push_edges f
    where f.who = new.user_id
      and (exists (select 1 from public.swipes w where w.user_id = f.friend and w.event_id = new.event_id and w.direction = 'right')
        or exists (select 1 from public.rsvps r where r.user_id = f.friend and r.event_id = new.event_id and r.answer = 'in'))
  loop
    perform public.push_enqueue(them.user_id, 'match',
      format('rsvp:%s:%s:%s', them.user_id, new.user_id, new.event_id),
      jsonb_build_object('name', public.push_name(new.user_id), 'title', night.title, 'url', '/night/' || night.slug));
  end loop;
  return new;
end;
$$;
revoke execute on function public.push_on_rsvp() from public, anon, authenticated;

drop trigger if exists push_rsvp on public.rsvps;
create trigger push_rsvp
  after insert or update of answer on public.rsvps
  for each row execute function public.push_on_rsvp();

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('69_rsvp_push.sql', '2979cba607450c3b34c5072b421b570596c8212155ba082c72a43ff3d8a5848d');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('69_rsvp_push.sql');
  end if;
end $$;


-- ============================================================
--  A BLOCK REACHES EVERY READER; A DIRECT MESSAGE CAN BE REPORTED   (70_blocks_and_dm_reports.sql)
-- ============================================================

-- afterhours — a block reaches every reader, and a direct message can be reported (70)
--
-- A block (50) closed the card, the search, the waves, the groups and the messages, but
-- not the two oldest readers: beforehours comments (comments_public, 06/12) and the
-- room of a night (room_list, 19). The blocked person kept reading the other, and the
-- other kept reading them (F14, 20.10.2026). hidden_by_block() is the one filter both
-- readers use now; it answers false when nobody is signed in, so the site keeps reading
-- comments signed out, and it may be called by anyone (is_blocked itself stays closed
-- to anon).
--
-- And a direct message was the one kind of writing nobody could report (F8): dm_message
-- joins the report kinds — the author is found only by someone in that thread, the
-- staff see the words, and removing it deletes the line.

-- ------------------------------------------------------------ the block filter

create or replace function public.hidden_by_block(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and other is not null and exists (
    select 1 from public.blocks b
    where (b.blocker_id = auth.uid() and b.blocked_id = other)
       or (b.blocker_id = other and b.blocked_id = auth.uid()));
$$;
revoke execute on function public.hidden_by_block(uuid) from public;
grant execute on function public.hidden_by_block(uuid) to anon, authenticated;

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
where not c.is_hidden
  and not public.hidden_by_block(c.author_id);

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
  order by r.created_at;
$$;

-- ------------------------------------------------------------ reporting a message

alter table public.reports drop constraint if exists reports_kind_check;
alter table public.reports add constraint reports_kind_check
  check (kind in ('comment', 'room_post', 'group_message', 'profile', 'group', 'spark', 'post_comment', 'dm_message'));

-- Who wrote it, as the reporter may know it: only someone in the thread.
create or replace function public.report_author(p_kind text, p_target text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  a uuid;
begin
  if p_kind = 'comment' then
    select author_id into a from public.comments where id::text = p_target;
  elsif p_kind = 'room_post' then
    select user_id into a from public.room_posts where id::text = p_target;
  elsif p_kind = 'group_message' then
    select m.user_id into a from public.group_messages m
     where m.id::text = p_target and m.kind = 'say' and public.in_group(m.group_id);
  elsif p_kind = 'profile' then
    select id into a from public.profiles where id::text = p_target or handle = lower(p_target);
  elsif p_kind = 'group' then
    select g.created_by into a from public.groups g where g.id::text = p_target;
  elsif p_kind = 'spark' then
    select host_id into a from public.sparks where id::text = p_target;
  elsif p_kind = 'post_comment' and to_regclass('public.post_comments') is not null then
    execute 'select c.author_id from public.post_comments c join public.posts p on p.id = c.post_id
             where c.id::text = $1 and public.can_see_post(p.author_id)' into a using p_target;
  elsif p_kind = 'dm_message' then
    select m.user_id into a from public.dm_messages m
      join public.dm_threads t on t.id = m.thread_id
     where m.id::text = p_target and auth.uid() in (t.a, t.b) and m.user_id <> auth.uid();
  end if;
  return a;
end;
$$;

create or replace function public.report_author_any(p_kind text, p_target text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select case p_kind
    when 'comment'       then (select author_id from public.comments where id::text = p_target)
    when 'room_post'     then (select user_id from public.room_posts where id::text = p_target)
    when 'group_message' then (select user_id from public.group_messages where id::text = p_target)
    when 'profile'       then (select id from public.profiles where id::text = p_target)
    when 'group'         then (select created_by from public.groups where id::text = p_target)
    when 'spark'         then (select host_id from public.sparks where id::text = p_target)
    when 'post_comment'  then public.post_comment_author(p_target)
    when 'dm_message'    then (select user_id from public.dm_messages where id::text = p_target)
  end;
$$;
revoke all on function public.report_author_any(text, text) from public, anon, authenticated;

create or replace function public.staff_reports()
returns table (kind text, target text, preview text, author text, reports int, reasons text[], first_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  return query
    with open as (
      select r.kind, r.target, count(*)::int as n, array_remove(array_agg(r.reason order by r.created_at), null) as why, min(r.created_at) as first_at
      from public.reports r where not r.handled
      group by r.kind, r.target
    )
    select o.kind, o.target,
           case o.kind
             when 'comment'       then (select c.body from public.comments c where c.id::text = o.target)
             when 'room_post'     then (select x.body from public.room_posts x where x.id::text = o.target)
             when 'group_message' then (select x.body from public.group_messages x where x.id::text = o.target)
             when 'profile'       then (select concat_ws(' · ', p.display_name, p.bio, p.about) from public.profiles p where p.id::text = o.target)
             when 'group'         then (select g.name from public.groups g where g.id::text = o.target)
             when 'spark'         then (select concat_ws(' · ', s.title, s.place) from public.sparks s where s.id::text = o.target)
             when 'post_comment'  then public.post_comment_body(o.target)
             when 'dm_message'    then (select x.body from public.dm_messages x where x.id::text = o.target)
           end,
           (select coalesce(p.handle, p.display_name) from public.profiles p where p.id = public.report_author_any(o.kind, o.target)),
           o.n, o.why, o.first_at
    from open o
    order by o.n desc, o.first_at;
end;
$$;

-- As in 68, plus the message.
create or replace function public.staff_report_settle(p_kind text, p_target text, p_remove boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  who record;
begin
  perform public.need_staff();
  if coalesce(p_remove, false) then
    if p_kind = 'comment' then
      update public.comments set is_hidden = true where id::text = p_target;
    elsif p_kind = 'room_post' then
      delete from public.room_posts where id::text = p_target;
    elsif p_kind = 'group_message' then
      delete from public.group_messages where id::text = p_target;
    elsif p_kind = 'dm_message' then
      delete from public.dm_messages where id::text = p_target;
    elsif p_kind = 'spark' then
      delete from public.sparks where id::text = p_target;
    elsif p_kind = 'group' then
      delete from public.groups where id::text = p_target;
    elsif p_kind = 'post_comment' then
      execute 'update public.post_comments set is_hidden = true where id::text = $1' using p_target;
    elsif p_kind = 'profile' then
      update public.profiles set bio = null, about = null where id::text = p_target;
      delete from public.profile_links where user_id::text = p_target;
      delete from public.profile_photos where user_id::text = p_target;
    else
      raise exception 'which kind?';
    end if;
  end if;
  for who in select distinct r.reporter_id from public.reports r
             where r.kind = p_kind and r.target = p_target and not r.handled loop
    perform public.notice(who.reporter_id,
                          case when coalesce(p_remove, false) then 'report_removed' else 'report_kept' end,
                          jsonb_build_object('what', p_kind));
  end loop;
  update public.reports set handled = true where kind = p_kind and target = p_target and not handled;
  perform public.staff_note(case when coalesce(p_remove, false) then 'remove' else 'keep' end, 'report:' || p_kind, p_target, null);
end;
$$;

revoke execute on function public.staff_reports()                          from public, anon;
revoke execute on function public.staff_report_settle(text, text, boolean) from public, anon;
grant execute on function public.staff_reports()                           to authenticated;
grant execute on function public.staff_report_settle(text, text, boolean)  to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('70_blocks_and_dm_reports.sql', '674e630174dc3e2a9d58d21c9d1bfc612f9bfd8d999fc6bfeaf9a5cd98ed5bda');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('70_blocks_and_dm_reports.sql');
  end if;
end $$;


-- ============================================================
--  HEALTH SAYS WHEN THE SYNC LAST RAN AND WHETHER PUSHES ARE STUCK   (71_health_more.sql)
-- ============================================================

-- afterhours — the health check says when the sync last brought a night, and
-- whether the push outbox is stuck (71)
--
-- health() (09) counted rows; it could not say whether the morning sync still ran or
-- whether pushes were leaving. On 11.10.2026 nobody knew for a week that 680 past
-- nights sat on the deck (F34, 20.10.2026). Two more numbers, and tools/health.mjs
-- now goes red on them: a last synced night older than three days, more than fifty
-- past nights still published, pushes older than six hours still unsent.
-- The return type grows, so the function is dropped and made again with its grants.

drop function if exists public.health();
create or replace function public.health()
returns table (
  events            bigint,
  published         bigint,
  missing_venue     bigint,
  unverified_date   bigint,
  past_still_up     bigint,
  comments          bigint,
  hidden_comments   bigint,
  people            bigint,
  swipes            bigint,
  friendships       bigint,
  newest_synced     timestamptz,
  outbox_stuck      bigint
)
language sql
security definer
set search_path = public
as $$
  select
    (select count(*) from public.events),
    (select count(*) from public.events where is_published),
    (select count(*) from public.events where venue_id is null),
    (select count(*) from public.events where starts_at_estimated),
    (select count(*) from public.events
      where is_published and starts_at is not null
        and not starts_at_estimated and starts_at < now()),
    (select count(*) from public.comments),
    (select count(*) from public.comments where is_hidden),
    (select count(*) from public.profiles),
    (select count(*) from public.swipes),
    (select count(*) from public.friendships where status = 'accepted'),
    (select max(created_at) from public.events where source = 'ticketmaster'),
    (select count(*) from public.push_outbox
      where sent_at is null
        and greatest(created_at, coalesce(send_after, created_at)) < now() - interval '6 hours');
$$;
grant execute on function public.health() to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('71_health_more.sql', '8454b42f5a542d7fa6e981f35678d9dd0f029d4e79f77cb64ad099e93da0e904');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('71_health_more.sql');
  end if;
end $$;


-- ============================================================
--  A CHANGED OR CANCELLED NIGHT TELLS THE PEOPLE ON IT   (72_night_changed.sql)
-- ============================================================

-- afterhours — a changed or cancelled night tells the people on it (72)
--
-- Ticketmaster says when a night is cancelled, postponed or rescheduled
-- (dates.status.code) and the sync never read it; a person with a ticket, a keep or
-- an answer on it found out at the door (F22, 20.10.2026). Now events carries the
-- status the sync writes; a cancelled night leaves the deck (is_published = false)
-- but stays in collections and feeds; and the people on the night get one push:
-- {title} · cancelled / postponed / moved to {when}. The words are three fixed
-- phrases per language (58); the switch is notify_nights, like night_soon.
--
-- push_text() and push_wants() are those of 58 and 59 with the one kind added.

alter table public.events add column if not exists status text not null default 'onsale';
alter table public.events drop constraint if exists events_status_check;
alter table public.events add constraint events_status_check
  check (status in ('onsale', 'offsale', 'cancelled', 'postponed', 'rescheduled'));

alter table public.push_outbox drop constraint if exists push_outbox_kind_check;
alter table public.push_outbox add constraint push_outbox_kind_check check (kind in (
  'friend_request', 'friend_accepted', 'match', 'friend_live',
  'night_soon', 'room_open', 'room_closing', 'room_message', 'reply',
  'digest', 'dj_live', 'wave', 'spark', 'spark_in',
  'group_added', 'group_joined', 'group_match', 'group_round', 'group_won', 'group_plan',
  'group_message', 'group_live', 'group_ticket', 'post',
  'staff', 'post_like', 'post_comment',
  'dm', 'night_changed'));

create or replace function public.push_text(p_kind text, p_lang text, p_data jsonb)
returns table (title text, body text)
language plpgsql
immutable
as $$
declare
  pair record;
begin
  select x.title, x.body into title, body
  from (values
    ('friend_request',  'en', 'friend request',                '{name} wants to add you'),
    ('friend_request',  'de', 'freundschaftsanfrage',          '{name} möchte dich hinzufügen'),
    ('friend_request',  'tr', 'arkadaşlık isteği',             '{name} seni eklemek istiyor'),
    ('friend_accepted', 'en', 'you are friends now',           '{name} accepted your request'),
    ('friend_accepted', 'de', 'ihr seid jetzt freunde',        '{name} hat deine anfrage angenommen'),
    ('friend_accepted', 'tr', 'artık arkadaşsınız',            '{name} isteğini kabul etti'),
    ('match',           'en', '{name} is going too',           '{title}'),
    ('match',           'de', '{name} geht auch hin',          '{title}'),
    ('match',           'tr', '{name} de gidiyor',             '{title}'),
    ('friend_live',     'en', '{name} is out now',             '{title}'),
    ('friend_live',     'de', '{name} ist gerade unterwegs',   '{title}'),
    ('friend_live',     'tr', '{name} şu an dışarıda',         '{title}'),
    ('night_soon',      'en', 'tonight · {time}',              '{title}'),
    ('night_soon',      'de', 'heute nacht · {time}',          '{title}'),
    ('night_soon',      'tr', 'bu gece · {time}',              '{title}'),
    ('room_open',       'en', 'your room is open',             '{title} · 48 hours to write'),
    ('room_open',       'de', 'dein raum ist offen',           '{title} · 48 stunden zum schreiben'),
    ('room_open',       'tr', 'odan açık',                     '{title} · 48 saat yazabilirsin'),
    ('room_closing',    'en', 'your room closes soon',         '{title} · the last two hours'),
    ('room_closing',    'de', 'dein raum schließt bald',       '{title} · die letzten zwei stunden'),
    ('room_closing',    'tr', 'odan birazdan kapanıyor',       '{title} · son iki saat'),
    ('room_message',    'en', '{name} in {title}',             'a new line in your room'),
    ('room_message',    'de', '{name} in {title}',             'eine neue zeile in deinem raum'),
    ('room_message',    'tr', '{title} · {name}',              'odanda yeni bir satır'),
    ('reply',           'en', '{name} replied',                'a new reply'),
    ('reply',           'de', '{name} hat geantwortet',        'eine neue antwort'),
    ('reply',           'tr', '{name} cevap verdi',            'yeni bir cevap'),
    ('digest',          'en', 'this weekend in {city}',        '{n} nights · {friends} kept by friends'),
    ('digest',          'de', 'dieses wochenende in {city}',   '{n} nächte · {friends} von freunden behalten'),
    ('digest',          'tr', 'bu hafta sonu {city}',          '{n} gece · {friends} tanesini arkadaşların sakladı'),
    ('dj_live',         'en', '{name} plays soon',             '{where} · {time}'),
    ('dj_live',         'de', '{name} legt bald auf',          '{where} · {time}'),
    ('dj_live',         'tr', '{name} birazdan çalıyor',       '{where} · {time}'),
    ('wave',            'en', '2nd wave',                      'a friend of {via} kept {title}'),
    ('wave',            'de', '2. welle',                      'ein freund von {via} hat {title} behalten'),
    ('wave',            'tr', '2. dalga',                      '{via} üzerinden biri {title} gecesini sakladı'),
    ('spark',           'en', '{name} is starting something',  '{title} · {when}'),
    ('spark',           'de', '{name} startet etwas',          '{title} · {when}'),
    ('spark',           'tr', '{name} bir şey başlatıyor',     '{title} · {when}'),
    ('spark_in',        'en', '{name} is in',                  '{title}'),
    ('spark_in',        'de', '{name} ist dabei',              '{title}'),
    ('spark_in',        'tr', '{name} geliyor',                '{title}'),
    ('group_added',     'en', 'you are in {group}',            '{name} added you · swipe nights together'),
    ('group_added',     'de', 'du bist in {group}',            '{name} hat dich hinzugefügt · wischt zusammen'),
    ('group_added',     'tr', '{group} grubundasın',           '{name} seni ekledi · birlikte gece seçin'),
    ('group_joined',    'en', '{group}',                       '{name} joined'),
    ('group_joined',    'de', '{group}',                       '{name} ist dazugekommen'),
    ('group_joined',    'tr', '{group}',                       '{name} gruba katıldı'),
    ('group_match',     'en', '{group} · everyone is in',      '{title}'),
    ('group_match',     'de', '{group} · alle sind dabei',     '{title}'),
    ('group_match',     'tr', '{group} · herkes var',          '{title}'),
    ('group_round',     'en', '{group} · vote',                '{name} put {title} to a vote'),
    ('group_round',     'de', '{group} · abstimmung',          '{name} lässt abstimmen: {title}'),
    ('group_round',     'tr', '{group} · oylama',              '{name} oylamaya sundu: {title}'),
    ('group_won',       'en', '{group} · the vote is in',      '{title}'),
    ('group_won',       'de', '{group} · abgestimmt',          '{title}'),
    ('group_won',       'tr', '{group} · oylama bitti',        '{title}'),
    ('group_plan',      'en', '{group} · the plan',            '{name}: {title}'),
    ('group_plan',      'de', '{group} · der plan',            '{name}: {title}'),
    ('group_plan',      'tr', '{group} · plan',                '{name}: {title}'),
    ('group_message',   'en', '{group} · {name}',              'a new message'),
    ('group_message',   'de', '{group} · {name}',              'eine neue nachricht'),
    ('group_message',   'tr', '{group} · {name}',              'yeni bir mesaj'),
    ('group_live',      'en', '{group} · live now',            '{name} wants to swipe together, now'),
    ('group_live',      'de', '{group} · gerade live',         '{name} will jetzt zusammen wischen'),
    ('group_live',      'tr', '{group} · şimdi canlı',         '{name} şimdi birlikte kaydırmak istiyor'),
    ('group_ticket',    'en', '{group} · tomorrow',            'you are in for {title} but have no ticket yet'),
    ('group_ticket',    'de', '{group} · morgen',              'du bist bei {title} dabei, hast aber noch kein ticket'),
    ('group_ticket',    'tr', '{group} · yarın',               '{title} için geliyorsun ama henüz biletin yok'),
    ('post',            'en', '{name} posted',                 'a new post'),
    ('post',            'de', '{name} hat gepostet',           'ein neuer post'),
    ('post',            'tr', '{name} paylaştı',               'yeni bir gönderi'),
    ('post_like',       'en', '{name} likes your post',        'open yours to see it'),
    ('post_like',       'de', '{name} gefällt dein post',      'in yours ansehen'),
    ('post_like',       'tr', '{name} gönderini beğendi',      'yours sekmesinde'),
    ('post_comment',    'en', '{name} commented',              'a new comment'),
    ('post_comment',    'de', '{name} hat kommentiert',        'ein neuer kommentar'),
    ('post_comment',    'tr', '{name} yorum yaptı',            'yeni bir yorum'),
    -- 59_dms.sql: a direct message; the name, never the words
    ('dm',              'en', '{name}',                        'a new message'),
    ('dm',              'de', '{name}',                        'eine neue nachricht'),
    ('dm',              'tr', '{name}',                        'yeni bir mesaj'),
    ('staff',           'en', 'the panel',                     '{n} waiting: reports, nights sent in, dj pages'),
    ('staff',           'de', 'das panel',                     '{n} warten: meldungen, eingesandte nächte, dj-seiten'),
    ('staff',           'tr', 'panel',                         '{n} iş bekliyor: şikayetler, gönderilen geceler, dj sayfaları'),
    -- 72_night_changed.sql: a night you kept, answered or hold a ticket for
    ('night_changed',   'en', '{title}',                       '{what}'),
    ('night_changed',   'de', '{title}',                       '{what}'),
    ('night_changed',   'tr', '{title}',                       '{what}')
  ) as x(kind, lang, title, body)
  where x.kind = p_kind and x.lang = coalesce(nullif(p_lang, ''), 'en');

  -- The words of a member never reach a lock screen (the decision of owner, 11.10.2026): what the
  -- triggers still pass as text is dropped here, whatever the caller.
  for pair in select * from jsonb_each_text(coalesce(p_data, '{}') - 'text') loop
    title := replace(title, '{' || pair.key || '}', coalesce(pair.value, ''));
    body  := replace(body,  '{' || pair.key || '}', coalesce(pair.value, ''));
  end loop;
  return next;
end;
$$;

create or replace function public.push_wants(p_user uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select case
             when p_kind = 'friend_request'  then s.notify_requests
             when p_kind = 'friend_accepted' then s.notify_accepts
             when p_kind = 'match'           then s.notify_matches
             when p_kind = 'friend_live'     then s.notify_live
             when p_kind in ('night_soon', 'night_changed') then s.notify_nights
             when p_kind in ('room_open', 'room_closing', 'room_message') then s.notify_rooms
             when p_kind = 'reply'           then s.notify_replies
             when p_kind = 'digest'          then s.notify_digest
             when p_kind = 'dj_live'         then s.notify_djs
             when p_kind = 'wave'            then s.notify_waves
             when p_kind in ('spark', 'spark_in') then s.notify_sparks
             when p_kind like 'group\_%' then s.notify_groups
             when p_kind in ('post', 'post_like', 'post_comment') then s.notify_posts
             when p_kind = 'dm'              then s.notify_dms
           end
    from public.profile_settings s where s.user_id = p_user), true);
$$;

-- The three phrases, in the language of the one who receives the push.
create or replace function public.night_change_words(p_what text, p_lang text, p_when text)
returns text
language sql
immutable
as $$
  select case coalesce(nullif(p_lang, ''), 'en')
    when 'de' then case p_what when 'cancelled' then 'abgesagt' when 'postponed' then 'verschoben, neues datum folgt' else 'verlegt auf ' || p_when end
    when 'tr' then case p_what when 'cancelled' then 'iptal edildi' when 'postponed' then 'ertelendi, yeni tarih bekleniyor' else p_when || ' tarihine alındı' end
    else case p_what when 'cancelled' then 'cancelled' when 'postponed' then 'postponed, new date to come' else 'moved to ' || p_when end
  end;
$$;

-- Who is on a night: kept it, answered in, or got a ticket.
create or replace function public.push_on_night_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  what text;
  them record;
begin
  if new.status in ('cancelled', 'postponed') and old.status is distinct from new.status then
    what := new.status;
  elsif new.starts_at is distinct from old.starts_at and not new.starts_at_estimated
        and old.starts_at is not null and new.starts_at is not null
        and new.starts_at > now() then
    what := 'moved';
  else
    return new;
  end if;
  for them in
    select distinct u.user_id from (
      select w.user_id from public.swipes w where w.event_id = new.id and w.direction = 'right'
      union select r.user_id from public.rsvps r where r.event_id = new.id and r.answer = 'in'
      union select t.user_id from public.tickets t where t.event_id = new.id and t.answer = 'got'
    ) u
  loop
    perform public.push_enqueue(them.user_id, 'night_changed',
      format('night_changed:%s:%s:%s:%s', them.user_id, new.id, what, to_char(new.starts_at, 'YYYY-MM-DD-HH24MI')),
      jsonb_build_object(
        'title', new.title,
        'what',  public.night_change_words(what, (select coalesce(nullif(s.locale, ''), 'en') from public.profile_settings s where s.user_id = them.user_id), public.push_when(them.user_id, new.starts_at)),
        'url',   '/night/' || new.slug));
  end loop;
  return new;
end;
$$;
revoke execute on function public.push_on_night_change() from public, anon, authenticated;

drop trigger if exists push_night_change on public.events;
create trigger push_night_change
  after update of status, starts_at on public.events
  for each row execute function public.push_on_night_change();

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('72_night_changed.sql', '2f0213a3c58fb78ba0811d26a5a5d0b47ebce9fd9ccdac4b17613e9c5821bb7a');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('72_night_changed.sql');
  end if;
end $$;


-- ============================================================
--  THE MESSAGES OF A DELETED ACCOUNT GO WITH IT   (73_messages_go.sql)
-- ============================================================

-- afterhours — the messages of a deleted account go with it (73)
--
-- A comment on a night stays as someone (12): it is part of the night. A line in a
-- room or a group chat is not; it is the person talking, and the owner decided on
-- 20.10.2026 (F32) that it goes when the account goes. room_posts kept the line with
-- user_id null; group_messages cascaded already. delete_account() is that of 65 with
-- the room lines removed first.

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

  delete from auth.users where id = me;
end;
$$;
grant execute on function public.delete_account() to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('73_messages_go.sql', '8403802a781af964daf6be7c4ae1896aafcd02abee3078a7288039d4b0df63ea');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('73_messages_go.sql');
  end if;
end $$;


-- ============================================================
--  A BAN STAYS — THE ADDRESS COMES BACK BANNED, THE HANDLE STAYS TAKEN   (74_ban_stays.sql)
-- ============================================================

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


-- ============================================================
--  A SPARK TAKEN BACK TELLS THE PEOPLE WHO SAID IN   (75_spark_off.sql)
-- ============================================================

-- afterhours — a spark taken back tells the people who said in (75)
--
-- spark_cancel (27) deleted the spark and the ones who had said in walked into
-- nothing (F23, 20.10.2026). Now, before it goes, each of them gets one push:
-- {name} took it back · {title}, on the sparks switch. The words come from 58 via
-- 72, with the one kind added; push_wants likewise.

alter table public.push_outbox drop constraint if exists push_outbox_kind_check;
alter table public.push_outbox add constraint push_outbox_kind_check check (kind in (
  'friend_request', 'friend_accepted', 'match', 'friend_live',
  'night_soon', 'room_open', 'room_closing', 'room_message', 'reply',
  'digest', 'dj_live', 'wave', 'spark', 'spark_in',
  'group_added', 'group_joined', 'group_match', 'group_round', 'group_won', 'group_plan',
  'group_message', 'group_live', 'group_ticket', 'post',
  'staff', 'post_like', 'post_comment',
  'dm', 'night_changed', 'spark_off'));

create or replace function public.push_text(p_kind text, p_lang text, p_data jsonb)
returns table (title text, body text)
language plpgsql
immutable
as $$
declare
  pair record;
begin
  select x.title, x.body into title, body
  from (values
    ('friend_request',  'en', 'friend request',                '{name} wants to add you'),
    ('friend_request',  'de', 'freundschaftsanfrage',          '{name} möchte dich hinzufügen'),
    ('friend_request',  'tr', 'arkadaşlık isteği',             '{name} seni eklemek istiyor'),
    ('friend_accepted', 'en', 'you are friends now',           '{name} accepted your request'),
    ('friend_accepted', 'de', 'ihr seid jetzt freunde',        '{name} hat deine anfrage angenommen'),
    ('friend_accepted', 'tr', 'artık arkadaşsınız',            '{name} isteğini kabul etti'),
    ('match',           'en', '{name} is going too',           '{title}'),
    ('match',           'de', '{name} geht auch hin',          '{title}'),
    ('match',           'tr', '{name} de gidiyor',             '{title}'),
    ('friend_live',     'en', '{name} is out now',             '{title}'),
    ('friend_live',     'de', '{name} ist gerade unterwegs',   '{title}'),
    ('friend_live',     'tr', '{name} şu an dışarıda',         '{title}'),
    ('night_soon',      'en', 'tonight · {time}',              '{title}'),
    ('night_soon',      'de', 'heute nacht · {time}',          '{title}'),
    ('night_soon',      'tr', 'bu gece · {time}',              '{title}'),
    ('room_open',       'en', 'your room is open',             '{title} · 48 hours to write'),
    ('room_open',       'de', 'dein raum ist offen',           '{title} · 48 stunden zum schreiben'),
    ('room_open',       'tr', 'odan açık',                     '{title} · 48 saat yazabilirsin'),
    ('room_closing',    'en', 'your room closes soon',         '{title} · the last two hours'),
    ('room_closing',    'de', 'dein raum schließt bald',       '{title} · die letzten zwei stunden'),
    ('room_closing',    'tr', 'odan birazdan kapanıyor',       '{title} · son iki saat'),
    ('room_message',    'en', '{name} in {title}',             'a new line in your room'),
    ('room_message',    'de', '{name} in {title}',             'eine neue zeile in deinem raum'),
    ('room_message',    'tr', '{title} · {name}',              'odanda yeni bir satır'),
    ('reply',           'en', '{name} replied',                'a new reply'),
    ('reply',           'de', '{name} hat geantwortet',        'eine neue antwort'),
    ('reply',           'tr', '{name} cevap verdi',            'yeni bir cevap'),
    ('digest',          'en', 'this weekend in {city}',        '{n} nights · {friends} kept by friends'),
    ('digest',          'de', 'dieses wochenende in {city}',   '{n} nächte · {friends} von freunden behalten'),
    ('digest',          'tr', 'bu hafta sonu {city}',          '{n} gece · {friends} tanesini arkadaşların sakladı'),
    ('dj_live',         'en', '{name} plays soon',             '{where} · {time}'),
    ('dj_live',         'de', '{name} legt bald auf',          '{where} · {time}'),
    ('dj_live',         'tr', '{name} birazdan çalıyor',       '{where} · {time}'),
    ('wave',            'en', '2nd wave',                      'a friend of {via} kept {title}'),
    ('wave',            'de', '2. welle',                      'ein freund von {via} hat {title} behalten'),
    ('wave',            'tr', '2. dalga',                      '{via} üzerinden biri {title} gecesini sakladı'),
    ('spark',           'en', '{name} is starting something',  '{title} · {when}'),
    ('spark',           'de', '{name} startet etwas',          '{title} · {when}'),
    ('spark',           'tr', '{name} bir şey başlatıyor',     '{title} · {when}'),
    ('spark_in',        'en', '{name} is in',                  '{title}'),
    ('spark_in',        'de', '{name} ist dabei',              '{title}'),
    ('spark_in',        'tr', '{name} geliyor',                '{title}'),
    ('group_added',     'en', 'you are in {group}',            '{name} added you · swipe nights together'),
    ('group_added',     'de', 'du bist in {group}',            '{name} hat dich hinzugefügt · wischt zusammen'),
    ('group_added',     'tr', '{group} grubundasın',           '{name} seni ekledi · birlikte gece seçin'),
    ('group_joined',    'en', '{group}',                       '{name} joined'),
    ('group_joined',    'de', '{group}',                       '{name} ist dazugekommen'),
    ('group_joined',    'tr', '{group}',                       '{name} gruba katıldı'),
    ('group_match',     'en', '{group} · everyone is in',      '{title}'),
    ('group_match',     'de', '{group} · alle sind dabei',     '{title}'),
    ('group_match',     'tr', '{group} · herkes var',          '{title}'),
    ('group_round',     'en', '{group} · vote',                '{name} put {title} to a vote'),
    ('group_round',     'de', '{group} · abstimmung',          '{name} lässt abstimmen: {title}'),
    ('group_round',     'tr', '{group} · oylama',              '{name} oylamaya sundu: {title}'),
    ('group_won',       'en', '{group} · the vote is in',      '{title}'),
    ('group_won',       'de', '{group} · abgestimmt',          '{title}'),
    ('group_won',       'tr', '{group} · oylama bitti',        '{title}'),
    ('group_plan',      'en', '{group} · the plan',            '{name}: {title}'),
    ('group_plan',      'de', '{group} · der plan',            '{name}: {title}'),
    ('group_plan',      'tr', '{group} · plan',                '{name}: {title}'),
    ('group_message',   'en', '{group} · {name}',              'a new message'),
    ('group_message',   'de', '{group} · {name}',              'eine neue nachricht'),
    ('group_message',   'tr', '{group} · {name}',              'yeni bir mesaj'),
    ('group_live',      'en', '{group} · live now',            '{name} wants to swipe together, now'),
    ('group_live',      'de', '{group} · gerade live',         '{name} will jetzt zusammen wischen'),
    ('group_live',      'tr', '{group} · şimdi canlı',         '{name} şimdi birlikte kaydırmak istiyor'),
    ('group_ticket',    'en', '{group} · tomorrow',            'you are in for {title} but have no ticket yet'),
    ('group_ticket',    'de', '{group} · morgen',              'du bist bei {title} dabei, hast aber noch kein ticket'),
    ('group_ticket',    'tr', '{group} · yarın',               '{title} için geliyorsun ama henüz biletin yok'),
    ('post',            'en', '{name} posted',                 'a new post'),
    ('post',            'de', '{name} hat gepostet',           'ein neuer post'),
    ('post',            'tr', '{name} paylaştı',               'yeni bir gönderi'),
    ('post_like',       'en', '{name} likes your post',        'open yours to see it'),
    ('post_like',       'de', '{name} gefällt dein post',      'in yours ansehen'),
    ('post_like',       'tr', '{name} gönderini beğendi',      'yours sekmesinde'),
    ('post_comment',    'en', '{name} commented',              'a new comment'),
    ('post_comment',    'de', '{name} hat kommentiert',        'ein neuer kommentar'),
    ('post_comment',    'tr', '{name} yorum yaptı',            'yeni bir yorum'),
    -- 59_dms.sql: a direct message; the name, never the words
    ('dm',              'en', '{name}',                        'a new message'),
    ('dm',              'de', '{name}',                        'eine neue nachricht'),
    ('dm',              'tr', '{name}',                        'yeni bir mesaj'),
    ('staff',           'en', 'the panel',                     '{n} waiting: reports, nights sent in, dj pages'),
    ('staff',           'de', 'das panel',                     '{n} warten: meldungen, eingesandte nächte, dj-seiten'),
    ('staff',           'tr', 'panel',                         '{n} iş bekliyor: şikayetler, gönderilen geceler, dj sayfaları'),
    -- 72_night_changed.sql: a night you kept, answered or hold a ticket for
    ('night_changed',   'en', '{title}',                       '{what}'),
    ('night_changed',   'de', '{title}',                       '{what}'),
    ('night_changed',   'tr', '{title}',                       '{what}'),
    -- 75_spark_off.sql: a spark you said in to was taken back by its host
    ('spark_off',       'en', '{name} took it back',            '{title}'),
    ('spark_off',       'de', '{name} hat es abgesagt',         '{title}'),
    ('spark_off',       'tr', '{name} iptal etti',              '{title}')
  ) as x(kind, lang, title, body)
  where x.kind = p_kind and x.lang = coalesce(nullif(p_lang, ''), 'en');

  -- The words of a member never reach a lock screen (the decision of owner, 11.10.2026): what the
  -- triggers still pass as text is dropped here, whatever the caller.
  for pair in select * from jsonb_each_text(coalesce(p_data, '{}') - 'text') loop
    title := replace(title, '{' || pair.key || '}', coalesce(pair.value, ''));
    body  := replace(body,  '{' || pair.key || '}', coalesce(pair.value, ''));
  end loop;
  return next;
end;
$$;

create or replace function public.push_wants(p_user uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select case
             when p_kind = 'friend_request'  then s.notify_requests
             when p_kind = 'friend_accepted' then s.notify_accepts
             when p_kind = 'match'           then s.notify_matches
             when p_kind = 'friend_live'     then s.notify_live
             when p_kind in ('night_soon', 'night_changed') then s.notify_nights
             when p_kind in ('room_open', 'room_closing', 'room_message') then s.notify_rooms
             when p_kind = 'reply'           then s.notify_replies
             when p_kind = 'digest'          then s.notify_digest
             when p_kind = 'dj_live'         then s.notify_djs
             when p_kind = 'wave'            then s.notify_waves
             when p_kind in ('spark', 'spark_in', 'spark_off') then s.notify_sparks
             when p_kind like 'group\_%' then s.notify_groups
             when p_kind in ('post', 'post_like', 'post_comment') then s.notify_posts
             when p_kind = 'dm'              then s.notify_dms
           end
    from public.profile_settings s where s.user_id = p_user), true);
$$;

create or replace function public.spark_cancel(p_spark uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  s    public.sparks%rowtype;
  them record;
begin
  select * into s from public.sparks where id = p_spark and host_id = auth.uid();
  if s.id is null then
    raise exception 'not yours' using errcode = '42501';
  end if;
  for them in select i.user_id from public.spark_invites i where i.spark_id = s.id and i.answer = 'in' loop
    perform public.push_enqueue(them.user_id, 'spark_off',
      format('spark_off:%s:%s', s.id, them.user_id),
      jsonb_build_object('name', public.push_name(s.host_id), 'title', s.title, 'url', '/connect'));
  end loop;
  delete from public.sparks where id = s.id;
end;
$$;
revoke execute on function public.spark_cancel(uuid) from public, anon;
grant execute on function public.spark_cancel(uuid)  to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('75_spark_off.sql', 'fe74781c189f738a245bb740adb7e31b872f355d7b50cbec940c32acabf97960');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('75_spark_off.sql');
  end if;
end $$;


-- ============================================================
--  A NIGHT SENT IN — THE SENDER HEARS, CAN TAKE IT BACK; STALE ONES LEAVE THE QUEUE   (76_sent_nights.sql)
-- ============================================================

-- afterhours — a night sent in: the sender hears, can take it back, and the stale
-- ones leave the queue (76)
--
-- Someone sent a night in (43) and then nothing: no word when the staff let it through
-- or turned it down, no way to take it back, and a night whose date had passed sat in
-- the queue forever, counting against the five a person may have waiting (F24,
-- 20.10.2026). Three things:
--   staff_review     the same as 43, plus a notice to the sender: night_ok / night_no
--                    (with the note the staff wrote, if any)
--   event_withdraw   the sender takes a waiting night back
--   submissions_expire  a waiting night whose date has passed is turned down with the
--                    note "the date passed"; the staff queue runs it first, so it
--                    never needs a clock job, and the five-limit counts only the live ones

alter table public.notices drop constraint if exists notices_kind_check;
alter table public.notices add constraint notices_kind_check
  check (kind in ('comment_hidden', 'post_hidden', 'removed', 'profile_cleared',
                  'role', 'dj_verified', 'dj_hidden', 'report_removed', 'report_kept',
                  'night_ok', 'night_no'));

create or replace function public.staff_review(p_id uuid, p_ok boolean, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.events%rowtype;
begin
  perform public.need_staff();
  select * into e from public.events where id = p_id and review = 'pending';
  if e.id is null then raise exception 'nothing waiting with that id'; end if;
  if p_ok then
    update public.events set review = null, review_note = null, is_published = true, updated_at = now() where id = p_id;
  else
    update public.events set review = 'rejected', review_note = left(nullif(btrim(p_note), ''), 300), is_published = false, updated_at = now() where id = p_id;
  end if;
  perform public.notice(e.created_by, case when p_ok then 'night_ok' else 'night_no' end,
                        jsonb_build_object('title', e.title, 'slug', e.slug,
                                           'note', coalesce(left(nullif(btrim(p_note), ''), 300), '')));
  perform public.staff_note(case when p_ok then 'approve' else 'reject' end, 'night', e.slug, e.title);
end;
$$;

-- The sender takes a waiting night back. Only theirs, only while it waits.
create or replace function public.event_withdraw(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.events
   where id = p_id and created_by = auth.uid() and source = 'user' and review = 'pending';
  if not found then
    raise exception 'nothing of yours waiting with that id' using errcode = '42501';
  end if;
end;
$$;
revoke execute on function public.event_withdraw(uuid) from public, anon;
grant execute on function public.event_withdraw(uuid) to authenticated;

-- A waiting night whose date has passed: turned down, with a note, and the sender told.
create or replace function public.submissions_expire()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  e record;
  n int := 0;
begin
  for e in select id, created_by, title, slug from public.events
           where review = 'pending' and starts_at is not null and starts_at < now() loop
    update public.events set review = 'rejected', review_note = 'the date passed', is_published = false, updated_at = now()
     where id = e.id;
    perform public.notice(e.created_by, 'night_no', jsonb_build_object('title', e.title, 'slug', e.slug, 'note', 'the date passed'));
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function public.submissions_expire() from public, anon, authenticated;

-- The staff queue, with the stale ones cleared first. The return type is that of 43.
create or replace function public.staff_pending()
returns table (id uuid, slug text, title text, city_slug text, type_slug text, venue_name text,
               starts_at timestamptz, body text, ticket_url text, image_url text, maker text, handle text, sent_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_staff() then
    perform public.submissions_expire();
  end if;
  return query
    select e.id, e.slug, e.title, c.slug, t.slug, v.name, e.starts_at, e.body, e.ticket_url, e.image_url,
           p.display_name, p.handle, e.created_at
    from public.events e
    join public.cities c on c.id = e.city_id
    join public.event_types t on t.id = e.type_id
    left join public.venues v on v.id = e.venue_id
    left join public.profiles p on p.id = e.created_by
    where e.review = 'pending' and public.is_staff()
    order by e.created_at;
end;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('76_sent_nights.sql', '6083e440d0d3933f27cc25255c38e079b8d251c5e3994c4741ba85b8eeccb3e8');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('76_sent_nights.sql');
  end if;
end $$;


-- ============================================================
--  SOME NAMES BELONG TO NOBODY — ADMIN, AFTERHOURS, SUPPORT   (77_reserved_handles.sql)
-- ============================================================

-- afterhours — some names belong to nobody (77)
--
-- Anyone could take @admin, @afterhours or @support and write to people as the team
-- (F15, 20.10.2026). A short list of reserved words, and anything that starts with
-- afterhours, is now taken for everyone who is not staff: handle_status says so on
-- every keystroke, handle_new_user drops the wish at sign-up, and profile_setup (12)
-- goes through handle_status and so refuses it too. The staff keep the right to use
-- them (the panel accounts). Both functions are those of 74 / 12 with the one check.

create or replace function public.handle_reserved(p_handle text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not coalesce(public.is_staff(), false)
     and (p_handle in ('admin', 'administrator', 'afterhours', 'support', 'help', 'staff', 'team',
                       'moderator', 'mod', 'official', 'security', 'root', 'system', 'info', 'contact',
                       'ticketmaster', 'supabase', 'apple', 'google', 'null', 'undefined', 'someone')
          or p_handle like 'afterhours%'
          or p_handle like 'admin\_%'
          or p_handle like 'support\_%');
$$;
grant execute on function public.handle_reserved(text) to anon, authenticated;

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
    when public.handle_reserved(lower(btrim(p_handle))) then 'taken'
    when exists (select 1 from public.profiles
                 where handle = lower(btrim(p_handle)) and id = auth.uid()) then 'yours'
    when exists (select 1 from public.profiles
                 where handle = lower(btrim(p_handle))) then 'taken'
    when exists (select 1 from public.banned_marks
                 where handle = lower(btrim(p_handle))) then 'taken'
    else 'ok'
  end;
$$;

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
     or public.handle_reserved(wanted)
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

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('77_reserved_handles.sql', 'fa5b62cfc06e366950440065eed78c7d055bf325bc82226489865c81cae07c2e');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('77_reserved_handles.sql');
  end if;
end $$;


-- ============================================================
--  THE OLDEST APP THAT STILL WORKS   (78_min_version.sql)
-- ============================================================

-- afterhours — the oldest app that still works (78)
--
-- The numbered files drop and remake functions; an app built before such a change
-- keeps calling the old shape and fails in silence (F10, 20.10.2026). The server now
-- carries the oldest version it still answers: min_app_version() is read at every
-- launch, and an app below it shows a full-screen door to the download page
-- (components/UpdateGate.tsx) instead of a broken deck. One row, set by an admin
-- through set_min_app_version; nothing else writes it. version_lt compares two
-- dotted numbers the way people mean them (1.2.0 is below 1.10.0).

create table if not exists public.app_floor (
  one         boolean primary key default true check (one),
  min_version text not null default '0.1.0' check (min_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  note        text,
  set_at      timestamptz not null default now()
);
insert into public.app_floor (one) values (true) on conflict do nothing;

alter table public.app_floor enable row level security;
revoke all on public.app_floor from public, anon, authenticated;

create or replace function public.version_lt(a text, b text)
returns boolean
language sql
immutable
as $$
  select string_to_array(a, '.')::int[] < string_to_array(b, '.')::int[];
$$;
grant execute on function public.version_lt(text, text) to anon, authenticated;

create or replace function public.min_app_version()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select f.min_version from public.app_floor f where f.one;
$$;
grant execute on function public.min_app_version() to anon, authenticated;

create or replace function public.set_min_app_version(p_version text, p_note text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(public.is_admin(), false) then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if p_version !~ '^[0-9]+\.[0-9]+\.[0-9]+$' then
    raise exception 'a version looks like 1.2.3' using errcode = '22023';
  end if;
  update public.app_floor set min_version = p_version, note = p_note, set_at = now() where one;
  return p_version;
end;
$$;
grant execute on function public.set_min_app_version(text, text) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('78_min_version.sql', '1670ac287ac7ff389e9ca9c123caea56b59dd1a669dbb207ca7fc380a23ef97f');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('78_min_version.sql');
  end if;
end $$;


-- ============================================================
--  WORDS THE STAFF WANT TO SEE — WATCHED, NOT REFUSED   (79_word_watch.sql)
-- ============================================================

-- afterhours — words the staff want to see (79)
--
-- Nothing looked at what people wrote until someone reported it (F21, 20.10.2026;
-- Apple 1.2 asks for a filtering method). Decided: watch, do not refuse. A short
-- three-language list of words lives in watch_words; whenever a comment, a post, a
-- room line, a group message, a DM, a group name, a spark or a profile is written or
-- edited and holds one of them, it lands in the open reports as if its own author had
-- reported it, reason "filter: <word>". It stays visible; the staff decide in the
-- panel as with any report. The list grows and shrinks by admin calls.
--
--   watch_hit(text)                the first watched word in it, or null
--   watch_add(word) / watch_drop   admin
--   watch_list()                   staff

create table if not exists public.watch_words (
  word      text primary key check (word = lower(btrim(word)) and length(word) between 2 and 40),
  added_at  timestamptz not null default now()
);
alter table public.watch_words enable row level security;
revoke all on public.watch_words from public, anon, authenticated;

insert into public.watch_words (word) values
  ('nigger'), ('nigga'), ('faggot'), ('fag'), ('retard'), ('kike'), ('spic'), ('chink'), ('tranny'), ('whore'), ('slut'), ('cunt'), ('rape'), ('kill yourself'), ('kys'),
  ('kanake'), ('kanacke'), ('neger'), ('schwuchtel'), ('fotze'), ('hure'), ('schlampe'), ('judensau'), ('bring dich um'),
  ('orospu'), ('ibne'), ('pezevenk'), ('amcık'), ('amcik'), ('siktir'), ('sikerim'), ('göt'), ('piç'), ('pic kurusu'), ('geber'), ('kendini öldür')
on conflict do nothing;

create or replace function public.watch_hit(p_text text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select w.word from public.watch_words w
  where p_text is not null
    and lower(p_text) ~ ('(^|[^[:alnum:]])' || regexp_replace(w.word, '([.*+?^${}()|\[\]\\])', '\\\1', 'g') || '($|[^[:alnum:]])')
  order by length(w.word) desc
  limit 1;
$$;
grant execute on function public.watch_hit(text) to authenticated;

create or replace function public.watch_add(p_word text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(public.is_admin(), false) then raise exception 'admin only' using errcode = '42501'; end if;
  insert into public.watch_words (word) values (lower(btrim(p_word))) on conflict do nothing;
end;
$$;
create or replace function public.watch_drop(p_word text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(public.is_admin(), false) then raise exception 'admin only' using errcode = '42501'; end if;
  delete from public.watch_words where word = lower(btrim(p_word));
end;
$$;
create or replace function public.watch_list()
returns setof text
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  return query select w.word from public.watch_words w order by w.word;
end;
$$;
grant execute on function public.watch_add(text), public.watch_drop(text), public.watch_list() to authenticated;

-- One trigger body for every table: args are the report kind, the author column,
-- then the text columns. A post goes to post_reports, everything else to reports.
create or replace function public.watch_ugc()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  j     jsonb := to_jsonb(new);
  body  text := '';
  i     int;
  hit   text;
  who   uuid;
begin
  for i in 2 .. tg_nargs - 1 loop
    body := body || ' ' || coalesce(j ->> tg_argv[i], '');
  end loop;
  hit := public.watch_hit(body);
  if hit is null then return new; end if;
  who := (j ->> tg_argv[1])::uuid;
  if tg_argv[0] = 'post' then
    insert into public.post_reports (post_id, reporter_id, reason) values (new.id, who, 'filter: ' || hit)
    on conflict do nothing;
  else
    insert into public.reports (reporter_id, kind, target, reason) values (who, tg_argv[0], new.id::text, 'filter: ' || hit)
    on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists watch_comments       on public.comments;
drop trigger if exists watch_post_comments  on public.post_comments;
drop trigger if exists watch_room_posts     on public.room_posts;
drop trigger if exists watch_group_messages on public.group_messages;
drop trigger if exists watch_dm_messages    on public.dm_messages;
drop trigger if exists watch_groups         on public.groups;
drop trigger if exists watch_sparks         on public.sparks;
drop trigger if exists watch_posts          on public.posts;
drop trigger if exists watch_profiles       on public.profiles;
create trigger watch_comments       after insert or update of body  on public.comments       for each row execute function public.watch_ugc('comment', 'author_id', 'body');
create trigger watch_post_comments  after insert or update of body  on public.post_comments  for each row execute function public.watch_ugc('post_comment', 'author_id', 'body');
create trigger watch_room_posts     after insert or update of body  on public.room_posts     for each row execute function public.watch_ugc('room_post', 'user_id', 'body');
create trigger watch_group_messages after insert or update of body  on public.group_messages for each row execute function public.watch_ugc('group_message', 'user_id', 'body');
create trigger watch_dm_messages    after insert or update of body  on public.dm_messages    for each row execute function public.watch_ugc('dm_message', 'user_id', 'body');
create trigger watch_groups         after insert or update of name  on public.groups         for each row execute function public.watch_ugc('group', 'created_by', 'name');
create trigger watch_sparks         after insert or update of title, place on public.sparks  for each row execute function public.watch_ugc('spark', 'host_id', 'title', 'place');
create trigger watch_posts          after insert or update of body  on public.posts          for each row execute function public.watch_ugc('post', 'author_id', 'body');
create trigger watch_profiles       after insert or update of handle, display_name, bio, about on public.profiles for each row execute function public.watch_ugc('profile', 'id', 'handle', 'display_name', 'bio', 'about');

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('79_word_watch.sql', '3a484dd375b17d135f53c7eb72bbd97bb12469d790015c60347746d280e4fec7');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('79_word_watch.sql');
  end if;
end $$;


-- ============================================================
--  WHAT A GUEST KEPT COMES ALONG   (80_guest_merge.sql)
-- ============================================================

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


-- ============================================================
--  POSTS ARE OFF   (81_posts_off.sql)
-- ============================================================

-- afterhours — posts are off (81)
--
-- The yours tab has been hidden since 12.10.2026; post/new and the past feed were
-- reachable only from there, and a like or a comment still sent a push whose link
-- opened nothing (F26, 20.10.2026). Decided: take posts down for the release rather
-- than find them a new home. The tables, the triggers and the staff view stay; the
-- app redirects its two screens (content/flags.ts POSTS_ON) and push_wants here says
-- no to every post kind, whatever the person set, so nothing leaves the outbox.
-- push_wants is that of 75 with the one line; flip the line back with the flag.

create or replace function public.push_wants(p_user uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select case
             when p_kind = 'friend_request'  then s.notify_requests
             when p_kind = 'friend_accepted' then s.notify_accepts
             when p_kind = 'match'           then s.notify_matches
             when p_kind = 'friend_live'     then s.notify_live
             when p_kind in ('night_soon', 'night_changed') then s.notify_nights
             when p_kind in ('room_open', 'room_closing', 'room_message') then s.notify_rooms
             when p_kind = 'reply'           then s.notify_replies
             when p_kind = 'digest'          then s.notify_digest
             when p_kind = 'dj_live'         then s.notify_djs
             when p_kind = 'wave'            then s.notify_waves
             when p_kind in ('spark', 'spark_in', 'spark_off') then s.notify_sparks
             when p_kind like 'group\_%' then s.notify_groups
             when p_kind in ('post', 'post_like', 'post_comment') then false
             when p_kind = 'dm'              then s.notify_dms
           end
    from public.profile_settings s where s.user_id = p_user), true);
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('81_posts_off.sql', '7c72d645cc6875566aa55521c252c5e172b32bd7d31347588831a2ed4da19bab');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('81_posts_off.sql');
  end if;
end $$;


-- ============================================================
--  A FILE GOES WITH ITS ROW   (82_leftovers.sql)
-- ============================================================

-- afterhours — a file goes with its row (82)
--
-- The photos bucket is public in the storage sense: whoever holds the address sees
-- the file. Removing a post, a group photo, a cover or a face only ever deleted the
-- row (and the app tried to remove the file from the phone, when it was online and
-- had not crashed); a photo the staff hid stayed served; a deleted account and a
-- pruned guest left their folder behind (F39, 20.10.2026). Decided: the file goes
-- with the row, and a hidden post loses its photo at once. The text stays as the
-- record. Done in the database so that no client is trusted to clean up.
--
--   storage_drop(path)        one object of the photos bucket, service level
--   storage_drop_folder(uid)  everything under a person
-- The triggers below fire on delete, on a replaced path and on hiding. Outside
-- Supabase (the tests) storage.objects may not exist; then there is nothing to drop.

create or replace function public.storage_drop(p_path text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_path is null or to_regclass('storage.objects') is null then return; end if;
  execute 'delete from storage.objects where bucket_id = $1 and name = $2' using 'photos', p_path;
end;
$$;
revoke execute on function public.storage_drop(text) from public, anon, authenticated;

create or replace function public.storage_drop_folder(p_uid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_uid is null or to_regclass('storage.objects') is null then return; end if;
  execute 'delete from storage.objects where bucket_id = $1 and name like $2' using 'photos', p_uid::text || '/%';
end;
$$;
revoke execute on function public.storage_drop_folder(uuid) from public, anon, authenticated;

-- One trigger body: the argument names the path column.
create or replace function public.photo_gone()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  col  text := tg_argv[0];
  was  text := case when tg_op = 'INSERT' then null else to_jsonb(old) ->> col end;
  now_ text := case when tg_op = 'DELETE' then null else to_jsonb(new) ->> col end;
begin
  if tg_op = 'DELETE' then
    perform public.storage_drop(was);
    return old;
  end if;
  if was is distinct from now_ then
    perform public.storage_drop(was);
  elsif (to_jsonb(new) ->> 'is_hidden')::boolean and not coalesce((to_jsonb(old) ->> 'is_hidden')::boolean, false) then
    perform public.storage_drop(now_);
  end if;
  return new;
end;
$$;

create or replace function public.folder_gone()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.storage_drop_folder(old.id);
  return old;
end;
$$;

drop trigger if exists photo_gone_posts          on public.posts;
drop trigger if exists photo_gone_profile_photos on public.profile_photos;
drop trigger if exists photo_gone_group_photos   on public.group_photos;
drop trigger if exists photo_gone_groups         on public.groups;
drop trigger if exists folder_gone_profiles      on public.profiles;
create trigger photo_gone_posts          after delete or update of photo_path, is_hidden on public.posts          for each row execute function public.photo_gone('photo_path');
create trigger photo_gone_profile_photos after delete or update of path                  on public.profile_photos for each row execute function public.photo_gone('path');
create trigger photo_gone_group_photos   after delete or update of path                  on public.group_photos   for each row execute function public.photo_gone('path');
create trigger photo_gone_groups         after delete or update of cover_path            on public.groups         for each row execute function public.photo_gone('cover_path');
create trigger folder_gone_profiles      after delete                                    on public.profiles       for each row execute function public.folder_gone();

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('82_leftovers.sql', 'fd331d73d48eca15b020a2173b0828c697fd674a6e72ab30ea4759e2cc933dbf');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('82_leftovers.sql');
  end if;
end $$;


-- ============================================================
--  A DJ PAGE AFTER THE DJ   (83_dj_after.sql)
-- ============================================================

-- afterhours — a DJ page after the DJ (83)
--
-- When a DJ deleted their account the page stayed up: owner_id fell to null and
-- verified stayed true, so a page nobody could edit or answer for kept its place;
-- and push_hourly told followers about sets of pages the staff had taken down
-- (F25, 20.10.2026). Now: a page loses its check the moment its owner goes
-- (before the profile row leaves, while owner_id still points at it) - a page the
-- staff made themselves, with no owner, is not touched; and the dj_live push goes
-- only for a checked page. push_hourly is that of 26 with the one condition. The bio
-- the DJ writes is shown on the page from this day (app/src/app/dj/[id].tsx).

create or replace function public.dj_owner_gone()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.djs set verified = false, verified_at = null where owner_id = old.id and verified;
  return old;
end;
$$;
drop trigger if exists dj_owner_gone on public.profiles;
create trigger dj_owner_gone before delete on public.profiles
  for each row execute function public.dj_owner_gone();

create or replace function public.push_hourly(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n    integer := 0;
  them record;
begin
  -- a kept night starts in two to three hours
  for them in
    select w.user_id, e.id, e.title, e.slug, e.starts_at
    from public.swipes w join public.events e on e.id = w.event_id
    where w.direction = 'right' and e.is_published and not e.starts_at_estimated
      and e.starts_at > p_now + interval '2 hours' and e.starts_at <= p_now + interval '3 hours'
  loop
    perform public.push_enqueue(them.user_id, 'night_soon', format('soon:%s:%s', them.user_id, them.id),
      jsonb_build_object('title', them.title, 'time', public.push_clock(them.user_id, them.starts_at),
                         'url', '/night/' || them.slug));
    n := n + 1;
  end loop;

  -- a room freezes within two hours
  if to_regclass('public.checkins') is not null then
    for them in execute $q$
      select c.id, c.user_id, e.title, e.slug
      from public.checkins c join public.events e on e.id = c.event_id
      where public.room_freeze_at(c.event_id) > $1 + interval '1 hour'
        and public.room_freeze_at(c.event_id) <= $1 + interval '2 hours'
    $q$ using p_now
    loop
      perform public.push_enqueue(them.user_id, 'room_closing', format('closing:%s', them.id),
        jsonb_build_object('title', them.title, 'url', '/room/' || them.slug));
      n := n + 1;
    end loop;
  end if;

  -- a followed DJ plays within the hour
  if to_regclass('public.dj_sets') is not null then
    for them in execute $q$
      select f.user_id, s.id, s.venue, s.starts_at, d.name, d.slug
      from public.dj_follows f
      join public.dj_sets s on s.dj_id = f.dj_id
      join public.djs d on d.id = f.dj_id
      where s.starts_at > $1 and s.starts_at <= $1 + interval '1 hour'
        and d.verified
    $q$ using p_now
    loop
      perform public.push_enqueue(them.user_id, 'dj_live', format('dj:%s:%s', them.user_id, them.id),
        jsonb_build_object('name', them.name, 'where', them.venue,
                           'time', public.push_clock(them.user_id, them.starts_at), 'url', '/dj/' || them.slug));
      n := n + 1;
    end loop;
  end if;

  -- thursday 18:00 on the phone: the weekend in your city (friday 18:00 to monday 06:00)
  for them in
    with here as (
      select distinct on (k.user_id) k.user_id, k.tz from public.push_tokens k order by k.user_id, k.updated_at desc
    ),
    due as (
      select h.user_id, p.city_id, c.name as city,
             ((p_now at time zone h.tz)::date + 1 + time '18:00') at time zone h.tz as from_at,
             ((p_now at time zone h.tz)::date + 4 + time '06:00') at time zone h.tz as to_at
      from here h
      join public.profiles p on p.id = h.user_id
      join public.cities c on c.id = p.city_id
      where extract(isodow from p_now at time zone h.tz) = 4
        and extract(hour from p_now at time zone h.tz) = 18
    )
    select d.user_id, d.city,
           (select count(*)::int from public.events e
             where e.city_id = d.city_id and e.is_published and e.starts_at >= d.from_at and e.starts_at < d.to_at) as nights,
           (select count(distinct w.event_id)::int from public.swipes w
              join public.events e on e.id = w.event_id
              join public.push_edges f on f.who = d.user_id and f.friend = w.user_id
             where w.direction = 'right' and public.kept_visible(w.user_id)
               and e.city_id = d.city_id and e.starts_at >= d.from_at and e.starts_at < d.to_at) as kept
    from due d
  loop
    if them.nights > 0 then
      perform public.push_enqueue(them.user_id, 'digest', format('digest:%s:%s', them.user_id, to_char(p_now, 'IYYY-IW')),
        jsonb_build_object('city', them.city, 'n', them.nights, 'friends', them.kept, 'url', '/flow'));
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('83_dj_after.sql', '18c17fad8d80b42de42afe6e275348f34a0ea1edf993e45dc07eff43b571b861');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('83_dj_after.sql');
  end if;
end $$;


-- ============================================================
--  A REPORT KEEPS A COPY   (84_report_snapshot.sql)
-- ============================================================

-- afterhours — a report keeps a copy (84)
--
-- A report pointed at a row and nothing else. When the row went (the author took it
-- back, the staff removed it, the account was deleted) the panel showed an empty
-- line; and the report itself left with the reporter, since it hung off their
-- profile (F12, 20.10.2026). Decided: the report takes a copy of what it is about
-- at the moment it is made - the text, the id and handle of the author, the time - and
-- outlives both the content and the reporter. Files are not copied. Removal and
-- deletion flows stay as they are.
--
--   reports.snapshot          jsonb {text, author, author_id, at}, filled by trigger
--   reports.reporter_id       may be null now (the reporter left); fk sets null
-- staff_reports (70) falls back to the copy; staff_report_settle (68) skips a
-- reporter who is gone. Both are their latest text with the one change each.

alter table public.reports add column if not exists snapshot jsonb;
alter table public.reports alter column reporter_id drop not null;
alter table public.reports drop constraint if exists reports_reporter_id_fkey;
alter table public.reports add constraint reports_reporter_id_fkey
  foreign key (reporter_id) references public.profiles (id) on delete set null;

create or replace function public.report_text(p_kind text, p_target text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case p_kind
    when 'comment'       then (select c.body from public.comments c where c.id::text = p_target)
    when 'room_post'     then (select x.body from public.room_posts x where x.id::text = p_target)
    when 'group_message' then (select x.body from public.group_messages x where x.id::text = p_target)
    when 'profile'       then (select concat_ws(' · ', p.handle, p.display_name, p.bio, p.about) from public.profiles p where p.id::text = p_target)
    when 'group'         then (select g.name from public.groups g where g.id::text = p_target)
    when 'spark'         then (select concat_ws(' · ', s.title, s.place) from public.sparks s where s.id::text = p_target)
    when 'post_comment'  then public.post_comment_body(p_target)
    when 'dm_message'    then (select x.body from public.dm_messages x where x.id::text = p_target)
  end;
$$;
revoke execute on function public.report_text(text, text) from public, anon, authenticated;

create or replace function public.report_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  who uuid := public.report_author_any(new.kind, new.target);
begin
  if new.snapshot is null then
    new.snapshot := jsonb_build_object(
      'text', left(public.report_text(new.kind, new.target), 1000),
      'author_id', who,
      'author', (select coalesce(p.handle, p.display_name) from public.profiles p where p.id = who),
      'at', now());
  end if;
  return new;
end;
$$;
drop trigger if exists report_snapshot on public.reports;
create trigger report_snapshot before insert on public.reports
  for each row execute function public.report_snapshot();

create or replace function public.staff_reports()
returns table (kind text, target text, preview text, author text, reports int, reasons text[], first_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  return query
    with open as (
      select r.kind, r.target, count(*)::int as n, array_remove(array_agg(r.reason order by r.created_at), null) as why, min(r.created_at) as first_at,
             (array_agg(r.snapshot order by r.created_at))[1] as snap
      from public.reports r where not r.handled
      group by r.kind, r.target
    )
    select o.kind, o.target,
           coalesce(case o.kind
             when 'comment'       then (select c.body from public.comments c where c.id::text = o.target)
             when 'room_post'     then (select x.body from public.room_posts x where x.id::text = o.target)
             when 'group_message' then (select x.body from public.group_messages x where x.id::text = o.target)
             when 'profile'       then (select concat_ws(' · ', p.display_name, p.bio, p.about) from public.profiles p where p.id::text = o.target)
             when 'group'         then (select g.name from public.groups g where g.id::text = o.target)
             when 'spark'         then (select concat_ws(' · ', s.title, s.place) from public.sparks s where s.id::text = o.target)
             when 'post_comment'  then public.post_comment_body(o.target)
             when 'dm_message'    then (select x.body from public.dm_messages x where x.id::text = o.target)
           end, o.snap ->> 'text'),
           coalesce((select coalesce(p.handle, p.display_name) from public.profiles p where p.id = public.report_author_any(o.kind, o.target)), o.snap ->> 'author'),
           o.n, o.why, o.first_at
    from open o
    order by o.n desc, o.first_at;
end;
$$;

create or replace function public.staff_report_settle(p_kind text, p_target text, p_remove boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  who record;
begin
  perform public.need_staff();
  if coalesce(p_remove, false) then
    if p_kind = 'comment' then
      update public.comments set is_hidden = true where id::text = p_target;
    elsif p_kind = 'room_post' then
      delete from public.room_posts where id::text = p_target;
    elsif p_kind = 'group_message' then
      delete from public.group_messages where id::text = p_target;
    elsif p_kind = 'spark' then
      delete from public.sparks where id::text = p_target;
    elsif p_kind = 'group' then
      delete from public.groups where id::text = p_target;
    elsif p_kind = 'post_comment' then
      execute 'update public.post_comments set is_hidden = true where id::text = $1' using p_target;
    elsif p_kind = 'profile' then
      update public.profiles set bio = null, about = null where id::text = p_target;
      delete from public.profile_links where user_id::text = p_target;
      delete from public.profile_photos where user_id::text = p_target;
    else
      raise exception 'which kind?';
    end if;
  end if;
  for who in select distinct r.reporter_id from public.reports r
             where r.kind = p_kind and r.target = p_target and not r.handled and r.reporter_id is not null loop
    perform public.notice(who.reporter_id,
                          case when coalesce(p_remove, false) then 'report_removed' else 'report_kept' end,
                          jsonb_build_object('what', p_kind));
  end loop;
  update public.reports set handled = true where kind = p_kind and target = p_target and not handled;
  perform public.staff_note(case when coalesce(p_remove, false) then 'remove' else 'keep' end, 'report:' || p_kind, p_target, null);
end;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('84_report_snapshot.sql', 'c54686d5ef5522460c11364078715e0b5ee8dcd170bcaabd302b6cddd79c5064');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('84_report_snapshot.sql');
  end if;
end $$;


-- ============================================================
--  A CLOSED ACCOUNT MAY OBJECT   (85_appeals.sql)
-- ============================================================

-- afterhours — a closed account may object (85)
--
-- A closed account could read why, download its data and leave; it could not say
-- "that is wrong" anywhere the staff would see (F16, 20.10.2026; the DSA asks for
-- an internal way to complain about a decision). Decided: a box on the closed
-- screen. One open objection at a time, 20 to 600 characters; the staff see them
-- in the panel beside the reports and answer with "open again" or "stays closed";
-- the person hears through a notice (appeal_ok / appeal_no) the next time the app
-- starts, and sees the state on the closed screen itself.
--
--   appeal(body)                       the closed account writes once
--   my_appeal()                        what the closed screen shows
--   staff_appeals()                    the open ones, oldest first
--   staff_appeal_settle(id, unban)     open again, or not; both are logged

create table if not exists public.appeals (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles on delete cascade,
  body        text not null check (length(btrim(body)) between 20 and 600),
  created_at  timestamptz not null default now(),
  settled_at  timestamptz,
  outcome     text check (outcome is null or outcome in ('unban', 'keep')),
  settled_by  uuid references public.profiles on delete set null
);
create index if not exists appeals_open on public.appeals (created_at) where settled_at is null;
alter table public.appeals enable row level security;
revoke all on public.appeals from public, anon, authenticated;

alter table public.notices drop constraint if exists notices_kind_check;
alter table public.notices add constraint notices_kind_check
  check (kind in ('comment_hidden', 'post_hidden', 'removed', 'profile_cleared',
                  'role', 'dj_verified', 'dj_hidden', 'report_removed', 'report_kept',
                  'night_ok', 'night_no', 'appeal_ok', 'appeal_no'));

create or replace function public.appeal(p_body text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if not public.is_banned() then raise exception 'the account is open'; end if;
  if exists (select 1 from public.appeals a where a.user_id = auth.uid() and a.settled_at is null) then
    raise exception 'already sent';
  end if;
  insert into public.appeals (user_id, body) values (auth.uid(), btrim(p_body));
end;
$$;
grant execute on function public.appeal(text) to authenticated;

create or replace function public.my_appeal()
returns table (sent_at timestamptz, outcome text, settled_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select a.created_at, a.outcome, a.settled_at from public.appeals a
  where a.user_id = auth.uid() order by a.created_at desc limit 1;
$$;
grant execute on function public.my_appeal() to authenticated;

create or replace function public.staff_appeals()
returns table (id bigint, user_id uuid, handle text, reason text, banned_at timestamptz, body text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  return query
    select a.id, a.user_id, coalesce(p.handle, p.display_name), p.banned_reason, p.banned_at, a.body, a.created_at
    from public.appeals a join public.profiles p on p.id = a.user_id
    where a.settled_at is null
    order by a.created_at;
end;
$$;
grant execute on function public.staff_appeals() to authenticated;

create or replace function public.staff_appeal_settle(p_id bigint, p_unban boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.appeals%rowtype;
begin
  perform public.need_staff();
  select * into a from public.appeals where id = p_id and settled_at is null;
  if a.id is null then raise exception 'no such appeal'; end if;
  update public.appeals set settled_at = now(), outcome = case when coalesce(p_unban, false) then 'unban' else 'keep' end, settled_by = auth.uid()
   where id = p_id;
  if coalesce(p_unban, false) then
    perform public.staff_unban(a.user_id);
  end if;
  perform public.notice(a.user_id, case when coalesce(p_unban, false) then 'appeal_ok' else 'appeal_no' end, '{}'::jsonb);
  perform public.staff_note(case when coalesce(p_unban, false) then 'appeal-unban' else 'appeal-keep' end, 'person', a.user_id::text, null);
end;
$$;
grant execute on function public.staff_appeal_settle(bigint, boolean) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('85_appeals.sql', '1c7ec869e98f4f8cff38ddc21df11bcf30cf7e7909633f92a856377cd3d6ae17');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('85_appeals.sql');
  end if;
end $$;


-- ============================================================
--  THE FILE ON A PERSON; WHO MAY OPEN A CLOSED ACCOUNT   (86_person_file.sql)
-- ============================================================

-- afterhours — the file on a person, and who may open a closed account (86)
--
-- The staff saw a person as one row: a name, a role, a badge. What they had been
-- reported for, how often, what was said, whether they had been closed before and
-- what they wrote in objection lived in five tables nobody could read together
-- (F18, 20.10.2026). And a community manager could open an account an admin had
-- closed. Decided: one file per person, and a tier.
--
--   staff_person(user)   jsonb: who, reports about them (with the copies of 84),
--                        reports they made, objections (85), the staff log on them
--   staff_unban(user)    as 52, but a ban given by an admin is lifted by an admin only;
--                        staff_appeal_settle (85) goes through it and inherits the rule

create or replace function public.staff_unban(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  by_admin boolean;
begin
  perform public.need_staff();
  select coalesce(b.is_admin or b.account_type = 'admin', false) into by_admin
    from public.profiles p left join public.profiles b on b.id = p.banned_by
   where p.id = p_user;
  if coalesce(by_admin, false) and not coalesce(public.is_admin(), false) then
    raise exception 'an admin closed this account; only an admin opens it' using errcode = '42501';
  end if;
  perform set_config('afterhours.ban', 'on', true);
  update public.profiles set banned_at = null, banned_reason = null, banned_by = null where id = p_user;
  perform set_config('afterhours.ban', '', true);
  perform public.staff_note('unban', 'person', p_user::text, null);
end;
$$;

create or replace function public.staff_person(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  out jsonb;
begin
  perform public.need_staff();
  select jsonb_build_object(
    'who', (select jsonb_build_object('id', p.id, 'handle', p.handle, 'name', p.display_name, 'role',
                     case when p.is_admin then 'admin' else p.account_type end, 'created_at', p.created_at,
                     'banned_at', p.banned_at, 'banned_reason', p.banned_reason,
                     'banned_by', (select coalesce(b.handle, b.display_name) from public.profiles b where b.id = p.banned_by),
                     'banned_by_admin', (select coalesce(b.is_admin or b.account_type = 'admin', false) from public.profiles b where b.id = p.banned_by))
            from public.profiles p where p.id = p_user),
    'reports_about', coalesce((select jsonb_agg(jsonb_build_object('kind', r.kind, 'target', r.target, 'text', r.snapshot ->> 'text',
                                 'reason', r.reason, 'handled', r.handled, 'at', r.created_at) order by r.created_at desc)
            from public.reports r where (r.snapshot ->> 'author_id') = p_user::text), '[]'::jsonb),
    'reports_made', coalesce((select jsonb_agg(jsonb_build_object('kind', r.kind, 'reason', r.reason, 'handled', r.handled, 'at', r.created_at) order by r.created_at desc)
            from public.reports r where r.reporter_id = p_user), '[]'::jsonb),
    'appeals', coalesce((select jsonb_agg(jsonb_build_object('body', a.body, 'outcome', a.outcome, 'at', a.created_at, 'settled_at', a.settled_at) order by a.created_at desc)
            from public.appeals a where a.user_id = p_user), '[]'::jsonb),
    'log', coalesce((select jsonb_agg(jsonb_build_object('action', l.action, 'note', l.note, 'at', l.at,
                                 'by', (select coalesce(x.handle, x.display_name) from public.profiles x where x.id = l.actor_id)) order by l.at desc)
            from public.staff_log l where l.target = 'person' and l.target_id = p_user::text), '[]'::jsonb)
  ) into out;
  return out;
end;
$$;
grant execute on function public.staff_person(uuid) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('86_person_file.sql', 'c4ec3d2800b5dc808a1b3a53e9fa2a380fdea01912c699317cd69b9aa1ed7649');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('86_person_file.sql');
  end if;
end $$;


-- ============================================================
--  IS THE CLOCK RUNNING   (87_cron_health.sql)
-- ============================================================

-- afterhours — is the clock running (87)
--
-- Six jobs hang off pg_cron: push_flush, push_hourly, group_push_hourly,
-- hide_past_events, guests_prune, the error prune. If the extension is off or a job
-- is unscheduled, every one of them dies in silence and nothing says so (F11,
-- 20.10.2026; the deck has filtered its own dates since 67). cron_health() reads
-- the cron schema when it is there - how many afterhours jobs are scheduled, when
-- one last ran well, when one last failed - and tools/health.mjs goes red when the
-- last good run is more than two hours old. Outside Supabase (the tests) the schema
-- is missing and the answer is zero and null.

create or replace function public.cron_health()
returns table (jobs int, last_ok timestamptz, last_failed timestamptz, failed_24h int)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if to_regclass('cron.job') is null or to_regclass('cron.job_run_details') is null then
    return query select 0, null::timestamptz, null::timestamptz, 0;
    return;
  end if;
  return query execute $q$
    select (select count(*)::int from cron.job where active),
           (select max(end_time) from cron.job_run_details where status = 'succeeded'),
           (select max(end_time) from cron.job_run_details where status = 'failed'),
           (select count(*)::int from cron.job_run_details where status = 'failed' and end_time > now() - interval '24 hours')
  $q$;
end;
$$;
grant execute on function public.cron_health() to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('87_cron_health.sql', '66855abff143fb2e064f228a9169eda723792c65e627a10e8998c1f8813e3715');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('87_cron_health.sql');
  end if;
end $$;


-- ============================================================
--  A CHECK-IN THAT MEANS SOMETHING   (88_checkin_truth.sql)
-- ============================================================

-- afterhours — a check-in that means something (88)
--
-- 23 took the door tests away so that a card is never refused; since then any tap,
-- any time, anywhere, told every friend "X is out now" - and the location the phone
-- sent was thrown away (F9, 20.10.2026). Decided: the card is still never refused,
-- but the word to friends is. A check-in is LIVE when it falls six hours before to
-- eight hours after the night starts and, when the phone gave a position and the
-- night has one, within two kilometres of it. Only a live check-in pushes friend_live
-- and shows in friends_live(); the card, the room and the collection are the same
-- either way. The position is kept on the row now (the export of 64 lists it).
-- And a check-in can be taken back within an hour: the card goes, the pushes that
-- have not left go with it.
--
--   check_in(slug, lat, lng, at)   as 37; sets lat, lng, live
--   check_out(slug)                within an hour of the check-in; "toolate" after
--   km_between(lat1, lng1, lat2, lng2)

-- the table of 19 predates 23, which meant to add the position; the columns are made sure of here
alter table public.checkins add column if not exists lat double precision;
alter table public.checkins add column if not exists lng double precision;
alter table public.checkins add column if not exists live boolean not null default true;

create or replace function public.km_between(a_lat double precision, a_lng double precision, b_lat double precision, b_lng double precision)
returns double precision
language sql
immutable
as $$
  select 2 * 6371 * asin(sqrt(
    power(sin(radians(b_lat - a_lat) / 2), 2)
    + cos(radians(a_lat)) * cos(radians(b_lat)) * power(sin(radians(b_lng - a_lng) / 2), 2)));
$$;

create or replace function public.check_in(
  p_slug text,
  p_lat  double precision default null,
  p_lng  double precision default null,
  p_at   timestamptz default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  e     public.events%rowtype;
  n     bigint;
  at    timestamptz := least(coalesce(p_at, now()), now());
  there double precision;
  x_lat double precision;
  x_lng double precision;
  live  boolean := true;
begin
  if auth.uid() is null or public.is_guest() then raise exception 'signedout'; end if;
  select * into e from public.events where slug = p_slug and is_published;
  if not found then raise exception 'nonight'; end if;

  -- One card per person per night: a second try returns the first card.
  select card_no into n from public.checkins where user_id = auth.uid() and event_id = e.id;
  if found then return n; end if;

  if at < now() - interval '12 hours' then at := now(); end if;

  -- the window: six hours before to eight after; a night without a time is always in it
  if e.starts_at is not null and (at < e.starts_at - interval '6 hours' or at > e.starts_at + interval '8 hours') then
    live := false;
  end if;
  -- the place: the position of the night, else of its venue; no position on either side, no test
  select coalesce(e.lat, v.lat), coalesce(e.lng, v.lng) into x_lat, x_lng
    from (select 1) one left join public.venues v on v.id = e.venue_id;
  if live and p_lat is not null and p_lng is not null and x_lat is not null and x_lng is not null then
    there := public.km_between(p_lat, p_lng, x_lat, x_lng);
    if there > 2 then live := false; end if;
  end if;

  insert into public.checkins (user_id, event_id, checked_at, lat, lng, live)
  values (auth.uid(), e.id, at, p_lat, p_lng, live) returning card_no into n;
  return n;
end;
$$;

create or replace function public.check_out(p_slug text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.checkins%rowtype;
begin
  if auth.uid() is null then raise exception 'signedout'; end if;
  select c0.* into c from public.checkins c0 join public.events e on e.id = c0.event_id
   where c0.user_id = auth.uid() and e.slug = p_slug;
  if c.id is null then return false; end if;
  if c.checked_at < now() - interval '1 hour' then raise exception 'toolate'; end if;
  delete from public.push_outbox
   where sent_at is null and (key = 'room_open:' || c.id::text or key like 'live:%:' || c.id::text);
  delete from public.checkins where id = c.id;
  return true;
end;
$$;
grant execute on function public.check_out(text) to authenticated;

create or replace function public.push_on_checkin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  night  record;
  friend uuid;
begin
  select e.title, e.slug, v.name as venue
    into night
  from public.events e left join public.venues v on v.id = e.venue_id
  where e.id = new.event_id;

  perform public.push_enqueue(new.user_id, 'room_open', format('room_open:%s', new.id),
    jsonb_build_object('title', night.title, 'url', '/room/' || night.slug));

  if new.show_friends and new.live then
    for friend in select f.friend from public.push_edges f where f.who = new.user_id loop
      perform public.push_enqueue(friend, 'friend_live',
        format('live:%s:%s', friend, new.id),
        jsonb_build_object('name', public.push_name(new.user_id),
                           'title', coalesce(night.venue || ' · ', '') || night.title,
                           'url', '/night/' || night.slug));
    end loop;
  end if;
  return new;
end;
$$;

create or replace function public.friends_live()
returns table (
  friend_id     uuid,
  handle        text,
  display_name  text,
  slug          text,
  title         text,
  venue_name    text,
  checked_at    timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select c.user_id, p.handle, p.display_name, e.slug, e.title, v.name, date_trunc('hour', c.checked_at)
  from public.checkins c
  join public.profiles p on p.id = c.user_id
  join public.events e on e.id = c.event_id
  left join public.venues v on v.id = e.venue_id
  where c.show_friends and c.live
    and c.checked_at > now() - interval '8 hours'
    and public.is_friend(c.user_id)
  order by c.checked_at desc;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('88_checkin_truth.sql', 'd29cb8a9f3e17270d5f4fb130240b544df21cdf44a76ee452afae94dc84f78d9');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('88_checkin_truth.sql');
  end if;
end $$;


-- ============================================================
--  THE EXPORT, WHOLE   (89_export_all.sql)
-- ============================================================

-- afterhours — the export, whole (89)
--
-- export_me() (14, 64) handed back profile, settings, swipes, comments, friends,
-- feedback, messages and tickets and nothing else, while the privacy notice promises
-- everything (F3, 20.10.2026). The function is that of 64 with every later table a
-- person writes to: check-ins (with the position of 88), room lines, rsvps, posts and
-- their likes and comments, groups (membership, own messages and photos), sparks and
-- answers, profile links and photo, who they blocked, reports they made, objections,
-- every notification switch, the DJ page they own, the nights they sent in.
-- Lines of other people are never in it; only what this person wrote.

create or replace function public.export_me()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'taken_at', now(),
    'about', 'Everything afterhours holds about you. Your account email lives'
             || ' with the sign-in provider, not in this database.',

    'profile', (
      select to_jsonb(x) from (
        select p.handle, p.display_name, p.bio, c.slug as city,
               p.created_at as joined, p.onboarded_at, p.last_seen_at
        from public.profiles p
        left join public.cities c on c.id = p.city_id
        where p.id = auth.uid()
      ) x),

    'settings', (
      select to_jsonb(x) from (
        select s.kept_visibility, s.discoverable, s.notify_email, s.locale
        from public.profile_settings s where s.user_id = auth.uid()
      ) x),

    'swipes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event', e.slug, 'title', e.title,
               'direction', w.direction, 'at', w.created_at)
             order by w.created_at)
      from public.swipes w
      join public.events e on e.id = w.event_id
      where w.user_id = auth.uid()
    ), '[]'::jsonb),

    'comments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event', e.slug, 'body', c.body,
               'reply_to', c.parent_id, 'at', c.created_at)
             order by c.created_at)
      from public.comments c
      join public.events e on e.id = c.event_id
      where c.author_id = auth.uid()
    ), '[]'::jsonb),

    'friendships', coalesce((
      select jsonb_agg(jsonb_build_object(
               'handle', p.handle, 'status', f.status,
               'direction', case when f.requester_id = auth.uid()
                                 then 'outgoing' else 'incoming' end,
               'at', f.created_at)
             order by f.created_at)
      from public.friendships f
      join public.profiles p
        on p.id = case when f.requester_id = auth.uid()
                       then f.addressee_id else f.requester_id end
      where f.requester_id = auth.uid() or f.addressee_id = auth.uid()
    ), '[]'::jsonb),

    'feedback', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', g.kind, 'body', g.body, 'at', g.created_at)
             order by g.created_at)
      from public.feedback g where g.author_id = auth.uid()
    ), '[]'::jsonb),

    -- The lines you wrote, named by the friend they went to.
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
               'to', p.handle, 'body', m.body, 'at', m.created_at)
             order by m.id)
      from public.dm_messages m
      join public.dm_threads t on t.id = m.thread_id
      left join public.profiles p
        on p.id = case when t.a = auth.uid() then t.b else t.a end
      where m.user_id = auth.uid()
    ), '[]'::jsonb),

    'checkins', coalesce((
      select jsonb_agg(jsonb_build_object('event', e.slug, 'title', e.title, 'card_no', k.card_no,
               'at', k.checked_at, 'lat', k.lat, 'lng', k.lng, 'shown_to_friends', k.show_friends) order by k.checked_at)
      from public.checkins k join public.events e on e.id = k.event_id where k.user_id = auth.uid()), '[]'::jsonb),
    'room_lines', coalesce((
      select jsonb_agg(jsonb_build_object('event', e.slug, 'body', r.body, 'at', r.created_at) order by r.created_at)
      from public.room_posts r join public.events e on e.id = r.event_id where r.user_id = auth.uid()), '[]'::jsonb),
    'rsvps', coalesce((
      select jsonb_agg(jsonb_build_object('event', e.slug, 'answer', v.answer, 'at', v.updated_at) order by v.updated_at)
      from public.rsvps v join public.events e on e.id = v.event_id where v.user_id = auth.uid()), '[]'::jsonb),
    'posts', coalesce((
      select jsonb_agg(jsonb_build_object('body', p.body, 'photo', p.photo_path, 'event', e.slug, 'hidden', p.is_hidden, 'at', p.created_at) order by p.created_at)
      from public.posts p left join public.events e on e.id = p.event_id where p.author_id = auth.uid()), '[]'::jsonb),
    'post_likes', coalesce((
      select jsonb_agg(jsonb_build_object('post', l.post_id, 'at', l.created_at) order by l.created_at)
      from public.post_likes l where l.user_id = auth.uid()), '[]'::jsonb),
    'post_comments', coalesce((
      select jsonb_agg(jsonb_build_object('post', c.post_id, 'body', c.body, 'at', c.created_at) order by c.created_at)
      from public.post_comments c where c.author_id = auth.uid()), '[]'::jsonb),
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object('name', g.name, 'emoji', g.emoji, 'role', m.role, 'joined', m.joined_at,
               'messages', (select coalesce(jsonb_agg(jsonb_build_object('body', x.body, 'kind', x.kind, 'at', x.created_at) order by x.created_at), '[]'::jsonb)
                            from public.group_messages x where x.group_id = g.id and x.user_id = auth.uid()),
               'photos', (select coalesce(jsonb_agg(x.path order by x.created_at), '[]'::jsonb)
                          from public.group_photos x where x.group_id = g.id and x.user_id = auth.uid())) order by m.joined_at)
      from public.group_members m join public.groups g on g.id = m.group_id where m.user_id = auth.uid()), '[]'::jsonb),
    'sparks', coalesce((
      select jsonb_agg(jsonb_build_object('kind', s.kind, 'title', s.title, 'place', s.place, 'starts_at', s.starts_at, 'at', s.created_at) order by s.created_at)
      from public.sparks s where s.host_id = auth.uid()), '[]'::jsonb),
    'spark_answers', coalesce((
      select jsonb_agg(jsonb_build_object('spark', s.title, 'answer', i.answer, 'at', i.answered_at) order by i.answered_at)
      from public.spark_invites i join public.sparks s on s.id = i.spark_id where i.user_id = auth.uid()), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object('kind', l.kind, 'value', l.value) order by l.kind)
      from public.profile_links l where l.user_id = auth.uid()), '[]'::jsonb),
    'photo', (select f.path from public.profile_photos f where f.user_id = auth.uid()),
    'blocked', coalesce((
      select jsonb_agg(jsonb_build_object('handle', p.handle, 'at', b.created_at) order by b.created_at)
      from public.blocks b join public.profiles p on p.id = b.blocked_id where b.blocker_id = auth.uid()), '[]'::jsonb),
    'reports_made', coalesce((
      select jsonb_agg(jsonb_build_object('kind', r.kind, 'reason', r.reason, 'handled', r.handled, 'at', r.created_at) order by r.created_at)
      from public.reports r where r.reporter_id = auth.uid()), '[]'::jsonb),
    'appeals', coalesce((
      select jsonb_agg(jsonb_build_object('body', a.body, 'outcome', a.outcome, 'at', a.created_at) order by a.created_at)
      from public.appeals a where a.user_id = auth.uid()), '[]'::jsonb),
    'notifications', (
      select to_jsonb(x) from (
        select s.notify_requests, s.notify_accepts, s.notify_matches, s.notify_live, s.notify_nights, s.notify_rooms,
               s.notify_replies, s.notify_digest, s.notify_djs, s.notify_waves, s.notify_sparks, s.notify_groups, s.notify_posts, s.notify_dms
        from public.profile_settings s where s.user_id = auth.uid()) x),
    'dj_page', (
      select to_jsonb(x) from (select d.slug, d.name, d.genre, d.bio, d.verified from public.djs d where d.owner_id = auth.uid()) x),
    'nights_sent', coalesce((
      select jsonb_agg(jsonb_build_object('title', e.title, 'starts_at', e.starts_at, 'published', e.is_published, 'at', e.created_at) order by e.created_at)
      from public.events e where e.created_by = auth.uid()), '[]'::jsonb),

    'tickets', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event', e.slug, 'title', e.title,
               'answer', k.answer, 'at', k.answered_at)
             order by k.answered_at)
      from public.tickets k
      join public.events e on e.id = k.event_id
      where k.user_id = auth.uid()
    ), '[]'::jsonb)
  )
  where auth.uid() is not null;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('89_export_all.sql', '7b31143e846e9a6f8410a1175e128cdacca2128dd437e2119333721d6c5127fb');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('89_export_all.sql');
  end if;
end $$;


-- ============================================================
--  WHO HAS READ WHAT, KEPT BY THE SERVER   (90_dm_seen.sql)
-- ============================================================

-- afterhours — who has read what, kept by the server (90)
--
-- What a person had seen of a conversation lived on the phone alone: a second
-- phone, a reinstall or the web showed every line as new (F28, 20.10.2026). The
-- thread now carries, for each side, the last line that side has seen; dm_seen
-- moves it, dm_list counts the lines after it that are not mine. The phone keeps
-- its own mark too and uses the one on the server when it is there. dm_list is that of 59
-- with the one column, so it is dropped and made again with its grant.

alter table public.dm_threads add column if not exists seen_a bigint not null default 0;
alter table public.dm_threads add column if not exists seen_b bigint not null default 0;

create or replace function public.dm_seen(p_thread uuid, p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'sign in first'; end if;
  update public.dm_threads
     set seen_a = case when a = me then greatest(seen_a, p_id) else seen_a end,
         seen_b = case when b = me then greatest(seen_b, p_id) else seen_b end
   where id = p_thread and me in (a, b);
end;
$$;
grant execute on function public.dm_seen(uuid, bigint) to authenticated;

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
  select t.id, o.id, o.handle, coalesce(o.display_name, o.handle),
         l.body, l.user_id = me, l.id, t.last_at,
         (select count(*)::int from public.dm_messages u
           where u.thread_id = t.id and u.user_id <> me
             and u.id > case when t.a = me then t.seen_a else t.seen_b end)
  from public.dm_threads t
  join public.profiles o on o.id = case when t.a = me then t.b else t.a end
  left join lateral (select m.id, m.body, m.user_id from public.dm_messages m where m.thread_id = t.id order by m.id desc limit 1) l on true
  where me in (t.a, t.b)
    and public.reachable(me, o.id)
  order by t.last_at desc;
end;
$$;
grant execute on function public.dm_list() to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('90_dm_seen.sql', 'ffd942a2cb07ce815b8c3df126b045187574293773a33b312af376f731811fe5');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('90_dm_seen.sql');
  end if;
end $$;


-- ============================================================
--  A FILE REMEMBERS ITS OWN TEXT   (91_checksums.sql)
-- ============================================================

-- afterhours — a file remembers its own text (91)
--
-- The migration log (00) knew a file by name alone: a file edited after it was
-- pasted, or an old copy pasted again over newer shared functions, left no trace
-- (F33, 20.10.2026). tools/stamp-sql.mjs now writes the sha256 of each file into
-- its own stamp block; migration_done(name, hash) keeps it here, and
-- tools/health.mjs compares what is applied with what the repository holds.
-- A file pasted before this one still stamps by name (the block tries both).
-- migrations_applied returns the hash too, so it is dropped and made again.

alter table public.migrations add column if not exists hash text;

create or replace function public.migration_done(p_name text, p_hash text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.migrations (name, hash) values (p_name, p_hash)
  on conflict (name) do update set applied_at = now(), hash = excluded.hash;
$$;

drop function if exists public.migrations_applied();
create or replace function public.migrations_applied()
returns table (name text, applied_at timestamptz, hash text)
language sql
stable
security definer
set search_path = public
as $$
  select m.name, m.applied_at, m.hash from public.migrations m order by m.name;
$$;
grant execute on function public.migrations_applied() to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('91_checksums.sql', '3e2d52d795b47a138cfdb605bf8c6d50fc8ebe393292a64f26aafb56e41061f0');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('91_checksums.sql');
  end if;
end $$;


-- ============================================================
--  THE HOUR A NIGHT STARTS, IN ITS OWN CITY   (92_timezones.sql)
-- ============================================================

-- afterhours — the hour a night starts, in its own city (92)
--
-- The sync wrote the local date and time of a night with no zone, and Postgres
-- read it as UTC: every synced night sat one or two hours late in the database,
-- and the pushes, the past cut, the rooms and the quiet hours moved with it
-- (F37, 20.10.2026). From now on the sync sends the zone Ticketmaster names
-- (tools/sync-ticketmaster.mjs) and keeps it on the row; the cities carry theirs
-- by country for everything else. A row already here is moved once, and only when it
-- really sat as UTC (its UTC hour equals the hour in date_text); the live database
-- turned out to read local times in Berlin already, and its rows stay as they are.
-- The move runs only the first time this file does - the log of 00 says whether it has.

alter table public.cities add column if not exists tz text not null default 'Europe/Berlin';
update public.cities set tz = case country_slug
    when 'de' then 'Europe/Berlin'
    when 'at' then 'Europe/Vienna'
    when 'ch' then 'Europe/Zurich'
    when 'nl' then 'Europe/Amsterdam'
    when 'be' then 'Europe/Brussels'
    when 'fr' then 'Europe/Paris'
    when 'es' then 'Europe/Madrid'
    when 'it' then 'Europe/Rome'
    when 'pl' then 'Europe/Warsaw'
    when 'cz' then 'Europe/Prague'
    when 'hu' then 'Europe/Budapest'
    when 'dk' then 'Europe/Copenhagen'
    when 'se' then 'Europe/Stockholm'
    when 'no' then 'Europe/Oslo'
    when 'fi' then 'Europe/Helsinki'
    when 'gr' then 'Europe/Athens'
    when 'tr' then 'Europe/Istanbul'
    when 'gb' then 'Europe/London'
    when 'ie' then 'Europe/Dublin'
    when 'pt' then 'Europe/Lisbon'
    when 'ae' then 'Asia/Dubai'
    when 'hk' then 'Asia/Hong_Kong'
    when 'sg' then 'Asia/Singapore'
    when 'jp' then 'Asia/Tokyo'
    when 'kr' then 'Asia/Seoul'
    when 'tw' then 'Asia/Taipei'
    when 'id' then 'Asia/Jakarta'
    when 'au' then 'Australia/Sydney'
    when 'nz' then 'Pacific/Auckland'
    when 'fj' then 'Pacific/Fiji'
    when 'ke' then 'Africa/Nairobi'
    when 'ma' then 'Africa/Casablanca'
    when 'ng' then 'Africa/Lagos'
    else 'Europe/Berlin' end;

alter table public.events add column if not exists tz text;

do $$ begin
  if not exists (select 1 from public.migrations where name = '92_timezones.sql') then
    -- move only the rows that really sat as UTC: their UTC clock shows the local hour of
    -- date_text. A database whose own zone is Berlin stored them right already, and those
    -- rows read the local hour in their city instead, so they are left alone.
    update public.events e
       set starts_at = ((e.starts_at at time zone 'UTC') at time zone c.tz)
      from public.cities c
     where c.id = e.city_id and e.source = 'ticketmaster' and e.starts_at is not null and e.tz is null
       and substring(e.date_text from '([0-9]{2}:[0-9]{2})') is not null
       and to_char(e.starts_at at time zone 'UTC', 'HH24:MI') = substring(e.date_text from '([0-9]{2}:[0-9]{2})')
       and to_char(e.starts_at at time zone c.tz, 'HH24:MI') <> substring(e.date_text from '([0-9]{2}:[0-9]{2})');
    update public.events e set tz = c.tz
      from public.cities c
     where c.id = e.city_id and e.source = 'ticketmaster' and e.tz is null;
  end if;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('92_timezones.sql', 'bb1f5f9b344cce65c9f9b6c0f4a0680a7d768a0160d4116bc1aa66b611e3d676');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('92_timezones.sql');
  end if;
end $$;


-- ============================================================
--  WHAT THE STAFF HAVE LEFT WAITING   (93_staff_backlog.sql)
-- ============================================================

-- afterhours — what the staff have left waiting (93)
--
-- The staff hear of a report by push alone (staff_ping); with no phone registered
-- nobody hears, and nothing watches the promise of a look within 24 hours
-- (F38, 20.10.2026). staff_backlog() counts what has waited too long - reports
-- open for 20 hours, objections for 3 days, nights sent in for 3 days - and
-- tools/health.mjs goes red on it, which the morning health workflow turns into
-- a failed run and a mail. No new service; the repository already sends those.

create or replace function public.staff_backlog()
returns table (reports_waiting int, oldest_report timestamptz, appeals_waiting int, nights_waiting int)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(distinct (r.kind, r.target))::int from public.reports r
      where not r.handled and r.created_at < now() - interval '20 hours'),
    (select min(r.created_at) from public.reports r where not r.handled),
    (select count(*)::int from public.appeals a where a.settled_at is null and a.created_at < now() - interval '3 days'),
    (select count(*)::int from public.events e where not e.is_published and e.source = 'user' and e.created_at < now() - interval '3 days');
$$;
grant execute on function public.staff_backlog() to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('93_staff_backlog.sql', 'fbc4f21a9db0099d046ecc689a1c54cd1b1a3476683c1e0da9181a290cb9b6fc');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('93_staff_backlog.sql');
  end if;
end $$;


-- ============================================================
--  WHAT IS KEPT, AND FOR HOW LONG   (94_retention.sql)
-- ============================================================

-- afterhours — what is kept, and for how long (94)
--
-- The privacy notice promised periods the code did not keep: pushes stayed in the
-- outbox for ever, settled reports and objections never left (F5, 20.10.2026).
-- retention_prune() runs every night at 04:45 and holds the database to the notice:
--   push_outbox     sent pushes after 30 days, unsent ones after 7
--   reports         settled ones a year after they were made (repeat offences are
--                   recognised within that year; the copy of 84 goes with them)
--   appeals         settled ones after a year
--   notices         read or not, after 90 days
-- Guests (54, 30 days), client errors (51, 30 days) and the backups (90 and 30 days)
-- keep their own clocks. Returns how many rows went, for the log.

create or replace function public.retention_prune()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
  k int;
begin
  delete from public.push_outbox where (sent_at is not null and sent_at < now() - interval '30 days')
                                    or (sent_at is null and created_at < now() - interval '7 days');
  get diagnostics k = row_count; n := n + k;
  delete from public.reports where handled and created_at < now() - interval '1 year';
  get diagnostics k = row_count; n := n + k;
  delete from public.appeals where settled_at is not null and settled_at < now() - interval '1 year';
  get diagnostics k = row_count; n := n + k;
  delete from public.notices where created_at < now() - interval '90 days';
  get diagnostics k = row_count; n := n + k;
  return n;
end;
$$;
revoke execute on function public.retention_prune() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'afterhours-retention';
    perform cron.schedule('afterhours-retention', '45 4 * * *', $q$select public.retention_prune()$q$);
  end if;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('94_retention.sql', '97eaddca67f1c86737829fd9206277640cf2c524ef5964688cf53d8d100ef94a');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('94_retention.sql');
  end if;
end $$;


-- ============================================================
--  A NIGHT THAT HAPPENED STILL HAS ITS PAGE   (95_past_night_page.sql)
-- ============================================================

-- afterhours — a night that happened still has its page (95)
--
-- Since 66 a synced night whose date has passed is retired (is_published = false)
-- instead of deleted, and 72 does the same to a cancelled one. The night page reads
-- events_public, whose rule shows published rows only, so a card in the collection,
-- the past feed or a passport opened onto an empty page (F40, found by the second
-- cloud night, 20.10.2026). night_page(slug) returns the one row when it is published,
-- or a synced night that is over or was cancelled: those were public listings and
-- stay public facts. A night someone sent in that the staff have not let through
-- stays hidden. The app falls back to it when the plain read finds nothing.

create or replace function public.night_page(p_slug text)
returns setof public.events_public
language sql
stable
security definer
set search_path = public
as $$
  select v.* from public.events_public v
  join public.events e on e.id = v.id
  where v.slug = p_slug
    and (e.is_published
         or (e.source = 'ticketmaster' and (e.starts_at < now() or e.status = 'cancelled')))
  limit 1;
$$;
grant execute on function public.night_page(text) to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('95_past_night_page.sql', '1da0cd5eefa1e83a8d6434dd53daf9266a338056feddb64865258a4367000593');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('95_past_night_page.sql');
  end if;
end $$;
