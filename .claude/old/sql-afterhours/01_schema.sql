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
