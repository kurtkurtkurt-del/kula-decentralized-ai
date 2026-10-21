-- ============================================================
--  pasaport — SETUP : THE WHOLE DATABASE
--  VERSION: 2026-10-21 15:52   ← if the editor shows this line, it is the right copy
--
--  In the Supabase panel: SQL Editor → New query → paste this file
--  IN FULL → Run.
--
--  When it finishes you should see "Success. No rows returned".
--
--  GENERATED FILE — source: backend/tools/build-setup.mjs
-- ============================================================


-- ============================================================
--  THE MIGRATION LOG — which files have been run   (00_migrations.sql)
-- ============================================================

-- pasaport — which of these files has actually been run
-- The setup is pasted into the Supabase editor by hand (or applied by tools/migrate.mjs),
-- so a project can easily be a file or two behind without anything looking wrong: a
-- page just answers PGRST202 because the function it wants was never created. This
-- table is the record. Every numbered file stamps its own name and the hash of its own
-- text at the end (tools/stamp-sql.mjs writes the hash), so "what is live" and "was it
-- edited after it was pasted" both stop being a memory.
--
-- It has to come first. Everything after it writes into it.

create table if not exists public.migrations (
  name        text primary key,
  applied_at  timestamptz not null default now(),
  hash        text
);
alter table public.migrations enable row level security;

-- The list is only filenames, dates and hashes, so the health check may read it with
-- the public key. Nothing about the content leaks through it.
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

-- Used by every file below to stamp itself: by name alone, or name and hash.
create or replace function public.migration_done(p_name text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.migrations (name) values (p_name)
  on conflict (name) do update set applied_at = now();
$$;
create or replace function public.migration_done(p_name text, p_hash text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.migrations (name, hash) values (p_name, p_hash)
  on conflict (name) do update set applied_at = now(), hash = excluded.hash;
$$;

-- The stamps come from the SQL editor, which runs as the table owner. Postgres hands
-- EXECUTE on a new function to everyone by default, and through the API that would let
-- any visitor forge the log.
revoke execute on function public.migration_done(text) from public, anon, authenticated;
revoke execute on function public.migration_done(text, text) from public, anon, authenticated;

select public.migration_done('00_migrations.sql');


-- ============================================================
--  TABLES — cities, projects, people, joins, friendships, contributions, credits, passports   (01_schema.sql)
-- ============================================================

-- pasaport — the tables
-- Run them in order: 01 → 02 → 03 → … Authentication comes from the auth schema
-- Supabase provides; what is here is only the public schema that hangs off it.
--
-- A project is a social-benefit AI job a phone can carry at night: a small model, a
-- number of nights wanted, a number of phones wanted. A person keeps a project (join,
-- the swipe), and on a night the phone checks into it (contribution, 08). Everything
-- hangs off the project and the night; there is nothing that hangs off a person alone.

-- ---------------------------------------------------------------- city
-- Where a project runs and where the phones are: the network tab draws clusters per city.
create table if not exists public.cities (
  id        uuid primary key default gen_random_uuid(),
  slug      text unique not null,
  name      text not null,
  country   text not null,            -- ISO 3166 alpha-2, lower case: de · tr
  lat       double precision not null,
  lng       double precision not null,
  sort_order int not null default 0
);

-- ------------------------------------------------------------- project
create table if not exists public.projects (
  id             uuid primary key default gen_random_uuid(),
  slug           text unique not null,
  title          text not null check (length(btrim(title)) between 1 and 80),
  -- two sentences: what it does and whom it serves. The source; do not break it.
  summary        text not null check (length(btrim(summary)) between 1 and 400),
  -- what the phones run: "3B Q4". params_b is the number the credit weight comes from.
  model          text not null,
  params_b       numeric(5,2) not null check (params_b > 0),
  nights_wanted  int not null check (nights_wanted > 0),
  phones_wanted  int not null check (phones_wanted > 0),
  est_kwh        numeric(8,2) not null default 0,
  est_eur        numeric(8,2) not null default 0,
  -- who runs it (the project_about table carries the longer text, 12)
  org            text not null,
  city_id        uuid references public.cities on delete set null,
  -- the drawn poster on the site (posters/NN.svg) or a photo
  poster_no      int check (poster_no > 0),
  image_url      text,
  status         text not null default 'open' check (status in ('open', 'full', 'done')),
  is_published   boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists projects_city_idx on public.projects (city_id);
create index if not exists projects_published_idx on public.projects (is_published, status);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists projects_touch on public.projects;
create trigger projects_touch before update on public.projects
  for each row execute function public.touch_updated_at();

-- -------------------------------------------------------------- people
-- auth.users stays private (the email lives there); this is the public part.
create table if not exists public.profiles (
  id            uuid primary key references auth.users on delete cascade,
  handle        text unique check (handle is null or handle ~ '^[a-z0-9_]{3,20}$'),
  display_name  text check (display_name is null or length(btrim(display_name)) between 1 and 40),
  bio           text check (bio is null or length(btrim(bio)) between 1 and 160),
  city_id       uuid references public.cities on delete set null,
  is_admin      boolean not null default false,
  -- registration is not finished until a handle is chosen
  onboarded_at  timestamptz,
  last_seen_at  timestamptz,
  terms_version int,
  terms_at      timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists profiles_city_idx on public.profiles (city_id);

-- Yours alone: who may see what, when the phone works, which pushes you want.
create table if not exists public.profile_settings (
  user_id         uuid primary key references public.profiles on delete cascade,
  kept_visibility text not null default 'friends' check (kept_visibility in ('friends', 'private')),
  discoverable    boolean not null default true,
  locale          text not null default 'en' check (locale in ('en', 'de', 'tr')),
  -- the night window on this account (the phone keeps its own copy, data/settings.ts)
  night_from      time not null default '23:00',
  night_to        time not null default '07:30',
  wifi_only       boolean not null default true,
  notify_friends  boolean not null default true,
  notify_calls    boolean not null default true,
  notify_coops    boolean not null default true,
  notify_dms      boolean not null default true,
  notify_cards    boolean not null default true,
  updated_at      timestamptz not null default now()
);
drop trigger if exists settings_touch on public.profile_settings;
create trigger settings_touch before update on public.profile_settings
  for each row execute function public.touch_updated_at();

-- Signing up: the profile and the settings row appear by themselves. A handle or city
-- sent by the sign-up form is tried; a taken handle is quietly left empty.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  wanted text := lower(btrim(coalesce(new.raw_user_meta_data ->> 'handle', '')));
  city_in text := lower(btrim(coalesce(new.raw_user_meta_data ->> 'city', '')));
  city_uuid uuid;
begin
  if wanted !~ '^[a-z0-9_]{3,20}$' or exists (select 1 from public.profiles where handle = wanted) then
    wanted := null;
  end if;
  if city_in <> '' then
    select id into city_uuid from public.cities where slug = city_in;
  end if;
  insert into public.profiles (id, display_name, handle, city_id, onboarded_at)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)), wanted, city_uuid,
          case when wanted is null then null else now() end)
  on conflict (id) do nothing;
  insert into public.profile_settings (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end;
$$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- --------------------------------------------------------------- joins
-- Kept projects are not a separate table: they are the swipes going right.
create table if not exists public.joins (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles on delete cascade,
  project_id  uuid not null references public.projects on delete cascade,
  direction   text not null check (direction in ('left', 'right')),
  created_at  timestamptz not null default now(),
  unique (user_id, project_id)
);
create index if not exists joins_project_idx on public.joins (project_id, direction);
create index if not exists joins_user_idx on public.joins (user_id, direction);

-- ---------------------------------------------------------- friendship
create table if not exists public.friendships (
  requester_id  uuid not null references public.profiles on delete cascade,
  addressee_id  uuid not null references public.profiles on delete cascade,
  status        text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at    timestamptz not null default now(),
  primary key (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);
create index if not exists friendships_addressee_idx on public.friendships (addressee_id, status);

-- -------------------------------------------------------- contributions
-- A night: the phone checked into a project while on charge and worked. Written only
-- through contribution_start/contribution_end (08). Every finished row takes a card
-- number from one shared sequence, so NO. 0208 means the 208th card ever issued. A night
-- abandoned (the phone died) is closed without a card and counts for nothing.
create sequence if not exists public.card_no_seq;
create table if not exists public.contributions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles on delete cascade,
  project_id  uuid not null references public.projects on delete cascade,
  -- made on the phone: a retry of the same start finds the first (the outbox, lib/offline.ts)
  client_id   uuid not null,
  card_no     bigint,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  tokens      bigint not null default 0,
  seconds     int not null default 0,
  kwh         numeric(8,4) not null default 0,
  credits     numeric(10,2) not null default 0,
  unique (user_id, client_id)
);
create index if not exists contributions_user_idx on public.contributions (user_id, started_at desc);
create index if not exists contributions_project_idx on public.contributions (project_id, ended_at);

-- The ledger: one line per finished contribution. amount = tokens / 1000 × params_b / 7,
-- so a night on a 7B model earns 1 per thousand tokens and a 1B night a seventh of it.
create table if not exists public.credits (
  id               bigserial primary key,
  user_id          uuid not null references public.profiles on delete cascade,
  contribution_id  uuid not null unique references public.contributions on delete cascade,
  project_id       uuid not null references public.projects on delete cascade,
  weight           numeric(6,4) not null,
  amount           numeric(10,2) not null,
  created_at       timestamptz not null default now()
);
create index if not exists credits_user_idx on public.credits (user_id, created_at desc);

-- ------------------------------------------------------------ passports
-- What the phone measured about itself (passport/0.x, device-passport's passport-core).
-- Every measurement is kept; the newest is "the passport" the night worker reads from.
create table if not exists public.passports (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles on delete cascade,
  client_id    uuid not null,
  data         jsonb not null,
  measured_at  timestamptz not null,
  created_at   timestamptz not null default now(),
  unique (user_id, client_id)
);
create index if not exists passports_user_idx on public.passports (user_id, measured_at desc);

-- Every table is closed (02 opens nothing: the app talks to functions, never tables).
alter table public.cities enable row level security;
alter table public.projects enable row level security;
alter table public.profiles enable row level security;
alter table public.profile_settings enable row level security;
alter table public.joins enable row level security;
alter table public.friendships enable row level security;
alter table public.contributions enable row level security;
alter table public.credits enable row level security;
alter table public.passports enable row level security;
revoke all on public.cities, public.projects, public.profiles, public.profile_settings, public.joins,
              public.friendships, public.contributions, public.credits, public.passports from public, anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('01_schema.sql', 'dc2c5b5b43203c56804b917925a5064a6118e01b8efa56dcb12fe3ce469a66a9');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('01_schema.sql');
  end if;
end $$;


-- ============================================================
--  THE DOOR — who is asking, who may be seen; bans and blocks   (02_doors.sql)
-- ============================================================

-- pasaport — the door: who is asking, who may be seen
-- Two questions every function would otherwise answer in its own words. From here they
-- have one answer each, so a new function cannot forget a case the others remember.
--
--   is_admin()                   the owner's account (the panel)
--   is_banned(user)              a closed account (bans): it reads nothing, writes nothing
--   assert_member()              who is asking: a signed-in account that is not banned,
--                                else an exception (42501). Every read and write asks it
--                                first, in plpgsql, at declaration.
--   are_friends(a, b)            a confirmed friendship, either direction
--   reachable(viewer, other)     no block either way, the other not banned
--   visible_to(viewer, other)    reachable, and a friend or discoverable
--   waves(me)                    everyone within three confirmed steps, with the hops;
--                                a call (10) travels along it
--
-- The tables are closed; these are definer functions and the only way in.

create table if not exists public.bans (
  user_id    uuid primary key references public.profiles on delete cascade,
  reason     text,
  by_user    uuid references public.profiles on delete set null,
  created_at timestamptz not null default now()
);
create table if not exists public.blocks (
  blocker_id  uuid not null references public.profiles on delete cascade,
  blocked_id  uuid not null references public.profiles on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
alter table public.bans enable row level security;
alter table public.blocks enable row level security;
revoke all on public.bans, public.blocks from public, anon, authenticated;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false);
$$;

create or replace function public.is_banned(p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.bans b where b.user_id = p_user);
$$;

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

create or replace function public.need_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  u uuid := public.assert_member();
begin
  if not public.is_admin() then
    raise exception 'admins only' using errcode = '42501';
  end if;
  return u;
end;
$$;

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
      and ((f.requester_id = p_a and f.addressee_id = p_b) or (f.requester_id = p_b and f.addressee_id = p_a)));
$$;

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
                   or coalesce((select s.discoverable from public.profile_settings s where s.user_id = p_other), true))));
$$;

-- Everyone within three confirmed steps of p_me, with the fewest steps it takes; the
-- walk stops where p_me could not reach the person. p_me is not in it.
create or replace function public.waves(p_me uuid)
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
    select b, 1 from f where a = p_me and public.reachable(p_me, b)
    union
    select f.b, w.hops + 1 from walk w join f on f.a = w.person
    where w.hops < 3 and public.reachable(p_me, f.b)
  )
  select w.person, min(w.hops)::int from walk w where w.person <> p_me group by w.person;
$$;

-- The helpers are oracles on somebody's data: callable by the functions, not the API.
revoke execute on function public.is_banned(uuid) from public, anon, authenticated;
revoke execute on function public.are_friends(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.reachable(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.visible_to(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.waves(uuid) from public, anon, authenticated;
revoke execute on function public.need_admin() from public, anon, authenticated;
revoke execute on function public.assert_member() from public, anon;
grant execute on function public.assert_member() to authenticated;
grant execute on function public.is_admin() to anon, authenticated;

-- A banned account writes nothing: the trigger every writable table carries.
create or replace function public.guard_banned()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_banned(auth.uid()) then
    raise exception 'this account is closed' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Nobody may make themselves an admin.
create or replace function public.guard_is_admin()
returns trigger
language plpgsql
as $$
begin
  if new.is_admin is distinct from old.is_admin and auth.uid() is not null and not public.is_admin() then
    raise exception 'is_admin can only be changed by an admin';
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_guard_admin on public.profiles;
create trigger profiles_guard_admin before update on public.profiles
  for each row execute function public.guard_is_admin();

-- ------------------------------------------------------- blocking someone
create or replace function public.block_user(p_other uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  if p_other is null or p_other = me then return false; end if;
  insert into public.blocks (blocker_id, blocked_id) values (me, p_other) on conflict do nothing;
  -- a block ends the friendship and the requests both ways
  delete from public.friendships where (requester_id = me and addressee_id = p_other) or (requester_id = p_other and addressee_id = me);
  return true;
end;
$$;
create or replace function public.unblock_user(p_other uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  delete from public.blocks where blocker_id = me and blocked_id = p_other;
  return found;
end;
$$;
create or replace function public.my_blocks()
returns table (id uuid, handle text, display_name text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  select p.id, p.handle, p.display_name, b.created_at
  from public.blocks b join public.profiles p on p.id = b.blocked_id
  where b.blocker_id = me order by b.created_at desc;
end;
$$;
revoke execute on function public.block_user(uuid), public.unblock_user(uuid), public.my_blocks() from public, anon;
grant execute on function public.block_user(uuid), public.unblock_user(uuid), public.my_blocks() to authenticated;

-- ---------------------------------------------------------- the staff ban
create or replace function public.staff_ban(p_user uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.need_admin();
begin
  if p_user = me then raise exception 'not yourself'; end if;
  insert into public.bans (user_id, reason, by_user) values (p_user, p_reason, me)
  on conflict (user_id) do update set reason = excluded.reason, by_user = me, created_at = now();
end;
$$;
create or replace function public.staff_unban(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_admin();
  delete from public.bans where user_id = p_user;
end;
$$;
-- What the app asks after a refusal: am I closed, and why.
create or replace function public.account_status()
returns table (banned boolean, reason text, at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.bans b where b.user_id = auth.uid()),
         (select b.reason from public.bans b where b.user_id = auth.uid()),
         (select b.created_at from public.bans b where b.user_id = auth.uid());
$$;
revoke execute on function public.staff_ban(uuid, text), public.staff_unban(uuid), public.account_status() from public, anon;
grant execute on function public.staff_ban(uuid, text), public.staff_unban(uuid), public.account_status() to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('02_doors.sql', '80e68d6bc30a89843264cb1357e1d38b23c1b1032d1d59b8d804340e8b2156a0');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('02_doors.sql');
  end if;
end $$;


-- ============================================================
--  TEN PROJECTS — türkiye and germany   (03_seed_projects.sql)
-- ============================================================

-- pasaport — ten projects, hand-entered (no sync; the panel adds more)
-- Türkiye and Germany, each with a sample photo from Unsplash (free licence; swap for the
-- project's own later). Each one: a small model a phone can carry at night, a number
-- of nights, a number of phones, the energy it will take. The numbers are estimates:
-- 4 W per phone per night-hour (the simulated worker uses the same figure), 8.5 h a
-- night, 0.30 € per kWh. Idempotent: a second paste changes nothing (on conflict).

insert into public.cities (slug, name, country, lat, lng, sort_order) values
  ('istanbul', 'istanbul', 'tr', 41.0082, 28.9784, 1),
  ('ankara',   'ankara',   'tr', 39.9334, 32.8597, 2),
  ('izmir',    'izmir',    'tr', 38.4237, 27.1428, 3),
  ('hatay',    'hatay',    'tr', 36.2023, 36.1603, 4),
  ('van',      'van',      'tr', 38.4891, 43.4089, 5),
  ('munchen',  'münchen',  'de', 48.1351, 11.5820, 6),
  ('berlin',   'berlin',   'de', 52.5200, 13.4050, 7),
  ('hamburg',  'hamburg',  'de', 53.5511,  9.9937, 8),
  ('koln',     'köln',     'de', 50.9375,  6.9603, 9),
  ('leipzig',  'leipzig',  'de', 51.3397, 12.3731, 10)
on conflict (slug) do nothing;

insert into public.projects (slug, title, summary, model, params_b, nights_wanted, phones_wanted, est_kwh, est_eur, org, city_id, poster_no, image_url)
select v.slug, v.title, v.summary, v.model, v.params_b, v.nights, v.phones,
       round(v.phones * v.nights * 4 * 8.5 / 1000.0, 2),
       round(v.phones * v.nights * 4 * 8.5 / 1000.0 * 0.30, 2),
       v.org, c.id, v.poster, 'https://images.unsplash.com/photo-' || v.photo || '?w=900&q=80'
from (values
  ('koy-okulu-ogretmen', 'offline teacher for village schools',
   'A Turkish lesson assistant that runs with no internet, for primary schools in villages without a steady connection. Phones at night distil a 3B model into one small enough for a ten-year-old tablet.',
   '3B Q4', 3.0, 12, 400, 'köy okulları derneği', 'van', 1, '1503676260728-1c00da094a0b'),
  ('afet-mesaj-siniflandirma', 'disaster message sorting',
   'Reads the flood of messages after an earthquake and sorts them: trapped, injured, needs water, safe. Trained on the messages of February 2023, anonymised, so the next time the first hour is not lost.',
   '1B Q4', 1.0, 8, 800, 'akut gönüllüleri', 'hatay', 2, '1555099962-4199c345e5dd'),
  ('deprem-sonrasi-ceviri', 'after the earthquake: translation',
   'Turkish ↔ Arabic ↔ Kurdish for rescue teams and families in the first days, when no server is up. A 4B model made to fit on the phones that are already in the ruins.',
   '4B Q4', 4.0, 10, 600, 'sınır tanımayan çevirmenler', 'hatay', 3, '1517245386807-bb43f82c33c4'),
  ('yerel-tarih-arsivi', 'local history archive summaries',
   'Summarises forty years of scanned town newspapers and council minutes into readable entries for the municipal archive. Istanbul first, then the towns that send their boxes.',
   '7B Q4', 7.0, 20, 300, 'istanbul kent arşivi', 'istanbul', 4, '1529070538774-1843cb3265df'),
  ('turkce-ders-asistani', 'turkish lesson assistant',
   'Answers a pupil''s question about the lesson in plain Turkish and asks one back, for the evenings when nobody at home can help. Built on the open curriculum, checked by teachers.',
   '3B Q4', 3.0, 14, 500, 'öğretmen ağı', 'ankara', 5, '1509062522246-3755977927d7'),
  ('isaret-dili-altyazi', 'sign language captions',
   'Turns Turkish sign language on a phone camera into captions for the hearing side of a conversation. The night work is the hard part: aligning thousands of signed sentences.',
   '3B Q4', 3.0, 16, 350, 'işitme engelliler federasyonu', 'izmir', 6, '1573164713988-8665fc963095'),
  ('behoerdenbrief', 'behördenbriefe, einfach',
   'Rewrites a letter from a German office into plain language, in German, Turkish, Arabic or Ukrainian, on the phone, without the letter leaving it. The phones at night tune the model on anonymised letters.',
   '3B Q4', 3.0, 10, 450, 'verein für einfache sprache e.v.', 'berlin', 7, '1484417894907-623942c8ee29'),
  ('pflege-nachtassistent', 'night assistant for carers',
   'For people who look after a parent at home: what to do at three in the morning, in their own language, with the guidelines of the Pflegekasse behind it. Trained on the open care handbooks.',
   '4B Q4', 4.0, 12, 400, 'pflegebegleiter münchen', 'munchen', 8, '1544928147-79a2dbc1f389'),
  ('stadtarchiv-ocr', 'city archive, handwriting to text',
   'Reads the handwritten registers of the Hamburg city archive, 1850 to 1950, into searchable text. Volunteers correct, phones at night learn from the corrections.',
   '1B Q4', 1.0, 24, 700, 'staatsarchiv freunde hamburg', 'hamburg', 9, '1524995997946-a1c2e315a42f'),
  ('jobcenter-dolmetscher', 'interpreter for the jobcenter',
   'A spoken interpreter for appointments at the Jobcenter, German ↔ Turkish ↔ Farsi, that runs on the phone of the person being interviewed. The night work aligns the vocabulary of forms and offices.',
   '7B Q4', 7.0, 18, 300, 'migrantinnen netzwerk köln', 'koln', 10, '1522202176988-66273c2fd55f')
) as v(slug, title, summary, model, params_b, nights, phones, org, city, poster, photo)
left join public.cities c on c.slug = v.city
on conflict (slug) do nothing;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('03_seed_projects.sql', '90d27c5d9d8c413d8c6484986391e6cb9510052b9e0c79d6f642a88cc4964997');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('03_seed_projects.sql');
  end if;
end $$;


-- ============================================================
--  PEOPLE — the card, the settings, the search, leaving   (04_profiles.sql)
-- ============================================================

-- pasaport — people: the card, the settings, the search, leaving
--
--   handle_status(handle)                   ok · empty · format · taken · yours
--   profile_setup(handle, name, city, bio)  finishes sign-up; 'ok' or the reason
--   profile_me()                            your own card, counts and settings in one read
--   settings_set(jsonb)                     the settings a person may change about themselves
--   profile_card(handle)                    somebody's card, as much as they allow
--   people_search(q, limit)                 by handle or name, discoverable people only
--   people_suggested(limit)                 friends of friends first, then your city
--   seen()                                  stamps last_seen_at (friends see the day only)
--   export_me()                             everything about you, as one json
--   delete_account()                        really deletes; cascades take the rest
--
-- The tables are closed; every call is definer and asks the door first.

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
    when lower(btrim(p_handle)) in ('admin', 'pasaport', 'support', 'staff', 'help') then 'taken'
    when exists (select 1 from public.profiles where handle = lower(btrim(p_handle)) and id = auth.uid()) then 'yours'
    when exists (select 1 from public.profiles where handle = lower(btrim(p_handle))) then 'taken'
    else 'ok'
  end;
$$;
grant execute on function public.handle_status(text) to anon, authenticated;

create or replace function public.profile_setup(p_handle text, p_display_name text default null, p_city_slug text default null, p_bio text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  state text := public.handle_status(p_handle);
  city_uuid uuid;
begin
  if state not in ('ok', 'yours') then return state; end if;
  if coalesce(btrim(p_city_slug), '') <> '' then
    select id into city_uuid from public.cities where slug = lower(btrim(p_city_slug));
    if city_uuid is null then return 'nocity'; end if;
  end if;
  update public.profiles set
    handle = lower(btrim(p_handle)),
    display_name = coalesce(nullif(btrim(p_display_name), ''), display_name),
    city_id = coalesce(city_uuid, city_id),
    bio = case when p_bio is null then bio else nullif(btrim(p_bio), '') end,
    onboarded_at = coalesce(onboarded_at, now())
  where id = me;
  insert into public.profile_settings (user_id) values (me) on conflict (user_id) do nothing;
  return 'ok';
end;
$$;

drop function if exists public.profile_me();
create or replace function public.profile_me()
returns table (
  id uuid, handle text, display_name text, bio text, city_slug text, city_name text,
  is_admin boolean, onboarded boolean, created_at timestamptz,
  kept_count int, friend_count int, night_count int, credits numeric,
  kept_visibility text, discoverable boolean, locale text,
  night_from text, night_to text, wifi_only boolean,
  notify_friends boolean, notify_calls boolean, notify_coops boolean, notify_dms boolean, notify_cards boolean
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
  select p.id, p.handle, p.display_name, p.bio, c.slug, c.name,
         p.is_admin, p.onboarded_at is not null, p.created_at,
         (select count(*)::int from public.joins j where j.user_id = p.id and j.direction = 'right'),
         (select count(*)::int from public.friendships f where f.status = 'accepted' and p.id in (f.requester_id, f.addressee_id)),
         (select count(*)::int from public.contributions k where k.user_id = p.id and k.card_no is not null),
         coalesce((select sum(k.amount) from public.credits k where k.user_id = p.id), 0),
         s.kept_visibility, s.discoverable, s.locale,
         to_char(s.night_from, 'HH24:MI'), to_char(s.night_to, 'HH24:MI'), s.wifi_only,
         s.notify_friends, s.notify_calls, s.notify_coops, s.notify_dms, s.notify_cards
  from public.profiles p
  left join public.cities c on c.id = p.city_id
  join public.profile_settings s on s.user_id = p.id
  where p.id = me;
end;
$$;

-- The settings a person may change, as one object with only the keys they send.
create or replace function public.settings_set(p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  update public.profile_settings s set
    kept_visibility = coalesce(p_patch ->> 'kept_visibility', s.kept_visibility),
    discoverable = coalesce((p_patch ->> 'discoverable')::boolean, s.discoverable),
    locale = coalesce(p_patch ->> 'locale', s.locale),
    night_from = coalesce((p_patch ->> 'night_from')::time, s.night_from),
    night_to = coalesce((p_patch ->> 'night_to')::time, s.night_to),
    wifi_only = coalesce((p_patch ->> 'wifi_only')::boolean, s.wifi_only),
    notify_friends = coalesce((p_patch ->> 'notify_friends')::boolean, s.notify_friends),
    notify_calls = coalesce((p_patch ->> 'notify_calls')::boolean, s.notify_calls),
    notify_coops = coalesce((p_patch ->> 'notify_coops')::boolean, s.notify_coops),
    notify_dms = coalesce((p_patch ->> 'notify_dms')::boolean, s.notify_dms),
    notify_cards = coalesce((p_patch ->> 'notify_cards')::boolean, s.notify_cards)
  where s.user_id = me;
  if p_patch ? 'display_name' or p_patch ? 'bio' or p_patch ? 'city_slug' then
    update public.profiles p set
      display_name = case when p_patch ? 'display_name' then nullif(btrim(p_patch ->> 'display_name'), '') else p.display_name end,
      bio = case when p_patch ? 'bio' then nullif(btrim(p_patch ->> 'bio'), '') else p.bio end,
      city_id = case when p_patch ? 'city_slug' then (select c.id from public.cities c where c.slug = p_patch ->> 'city_slug') else p.city_id end
    where p.id = me;
  end if;
end;
$$;

-- Identity by handle; the only thing that leaks is whether such a person exists.
create or replace function public.handle_to_id(p_handle text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.profiles where handle = lower(btrim(regexp_replace(coalesce(p_handle, ''), '^@', '')));
$$;
revoke execute on function public.handle_to_id(text) from public, anon, authenticated;

-- friend · outgoing · incoming · none
create or replace function public.people_relation(p_me uuid, p_other uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select case when f.status = 'accepted' then 'friend' when f.requester_id = p_me then 'outgoing' else 'incoming' end
                   from public.friendships f
                   where (f.requester_id = p_me and f.addressee_id = p_other) or (f.addressee_id = p_me and f.requester_id = p_other)
                   limit 1), 'none');
$$;
create or replace function public.people_mutual(p_me uuid, p_other uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  with mine as (select case when f.requester_id = p_me then f.addressee_id else f.requester_id end as id
                from public.friendships f where f.status = 'accepted' and p_me in (f.requester_id, f.addressee_id)),
       theirs as (select case when f.requester_id = p_other then f.addressee_id else f.requester_id end as id
                  from public.friendships f where f.status = 'accepted' and p_other in (f.requester_id, f.addressee_id))
  select count(*)::int from mine join theirs using (id);
$$;
revoke execute on function public.people_relation(uuid, uuid), public.people_mutual(uuid, uuid) from public, anon, authenticated;

-- Somebody's card: the number of nights and projects only to the person and to friends.
drop function if exists public.profile_card(text);
create or replace function public.profile_card(p_handle text)
returns table (id uuid, handle text, display_name text, bio text, city_name text, created_at timestamptz,
               last_seen_day date, relation text, mutual int, kept_count int, night_count int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  select p.id, p.handle, p.display_name, p.bio, c.name, p.created_at,
         case when p.id = me or public.are_friends(me, p.id) then p.last_seen_at::date end,
         public.people_relation(me, p.id), public.people_mutual(me, p.id),
         case when p.id = me or (public.are_friends(me, p.id) and coalesce(s.kept_visibility, 'friends') = 'friends')
              then (select count(*)::int from public.joins j where j.user_id = p.id and j.direction = 'right') end,
         case when p.id = me or public.are_friends(me, p.id)
              then (select count(*)::int from public.contributions k where k.user_id = p.id and k.card_no is not null) end
  from public.profiles p
  left join public.cities c on c.id = p.city_id
  left join public.profile_settings s on s.user_id = p.id
  where p.handle = lower(btrim(regexp_replace(coalesce(p_handle, ''), '^@', '')))
    and public.visible_to(me, p.id);
end;
$$;

create or replace function public.people_search(p_query text, p_limit int default 12)
returns table (id uuid, handle text, display_name text, city_name text, mutual int, relation text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  q text := lower(btrim(regexp_replace(coalesce(p_query, ''), '^@', '')));
  safe text;
begin
  if length(q) < 2 then return; end if;
  safe := replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_');
  return query
  select p.id, p.handle, p.display_name, c.name, public.people_mutual(me, p.id), public.people_relation(me, p.id)
  from public.profiles p left join public.cities c on c.id = p.city_id
  where p.handle is not null and p.id <> me and public.visible_to(me, p.id)
    and (p.handle like safe || '%' or lower(coalesce(p.display_name, '')) like '%' || safe || '%')
  order by (p.handle = q) desc, (p.handle like safe || '%') desc, public.people_mutual(me, p.id) desc, p.handle
  limit least(greatest(coalesce(p_limit, 12), 1), 20);
end;
$$;

create or replace function public.people_suggested(p_limit int default 3)
returns table (id uuid, handle text, display_name text, city_name text, mutual int, reason text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  with mine as (select p.city_id from public.profiles p where p.id = me),
  pool as (
    select p.id, p.handle, p.display_name, c.name as city_name, public.people_mutual(me, p.id) as mutual,
           (p.city_id is not null and p.city_id = (select city_id from mine)) as same_city, p.last_seen_at
    from public.profiles p left join public.cities c on c.id = p.city_id
    where p.handle is not null and p.id <> me
      and public.people_relation(me, p.id) = 'none' and public.visible_to(me, p.id))
  select pool.id, pool.handle, pool.display_name, pool.city_name, pool.mutual,
         case when pool.mutual > 0 then 'mutual' when pool.same_city then 'city' else 'new' end
  from pool order by pool.mutual desc, pool.same_city desc, pool.last_seen_at desc nulls last, pool.handle
  limit least(greatest(coalesce(p_limit, 3), 1), 12);
end;
$$;

create or replace function public.seen()
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles set last_seen_at = now() where id = public.assert_member();
$$;

-- Everything about you, as one document (the settings page's "download my data").
-- Later files add their own tables to it by replacing this function.
create or replace function public.export_me()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) - 'is_admin' from public.profiles p where p.id = me),
    'settings', (select to_jsonb(s) from public.profile_settings s where s.user_id = me),
    'joins', (select coalesce(jsonb_agg(jsonb_build_object('project', r.slug, 'direction', j.direction, 'at', j.created_at)), '[]')
              from public.joins j join public.projects r on r.id = j.project_id where j.user_id = me),
    'friends', (select coalesce(jsonb_agg(jsonb_build_object('handle', p.handle, 'status', f.status)), '[]')
                from public.friendships f join public.profiles p on p.id = case when f.requester_id = me then f.addressee_id else f.requester_id end
                where me in (f.requester_id, f.addressee_id)));
end;
$$;

create or replace function public.delete_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'sign in first' using errcode = '42501'; end if;
  delete from auth.users where id = me;
end;
$$;

revoke execute on function public.profile_setup(text, text, text, text), public.profile_me(), public.settings_set(jsonb),
  public.profile_card(text), public.people_search(text, int), public.people_suggested(int), public.seen(),
  public.export_me(), public.delete_account() from public, anon;
grant execute on function public.profile_setup(text, text, text, text), public.profile_me(), public.settings_set(jsonb),
  public.profile_card(text), public.people_search(text, int), public.people_suggested(int), public.seen(),
  public.export_me(), public.delete_account() to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('04_profiles.sql', 'ad02589384204ad99c6dab18bd3290c004b725f8d5e7b3de30c64d63d11d701b');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('04_profiles.sql');
  end if;
end $$;


-- ============================================================
--  FRIENDSHIP   (05_friends.sql)
-- ============================================================

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


-- ============================================================
--  THE DECK — keep, let go, the project page   (06_deck.sql)
-- ============================================================

-- pasaport — the deck, the keep, the project page
--   deck(country, limit)       published, open projects you have not swiped; a guest sees all
--   join_set(slug, direction)  keep (right) or let go (left); swiping again overwrites
--   join_unset(slug)           undo: the card comes back
--   joins_reset()              every swipe of yours goes
--   kept()                     what you kept, newest first
--   friends_kept(limit)        what your friends kept (friends who allow it)
--   project_page(slug)         one project with its numbers: phones in, nights done so far
--   project_counts()           per project: how many keep it (the number, never who)
-- One row shape, projects_public, for all of them: flat columns, the same in every REST version.

drop view if exists public.projects_public cascade;
create view public.projects_public as
select p.id, p.slug, p.title, p.summary, p.model, p.params_b, p.nights_wanted, p.phones_wanted,
       p.est_kwh, p.est_eur, p.org, p.poster_no, p.image_url, p.status, p.created_at,
       c.slug as city_slug, c.name as city_name, c.country, c.lat, c.lng
from public.projects p left join public.cities c on c.id = p.city_id
where p.is_published;
revoke all on public.projects_public from public, anon, authenticated;

drop function if exists public.deck(text, int);
create or replace function public.deck(p_country text default null, p_limit int default 40)
returns setof public.projects_public
language sql
stable
security definer
set search_path = public
as $$
  select e.* from public.projects_public e
  where e.status = 'open'
    and (p_country is null or e.country = p_country)
    and not exists (select 1 from public.joins j where j.project_id = e.id and j.user_id = auth.uid())
  order by e.created_at, e.poster_no
  limit least(greatest(coalesce(p_limit, 40), 1), 200);
$$;
grant execute on function public.deck(text, int) to anon, authenticated;

create or replace function public.join_set(p_slug text, p_direction text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  pid uuid;
begin
  if p_direction not in ('left', 'right') then raise exception 'left or right' using errcode = '22023'; end if;
  select id into pid from public.projects where slug = p_slug and is_published;
  if pid is null then raise exception 'no such project' using errcode = '22023'; end if;
  insert into public.joins (user_id, project_id, direction) values (me, pid, p_direction)
  on conflict (user_id, project_id) do update set direction = excluded.direction, created_at = now();
end;
$$;
create or replace function public.join_unset(p_slug text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  delete from public.joins j using public.projects p where p.id = j.project_id and p.slug = p_slug and j.user_id = me;
end;
$$;
create or replace function public.joins_reset()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  n int;
begin
  with gone as (delete from public.joins where user_id = me returning 1) select count(*)::int into n from gone;
  return n;
end;
$$;

drop function if exists public.kept();
create or replace function public.kept()
returns setof public.projects_public
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  select e.* from public.joins j join public.projects_public e on e.id = j.project_id
  where j.user_id = me and j.direction = 'right' order by j.created_at desc;
end;
$$;

drop function if exists public.friends_kept(int);
create or replace function public.friends_kept(p_limit int default 60)
returns table (friend text, friend_id uuid, kept_at timestamptz, id uuid, slug text, title text, model text, city_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  select coalesce(p.handle, p.display_name), p.id, j.created_at, e.id, e.slug, e.title, e.model, e.city_name
  from public.joins j
  join public.projects_public e on e.id = j.project_id
  join public.profiles p on p.id = j.user_id
  left join public.profile_settings s on s.user_id = p.id
  where j.direction = 'right' and j.user_id <> me
    and public.are_friends(me, j.user_id) and public.reachable(me, j.user_id)
    and coalesce(s.kept_visibility, 'friends') = 'friends'
  order by j.created_at desc
  limit least(greatest(coalesce(p_limit, 60), 1), 200);
end;
$$;

-- One project and its numbers. A guest may read it (the site's share link opens here).
drop function if exists public.project_page(text);
create or replace function public.project_page(p_slug text)
returns table (id uuid, slug text, title text, summary text, model text, params_b numeric, nights_wanted int, phones_wanted int,
               est_kwh numeric, est_eur numeric, org text, poster_no int, image_url text, status text,
               city_slug text, city_name text, country text, lat double precision, lng double precision,
               phones_in int, nights_done int, tokens bigint, kept boolean, friends text[])
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.slug, e.title, e.summary, e.model, e.params_b, e.nights_wanted, e.phones_wanted,
         e.est_kwh, e.est_eur, e.org, e.poster_no, e.image_url, e.status,
         e.city_slug, e.city_name, e.country, e.lat, e.lng,
         (select count(*)::int from public.joins j where j.project_id = e.id and j.direction = 'right'),
         (select count(*)::int from public.contributions k where k.project_id = e.id and k.card_no is not null),
         coalesce((select sum(k.tokens) from public.contributions k where k.project_id = e.id), 0)::bigint,
         exists (select 1 from public.joins j where j.project_id = e.id and j.user_id = auth.uid() and j.direction = 'right'),
         coalesce((select array_agg(coalesce(p.handle, p.display_name) order by j.created_at desc)
                   from public.joins j join public.profiles p on p.id = j.user_id
                   left join public.profile_settings s on s.user_id = p.id
                   where j.project_id = e.id and j.direction = 'right' and j.user_id <> auth.uid()
                     and auth.uid() is not null and public.are_friends(auth.uid(), j.user_id)
                     and coalesce(s.kept_visibility, 'friends') = 'friends'), '{}')
  from public.projects_public e where e.slug = p_slug;
$$;
grant execute on function public.project_page(text) to anon, authenticated;

drop function if exists public.project_counts();
create or replace function public.project_counts()
returns table (project_id uuid, n int)
language sql
stable
security definer
set search_path = public
as $$
  select j.project_id, count(*)::int from public.joins j where j.direction = 'right' group by j.project_id;
$$;
grant execute on function public.project_counts() to anon, authenticated;

revoke execute on function public.join_set(text, text), public.join_unset(text), public.joins_reset(), public.kept(), public.friends_kept(int) from public, anon;
grant execute on function public.join_set(text, text), public.join_unset(text), public.joins_reset(), public.kept(), public.friends_kept(int) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('06_deck.sql', '737310bfc894c73c9685295f9c8673c7a9b1c4ec5b74449f43d5ee49ac4db978');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('06_deck.sql');
  end if;
end $$;


-- ============================================================
--  THE DEVICE PASSPORT — and the network clusters   (07_passports.sql)
-- ============================================================

-- pasaport — the device passport, on the server
--   passport_save(data, client_id)   the phone's measurement (passport/0.x); a retry with the
--                                    same client_id finds the first and changes nothing.
--                                    Every one is kept (21.10.2026: every test is recorded;
--                                    16_devices.sql reads them all for the device catalog).
--   passport_mine(limit)             your measurements, newest first (at most 200 a call)
--   passport_last()                  the newest one, what the night worker reads
--   network_nodes()                  the network tab: per city, how many phones measured in
--                                    the last 30 days and the sum of their rough tokens/s;
--                                    per project, where its phones are. Numbers only.
-- The data stays what the phone sent (schema, device, soc, ram, cores, bandwidth, gflops,
-- storage, battery, largest_model_q4, est_tps, measured_at); the server checks the shape
-- and the one field it relies on, est_tps.

create or replace function public.passport_save(p_data jsonb, p_client_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  found_id uuid;
  at timestamptz;
begin
  select id into found_id from public.passports where user_id = me and client_id = p_client_id;
  if found_id is not null then return found_id; end if;
  if coalesce(p_data ->> 'schema', '') !~ '^passport/0\.' then raise exception 'unknown passport schema' using errcode = '22023'; end if;
  if (p_data ->> 'est_tps') is null or (p_data ->> 'est_tps')::numeric < 0 then raise exception 'est_tps missing' using errcode = '22023'; end if;
  at := least(coalesce((p_data ->> 'measured_at')::timestamptz, now()), now());
  insert into public.passports (user_id, client_id, data, measured_at) values (me, p_client_id, p_data, at) returning id into found_id;
  return found_id;
end;
$$;

create or replace function public.passport_mine(p_limit int default 10)
returns table (id uuid, data jsonb, measured_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query select p.id, p.data, p.measured_at from public.passports p where p.user_id = me
  order by p.measured_at desc limit least(greatest(coalesce(p_limit, 10), 1), 200);
end;
$$;

create or replace function public.passport_last()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select p.data from public.passports p where p.user_id = public.assert_member() order by p.measured_at desc limit 1;
$$;

-- The clusters: a city, how many phones, their summed rough speed, and the projects that
-- run there (those the phones of that city keep). Anyone may read it: counts, never who.
drop function if exists public.network_nodes();
create or replace function public.network_nodes()
returns table (city_slug text, city_name text, country text, lat double precision, lng double precision,
               phones int, tps numeric, nights int, projects text[])
language sql
stable
security definer
set search_path = public
as $$
  with last as (
    select distinct on (p.user_id) p.user_id, p.data from public.passports p
    where p.measured_at > now() - interval '30 days' order by p.user_id, p.measured_at desc)
  select c.slug, c.name, c.country, c.lat, c.lng,
         (select count(*)::int from last l join public.profiles pr on pr.id = l.user_id where pr.city_id = c.id),
         coalesce((select round(sum((l.data ->> 'est_tps')::numeric), 1) from last l join public.profiles pr on pr.id = l.user_id where pr.city_id = c.id), 0),
         (select count(*)::int from public.contributions k join public.profiles pr on pr.id = k.user_id
           where pr.city_id = c.id and k.card_no is not null and k.ended_at > now() - interval '30 days'),
         coalesce((select array_agg(distinct r.slug) from public.joins j join public.profiles pr on pr.id = j.user_id
                   join public.projects r on r.id = j.project_id
                   where pr.city_id = c.id and j.direction = 'right' and r.is_published), '{}')
  from public.cities c order by c.sort_order;
$$;
grant execute on function public.network_nodes() to anon, authenticated;

revoke execute on function public.passport_save(jsonb, uuid), public.passport_mine(int), public.passport_last() from public, anon;
grant execute on function public.passport_save(jsonb, uuid), public.passport_mine(int), public.passport_last() to authenticated;

-- the export carries the passports too
create or replace function public.export_me()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) - 'is_admin' from public.profiles p where p.id = me),
    'settings', (select to_jsonb(s) from public.profile_settings s where s.user_id = me),
    'joins', (select coalesce(jsonb_agg(jsonb_build_object('project', r.slug, 'direction', j.direction, 'at', j.created_at)), '[]')
              from public.joins j join public.projects r on r.id = j.project_id where j.user_id = me),
    'friends', (select coalesce(jsonb_agg(jsonb_build_object('handle', p.handle, 'status', f.status)), '[]')
                from public.friendships f join public.profiles p on p.id = case when f.requester_id = me then f.addressee_id else f.requester_id end
                where me in (f.requester_id, f.addressee_id)),
    'passports', (select coalesce(jsonb_agg(p.data order by p.measured_at desc), '[]') from public.passports p where p.user_id = me));
end;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('07_passports.sql', 'ee32d493d83dd98215578882eee5b83f8b07d029c9d442192496991b20e454a0');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('07_passports.sql');
  end if;
end $$;


-- ============================================================
--  THE NIGHT — check-in, the card, the credits   (08_contributions.sql)
-- ============================================================

-- pasaport — the night: check-in, the card, the credits
--   contribution_start(slug, client_id, at)        the phone is on charge and starts the
--                                                  night on a kept project; returns the id.
--                                                  A retry with the same client_id returns
--                                                  the first. One open night per person.
--   contribution_end(id, tokens, seconds, kwh, at) the morning: the numbers, the card number,
--                                                  the credit line. Ending twice changes nothing.
--   contribution_open()                            the night still running, if any
--   my_cards()                                     your cards, newest first, with the project
--   person_cards(handle)                           a friend's cards
--   credits_mine()                                 the ledger and the total
--   friends_live()                                 which friends are in a night right now
-- The credit: tokens / 1000 × params_b / 7. 4 W is the assumption the phone also uses;
-- the server trusts the phone's kwh and seconds but caps tokens at est_tps × seconds × 1.5
-- when there is a passport to compare with, so a wrong clock cannot mint credits.

create or replace function public.contribution_start(p_slug text, p_client_id uuid, p_at timestamptz default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  pid uuid;
  cid uuid;
  at timestamptz := least(coalesce(p_at, now()), now());
begin
  select id into cid from public.contributions where user_id = me and client_id = p_client_id;
  if cid is not null then return cid; end if;
  select r.id into pid from public.projects r where r.slug = p_slug and r.is_published and r.status = 'open';
  if pid is null then raise exception 'noproject' using errcode = '22023'; end if;
  if not exists (select 1 from public.joins j where j.user_id = me and j.project_id = pid and j.direction = 'right') then
    raise exception 'notkept' using errcode = '22023';
  end if;
  if at < now() - interval '12 hours' then at := now(); end if;
  -- a night left open is closed with what it had (the phone died, the app was killed)
  update public.contributions set ended_at = started_at where user_id = me and ended_at is null;
  insert into public.contributions (user_id, project_id, client_id, started_at) values (me, pid, p_client_id, at) returning id into cid;
  return cid;
end;
$$;

create or replace function public.contribution_end(p_id uuid, p_tokens bigint, p_seconds int, p_kwh numeric, p_at timestamptz default null)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  k public.contributions%rowtype;
  tps numeric;
  cap bigint;
  w numeric;
  amount numeric;
  at timestamptz := least(coalesce(p_at, now()), now());
begin
  select * into k from public.contributions where id = p_id and user_id = me;
  if k.id is null then raise exception 'nonight' using errcode = '22023'; end if;
  if k.ended_at is not null then return k.card_no; end if;
  if at < k.started_at then at := now(); end if;
  tps := (select (p.data ->> 'est_tps')::numeric from public.passports p where p.user_id = me order by p.measured_at desc limit 1);
  cap := case when tps is null or tps <= 0 then greatest(coalesce(p_tokens, 0), 0)
              else least(greatest(coalesce(p_tokens, 0), 0), ceil(tps * greatest(coalesce(p_seconds, 0), 0) * 1.5)::bigint) end;
  select r.params_b / 7 into w from public.projects r where r.id = k.project_id;
  amount := round(cap / 1000.0 * w, 2);
  update public.contributions set ended_at = at, tokens = cap, seconds = greatest(coalesce(p_seconds, 0), 0),
         kwh = greatest(coalesce(p_kwh, 0), 0), credits = amount, card_no = nextval('public.card_no_seq')
   where id = k.id returning card_no into k.card_no;
  insert into public.credits (user_id, contribution_id, project_id, weight, amount) values (me, k.id, k.project_id, round(w, 4), amount)
  on conflict (contribution_id) do nothing;
  return k.card_no;
end;
$$;

drop function if exists public.contribution_open();
create or replace function public.contribution_open()
returns table (id uuid, slug text, title text, model text, started_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query select k.id, r.slug, r.title, r.model, k.started_at
  from public.contributions k join public.projects r on r.id = k.project_id
  where k.user_id = me and k.ended_at is null order by k.started_at desc limit 1;
end;
$$;

-- A card: the night's numbers and the project it was for; crew = friends on the same
-- project that night (first names, up to five), as initials on the back of the card.
drop function if exists public.cards_of(uuid, uuid);
create or replace function public.cards_of(p_viewer uuid, p_who uuid)
returns table (card_no bigint, started_at timestamptz, ended_at timestamptz, tokens bigint, seconds int, kwh numeric, credits numeric,
               slug text, title text, model text, org text, city_name text, poster_no int, image_url text,
               night_no int, crew text[], crew_more int)
language sql
stable
security definer
set search_path = public
as $$
  select k.card_no, k.started_at, k.ended_at, k.tokens, k.seconds, k.kwh, k.credits,
         r.slug, r.title, r.model, r.org, c.name, r.poster_no, r.image_url,
         (select count(*)::int from public.contributions x where x.user_id = p_who and x.project_id = k.project_id and x.card_no is not null and x.ended_at <= k.ended_at),
         coalesce((select array_agg(n order by n) from (
            select coalesce(p.handle, p.display_name) n from public.contributions o join public.profiles p on p.id = o.user_id
            where o.project_id = k.project_id and o.card_no is not null and o.user_id <> p_who
              and o.started_at::date = k.started_at::date and public.are_friends(p_viewer, o.user_id) and public.reachable(p_viewer, o.user_id)
            limit 5) s), '{}'),
         greatest(0, (select count(*)::int from public.contributions o
            where o.project_id = k.project_id and o.card_no is not null and o.user_id <> p_who and o.started_at::date = k.started_at::date) - 5)
  from public.contributions k join public.projects r on r.id = k.project_id left join public.cities c on c.id = r.city_id
  where k.user_id = p_who and k.card_no is not null
  order by k.ended_at desc;
$$;
revoke execute on function public.cards_of(uuid, uuid) from public, anon, authenticated;

drop function if exists public.my_cards();
create or replace function public.my_cards()
returns table (card_no bigint, started_at timestamptz, ended_at timestamptz, tokens bigint, seconds int, kwh numeric, credits numeric,
               slug text, title text, model text, org text, city_name text, poster_no int, image_url text,
               night_no int, crew text[], crew_more int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query select * from public.cards_of(me, me);
end;
$$;

drop function if exists public.person_cards(text);
create or replace function public.person_cards(p_handle text)
returns table (card_no bigint, started_at timestamptz, ended_at timestamptz, tokens bigint, seconds int, kwh numeric, credits numeric,
               slug text, title text, model text, org text, city_name text, poster_no int, image_url text,
               night_no int, crew text[], crew_more int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  who uuid := public.handle_to_id(p_handle);
begin
  if who is null or not public.are_friends(me, who) or not public.reachable(me, who) then return; end if;
  return query select * from public.cards_of(me, who);
end;
$$;

drop function if exists public.credits_mine();
create or replace function public.credits_mine()
returns table (id bigint, amount numeric, weight numeric, slug text, title text, card_no bigint, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query select c.id, c.amount, c.weight, r.slug, r.title, k.card_no, c.created_at
  from public.credits c join public.projects r on r.id = c.project_id join public.contributions k on k.id = c.contribution_id
  where c.user_id = me order by c.created_at desc;
end;
$$;

drop function if exists public.friends_live();
create or replace function public.friends_live()
returns table (handle text, display_name text, slug text, title text, started_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query select p.handle, p.display_name, r.slug, r.title, k.started_at
  from public.contributions k join public.profiles p on p.id = k.user_id join public.projects r on r.id = k.project_id
  where k.ended_at is null and k.started_at > now() - interval '14 hours'
    and public.are_friends(me, k.user_id) and public.reachable(me, k.user_id)
  order by k.started_at desc;
end;
$$;

revoke execute on function public.contribution_start(text, uuid, timestamptz), public.contribution_end(uuid, bigint, int, numeric, timestamptz),
  public.contribution_open(), public.my_cards(), public.person_cards(text), public.credits_mine(), public.friends_live() from public, anon;
grant execute on function public.contribution_start(text, uuid, timestamptz), public.contribution_end(uuid, bigint, int, numeric, timestamptz),
  public.contribution_open(), public.my_cards(), public.person_cards(text), public.credits_mine(), public.friends_live() to authenticated;

create or replace function public.export_me()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) - 'is_admin' from public.profiles p where p.id = me),
    'settings', (select to_jsonb(s) from public.profile_settings s where s.user_id = me),
    'joins', (select coalesce(jsonb_agg(jsonb_build_object('project', r.slug, 'direction', j.direction, 'at', j.created_at)), '[]')
              from public.joins j join public.projects r on r.id = j.project_id where j.user_id = me),
    'friends', (select coalesce(jsonb_agg(jsonb_build_object('handle', p.handle, 'status', f.status)), '[]')
                from public.friendships f join public.profiles p on p.id = case when f.requester_id = me then f.addressee_id else f.requester_id end
                where me in (f.requester_id, f.addressee_id)),
    'passports', (select coalesce(jsonb_agg(p.data order by p.measured_at desc), '[]') from public.passports p where p.user_id = me),
    'nights', (select coalesce(jsonb_agg(jsonb_build_object('project', r.slug, 'card_no', k.card_no, 'started_at', k.started_at, 'ended_at', k.ended_at,
                 'tokens', k.tokens, 'seconds', k.seconds, 'kwh', k.kwh, 'credits', k.credits) order by k.started_at), '[]')
               from public.contributions k join public.projects r on r.id = k.project_id where k.user_id = me));
end;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('08_contributions.sql', '7058a5f9101244e4ab9499c820b5d16b7d2925ab814bcb3f0cc0c54bea3e88fa');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('08_contributions.sql');
  end if;
end $$;


-- ============================================================
--  COOPS — friends who work a night together   (09_coops.sql)
-- ============================================================

-- pasaport — coops: friends who work a night together
-- A coop is a few people (2 to 12) who keep one project together and say "tonight we work
-- on this one". Each phone still does its own night; the coop is the shared decision and
-- the shared count in the morning.
--   coops           name, emoji, colour, who made it
--   coop_members    who is in; the maker is the owner
--   coop_invites    a code for a link or a QR: whoever has it may join (14 days, 20 uses)
--   coop_nights     one row per coop per night (a date) with the project chosen; set by any
--                   member, the last word wins
--   coop_create / coop_update / coop_add / coop_leave / coop_remove / coop_delete
--   coop_invite(id) → code · coop_peek(code) · coop_join(code)
--   coop_get(id)    the coop, its members, tonight's project, last night's numbers
--   my_coops()      yours, with tonight's project
--   coop_night_set(id, date, slug) · coop_nights(id)   the plan and the nights done
-- Members: friends of the one who adds (strangers come in by code). Each call asks first
-- whether you are in the coop.

create table if not exists public.coops (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 40),
  emoji       text not null default '✦' check (length(emoji) between 1 and 8),
  color       text not null default 'red' check (color in ('red', 'gold', 'blue', 'green', 'violet', 'paper')),
  created_by  uuid references public.profiles on delete set null,
  created_at  timestamptz not null default now()
);
create table if not exists public.coop_members (
  coop_id    uuid not null references public.coops on delete cascade,
  user_id    uuid not null references public.profiles on delete cascade,
  role       text not null default 'member' check (role in ('owner', 'member')),
  joined_at  timestamptz not null default now(),
  primary key (coop_id, user_id)
);
create index if not exists coop_members_user_idx on public.coop_members (user_id);
create table if not exists public.coop_invites (
  code        text primary key,
  coop_id     uuid not null references public.coops on delete cascade,
  created_by  uuid references public.profiles on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '14 days',
  uses        int not null default 0,
  max_uses    int not null default 20
);
create table if not exists public.coop_nights (
  coop_id     uuid not null references public.coops on delete cascade,
  night       date not null,
  project_id  uuid not null references public.projects on delete cascade,
  set_by      uuid references public.profiles on delete set null,
  set_at      timestamptz not null default now(),
  primary key (coop_id, night)
);
alter table public.coops enable row level security;
alter table public.coop_members enable row level security;
alter table public.coop_invites enable row level security;
alter table public.coop_nights enable row level security;
revoke all on public.coops, public.coop_members, public.coop_invites, public.coop_nights from public, anon, authenticated;

create or replace function public.in_coop(p_coop uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.coop_members where coop_id = p_coop and user_id = auth.uid());
$$;
create or replace function public.need_coop(p_coop uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  if not public.in_coop(p_coop) then raise exception 'not in this coop' using errcode = '42501'; end if;
  return me;
end;
$$;
revoke execute on function public.in_coop(uuid), public.need_coop(uuid) from public, anon, authenticated;

create or replace function public.coop_check(p_name text, p_emoji text, p_color text)
returns void
language plpgsql
stable
as $$
begin
  if length(btrim(coalesce(p_name, ''))) not between 1 and 40 then raise exception 'name: 1 to 40 characters'; end if;
  if length(coalesce(p_emoji, '✦')) not between 1 and 8 then raise exception 'one emoji'; end if;
  if coalesce(p_color, 'red') not in ('red', 'gold', 'blue', 'green', 'violet', 'paper') then raise exception 'unknown colour'; end if;
end;
$$;

create or replace function public.coop_create(p_name text, p_emoji text, p_color text, p_members uuid[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  g uuid;
  m uuid;
  others uuid[] := array(select x from unnest(coalesce(p_members, '{}')) with ordinality as u(x, i) where x <> me group by x order by min(i));
begin
  perform public.coop_check(p_name, p_emoji, p_color);
  if cardinality(others) > 11 then raise exception 'at most 12 in a coop'; end if;
  if (select count(*) from public.coop_members where user_id = me) >= 30 then raise exception 'at most 30 coops'; end if;
  foreach m in array others loop
    if not public.are_friends(me, m) or not public.reachable(me, m) then raise exception 'only friends can be added; send the others a link'; end if;
  end loop;
  insert into public.coops (name, emoji, color, created_by) values (btrim(p_name), coalesce(p_emoji, '✦'), coalesce(p_color, 'red'), me) returning id into g;
  insert into public.coop_members (coop_id, user_id, role) values (g, me, 'owner');
  insert into public.coop_members (coop_id, user_id, joined_at)
  select g, x, now() + make_interval(secs => i / 1e6) from unnest(others) with ordinality as u(x, i);
  return g;
end;
$$;

create or replace function public.coop_update(p_id uuid, p_name text, p_emoji text, p_color text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_coop(p_id);
  perform public.coop_check(p_name, p_emoji, p_color);
  update public.coops set name = btrim(p_name), emoji = coalesce(p_emoji, '✦'), color = coalesce(p_color, 'red') where id = p_id;
end;
$$;

create or replace function public.coop_add(p_id uuid, p_users uuid[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.need_coop(p_id);
  m uuid;
  n int := 0;
begin
  foreach m in array coalesce(p_users, '{}') loop
    if exists (select 1 from public.coop_members where coop_id = p_id and user_id = m) then continue; end if;
    if not public.are_friends(me, m) or not public.reachable(me, m) then raise exception 'only friends can be added; send the others a link'; end if;
    if (select count(*) from public.coop_members where coop_id = p_id) >= 12 then raise exception 'at most 12 in a coop'; end if;
    insert into public.coop_members (coop_id, user_id) values (p_id, m);
    n := n + 1;
  end loop;
  return n;
end;
$$;

create or replace function public.coop_leave(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.need_coop(p_id);
  was text;
begin
  select role into was from public.coop_members where coop_id = p_id and user_id = me;
  delete from public.coop_members where coop_id = p_id and user_id = me;
  if not exists (select 1 from public.coop_members where coop_id = p_id) then
    delete from public.coops where id = p_id;
  elsif was = 'owner' then
    update public.coop_members set role = 'owner' where coop_id = p_id
      and user_id = (select user_id from public.coop_members where coop_id = p_id order by joined_at, user_id limit 1);
  end if;
end;
$$;

create or replace function public.coop_remove(p_id uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.need_coop(p_id);
begin
  if p_user = me then perform public.coop_leave(p_id); return; end if;
  if not exists (select 1 from public.coop_members where coop_id = p_id and user_id = me and role = 'owner') then
    raise exception 'only the owner' using errcode = '42501';
  end if;
  delete from public.coop_members where coop_id = p_id and user_id = p_user;
end;
$$;

create or replace function public.coop_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.need_coop(p_id);
begin
  if not exists (select 1 from public.coop_members where coop_id = p_id and user_id = me and role = 'owner') then
    raise exception 'only the owner' using errcode = '42501';
  end if;
  delete from public.coops where id = p_id;
end;
$$;

create or replace function public.coop_invite(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.need_coop(p_id);
  c text;
begin
  select code into c from public.coop_invites where coop_id = p_id and expires_at > now() + interval '1 day' and uses < max_uses
  order by created_at desc limit 1;
  if c is not null then return c; end if;
  loop
    c := array_to_string(array(select substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1) from generate_series(1, 8)), '');
    exit when not exists (select 1 from public.coop_invites where code = c);
  end loop;
  insert into public.coop_invites (code, coop_id, created_by) values (c, p_id, me);
  return c;
end;
$$;

drop function if exists public.coop_peek(text);
create or replace function public.coop_peek(p_code text)
returns table (id uuid, name text, emoji text, color text, members int, mine boolean, open boolean)
language sql
stable
security definer
set search_path = public
as $$
  select g.id, g.name, g.emoji, g.color,
         (select count(*)::int from public.coop_members m where m.coop_id = g.id),
         public.in_coop(g.id), i.expires_at > now() and i.uses < i.max_uses
  from public.coop_invites i join public.coops g on g.id = i.coop_id
  where i.code = upper(btrim(p_code)) and public.assert_member() is not null;
$$;

create or replace function public.coop_join(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  i public.coop_invites%rowtype;
begin
  select * into i from public.coop_invites where code = upper(btrim(p_code));
  if i.code is null then raise exception 'no coop with that code'; end if;
  if public.in_coop(i.coop_id) then return i.coop_id; end if;
  if i.expires_at <= now() or i.uses >= i.max_uses then raise exception 'that code is used up; ask for a new one'; end if;
  if (select count(*) from public.coop_members where coop_id = i.coop_id) >= 12 then raise exception 'the coop is full (12)'; end if;
  if (select count(*) from public.coop_members where user_id = me) >= 30 then raise exception 'at most 30 coops'; end if;
  insert into public.coop_members (coop_id, user_id) values (i.coop_id, me);
  update public.coop_invites set uses = uses + 1 where code = i.code;
  return i.coop_id;
end;
$$;

-- Tonight: the date a night belongs to is the evening it starts (before 12:00 counts as
-- the night before), so a plan set at 02:00 still means "tonight".
create or replace function public.night_of(p_at timestamptz default now())
returns date
language sql
stable
as $$
  select (p_at - interval '12 hours')::date;
$$;

create or replace function public.coop_night_set(p_id uuid, p_night date, p_slug text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.need_coop(p_id);
  pid uuid;
begin
  if p_night < public.night_of() then raise exception 'that night has passed'; end if;
  select id into pid from public.projects where slug = p_slug and is_published and status = 'open';
  if pid is null then raise exception 'no such project'; end if;
  insert into public.coop_nights (coop_id, night, project_id, set_by) values (p_id, p_night, pid, me)
  on conflict (coop_id, night) do update set project_id = excluded.project_id, set_by = me, set_at = now();
end;
$$;

-- The plan and the nights done: per night the project, who set it, and the coop's numbers
-- that night (contributions of its members on that project, that date).
drop function if exists public.coop_nights(uuid);
create or replace function public.coop_nights(p_id uuid)
returns table (night date, slug text, title text, model text, set_by text, phones int, tokens bigint, kwh numeric, credits numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_coop(p_id);
  return query
  select n.night, r.slug, r.title, r.model, coalesce(p.handle, p.display_name),
         (select count(*)::int from public.contributions k join public.coop_members m on m.user_id = k.user_id and m.coop_id = p_id
           where k.project_id = n.project_id and k.card_no is not null and public.night_of(k.started_at) = n.night),
         coalesce((select sum(k.tokens) from public.contributions k join public.coop_members m on m.user_id = k.user_id and m.coop_id = p_id
           where k.project_id = n.project_id and k.card_no is not null and public.night_of(k.started_at) = n.night), 0)::bigint,
         coalesce((select sum(k.kwh) from public.contributions k join public.coop_members m on m.user_id = k.user_id and m.coop_id = p_id
           where k.project_id = n.project_id and k.card_no is not null and public.night_of(k.started_at) = n.night), 0),
         coalesce((select sum(k.credits) from public.contributions k join public.coop_members m on m.user_id = k.user_id and m.coop_id = p_id
           where k.project_id = n.project_id and k.card_no is not null and public.night_of(k.started_at) = n.night), 0)
  from public.coop_nights n join public.projects r on r.id = n.project_id left join public.profiles p on p.id = n.set_by
  where n.coop_id = p_id order by n.night desc;
end;
$$;

create or replace function public.coop_get(p_id uuid)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.need_coop(p_id);
begin
  return (
    select json_build_object(
      'id', g.id, 'name', g.name, 'emoji', g.emoji, 'color', g.color, 'me', me,
      'members', (select json_agg(json_build_object('id', p.id, 'handle', p.handle, 'name', p.display_name, 'role', m.role,
                                                    'live', exists (select 1 from public.contributions k where k.user_id = p.id and k.ended_at is null)) order by m.joined_at)
                  from public.coop_members m join public.profiles p on p.id = m.user_id where m.coop_id = g.id),
      'tonight', (select json_build_object('slug', r.slug, 'title', r.title, 'model', r.model)
                  from public.coop_nights n join public.projects r on r.id = n.project_id where n.coop_id = g.id and n.night = public.night_of()),
      'nights', (select count(*)::int from public.coop_nights n where n.coop_id = g.id and n.night < public.night_of()))
    from public.coops g where g.id = p_id);
end;
$$;

drop function if exists public.my_coops();
create or replace function public.my_coops()
returns table (id uuid, name text, emoji text, color text, members int, role text, tonight_slug text, tonight_title text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  select g.id, g.name, g.emoji, g.color, (select count(*)::int from public.coop_members x where x.coop_id = g.id), m.role, r.slug, r.title
  from public.coop_members m join public.coops g on g.id = m.coop_id
  left join public.coop_nights n on n.coop_id = g.id and n.night = public.night_of()
  left join public.projects r on r.id = n.project_id
  where m.user_id = me order by g.created_at desc;
end;
$$;

revoke execute on function public.coop_create(text, text, text, uuid[]), public.coop_update(uuid, text, text, text), public.coop_add(uuid, uuid[]),
  public.coop_leave(uuid), public.coop_remove(uuid, uuid), public.coop_delete(uuid), public.coop_invite(uuid), public.coop_peek(text), public.coop_join(text),
  public.coop_night_set(uuid, date, text), public.coop_nights(uuid), public.coop_get(uuid), public.my_coops() from public, anon;
grant execute on function public.coop_create(text, text, text, uuid[]), public.coop_update(uuid, text, text, text), public.coop_add(uuid, uuid[]),
  public.coop_leave(uuid), public.coop_remove(uuid, uuid), public.coop_delete(uuid), public.coop_invite(uuid), public.coop_peek(text), public.coop_join(text),
  public.coop_night_set(uuid, date, text), public.coop_nights(uuid), public.coop_get(uuid), public.my_coops() to authenticated;
grant execute on function public.night_of(timestamptz) to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('09_coops.sql', 'a848845a985d9dd41c6969653cc020d5ab97647b1697c48bd82613159631c269');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('09_coops.sql');
  end if;
end $$;


-- ============================================================
--  CALLS — a project night that travels in waves   (10_calls.sql)
-- ============================================================

-- pasaport — calls: a friend starts a project night, it travels in waves
-- Nobody is written down in advance: the host picks a project, a night and how far it
-- travels (1 = friends, 2 = and their friends, 3 = one step further); everyone inside the
-- wave finds it on top of their deck and answers with the same swipe (right = in, left =
-- out). An answer row appears the moment someone answers.
--   call_audience()                         how many people each wave holds
--   call_create(slug, night, reach, note)   start one; returns the id
--   call_inbox()                            open calls for you, with the wave the host is in
--   call_answer(call, in|out|waiting)       answer (waiting = undo)
--   call_mine()                             yours, with the answers so far
--   call_cancel(call)                       the host calls it off
--   call_people(call)                       the host, and whoever is in: who said in

create table if not exists public.calls (
  id          uuid primary key default gen_random_uuid(),
  host_id     uuid not null references public.profiles on delete cascade,
  project_id  uuid not null references public.projects on delete cascade,
  night       date not null,
  reach       smallint not null check (reach between 1 and 3),
  note        text check (note is null or length(note) <= 140),
  created_at  timestamptz not null default now()
);
create index if not exists calls_host_idx on public.calls (host_id, night);
create table if not exists public.call_answers (
  call_id      uuid not null references public.calls on delete cascade,
  user_id      uuid not null references public.profiles on delete cascade,
  answer       text not null default 'waiting' check (answer in ('waiting', 'in', 'out')),
  answered_at  timestamptz,
  primary key (call_id, user_id)
);
create index if not exists call_answers_user_idx on public.call_answers (user_id, answer);
alter table public.calls enable row level security;
alter table public.call_answers enable row level security;
revoke all on public.calls, public.call_answers from public, anon, authenticated;

create or replace function public.call_audience()
returns table (wave1 int, wave2 int, wave3 int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query select count(*) filter (where w.hops <= 1)::int, count(*) filter (where w.hops <= 2)::int, count(*)::int from public.waves(me) w;
end;
$$;

create or replace function public.call_create(p_slug text, p_night date, p_reach int, p_note text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  pid uuid;
  new_id uuid;
begin
  if p_night is null or p_night < public.night_of() then raise exception 'that night has passed' using errcode = '22023'; end if;
  if p_reach is null or p_reach not between 1 and 3 then raise exception 'the wave is 1, 2 or 3' using errcode = '22023'; end if;
  select id into pid from public.projects where slug = p_slug and is_published and status = 'open';
  if pid is null then raise exception 'no such project' using errcode = '22023'; end if;
  if (select count(*) from public.calls where host_id = me and night >= public.night_of()) >= 5 then raise exception 'five open calls at most' using errcode = '22023'; end if;
  insert into public.calls (host_id, project_id, night, reach, note) values (me, pid, p_night, p_reach, nullif(btrim(coalesce(p_note, '')), ''))
  returning id into new_id;
  -- the host keeps the project too: a call is a keep
  insert into public.joins (user_id, project_id, direction) values (me, pid, 'right') on conflict (user_id, project_id) do update set direction = 'right';
  return new_id;
end;
$$;

drop function if exists public.call_inbox();
create or replace function public.call_inbox()
returns table (id uuid, slug text, title text, model text, night date, note text, host_handle text, host_name text, going int, wave int, mine text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  with near as (select w.person, w.hops from public.waves(me) w)
  select c.id, r.slug, r.title, r.model, c.night, c.note, p.handle, p.display_name,
         (select count(*)::int from public.call_answers g where g.call_id = c.id and g.answer = 'in'),
         n.hops, coalesce(a.answer, 'waiting')
  from public.calls c
  join public.projects r on r.id = c.project_id
  join public.profiles p on p.id = c.host_id
  join near n on n.person = c.host_id
  left join public.call_answers a on a.call_id = c.id and a.user_id = me
  where c.night >= public.night_of() and n.hops <= c.reach and coalesce(a.answer, 'waiting') = 'waiting'
  order by c.night, c.created_at;
end;
$$;

create or replace function public.call_answer(p_call uuid, p_answer text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  pid uuid;
begin
  if p_answer not in ('in', 'out', 'waiting') then raise exception 'answer is in, out or waiting' using errcode = '22023'; end if;
  select c.project_id into pid from public.calls c join public.waves(me) w on w.person = c.host_id
  where c.id = p_call and w.hops <= c.reach and c.night >= public.night_of();
  if pid is null then raise exception 'no such call' using errcode = '42501'; end if;
  insert into public.call_answers (call_id, user_id, answer, answered_at) values (p_call, me, p_answer, case when p_answer = 'waiting' then null else now() end)
  on conflict (call_id, user_id) do update set answer = excluded.answer, answered_at = excluded.answered_at;
  -- saying in keeps the project: the night can start on it
  if p_answer = 'in' then
    insert into public.joins (user_id, project_id, direction) values (me, pid, 'right') on conflict (user_id, project_id) do update set direction = 'right';
  end if;
end;
$$;

drop function if exists public.call_mine();
create or replace function public.call_mine()
returns table (id uuid, slug text, title text, model text, night date, reach int, note text, going int, not_going int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  select c.id, r.slug, r.title, r.model, c.night, c.reach::int, c.note,
         count(*) filter (where a.answer = 'in')::int, count(*) filter (where a.answer = 'out')::int
  from public.calls c join public.projects r on r.id = c.project_id left join public.call_answers a on a.call_id = c.id
  where c.host_id = me and c.night >= public.night_of() - 1
  group by c.id, r.slug, r.title, r.model order by c.night;
end;
$$;

create or replace function public.call_cancel(p_call uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  delete from public.calls where id = p_call and host_id = me;
  if not found then raise exception 'not yours' using errcode = '42501'; end if;
end;
$$;

-- Who said in: for the host every name; for someone who is in, the names they can see.
drop function if exists public.call_people(uuid);
create or replace function public.call_people(p_call uuid)
returns table (handle text, display_name text, host boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  h uuid;
begin
  select host_id into h from public.calls where id = p_call;
  if h is null then return; end if;
  if h <> me and not exists (select 1 from public.call_answers a where a.call_id = p_call and a.user_id = me and a.answer = 'in') then return; end if;
  return query
  select p.handle, p.display_name, true from public.profiles p where p.id = h and public.reachable(me, h)
  union all
  select p.handle, p.display_name, false from public.call_answers a join public.profiles p on p.id = a.user_id
  where a.call_id = p_call and a.answer = 'in' and a.user_id <> me and public.visible_to(me, a.user_id)
  order by 3 desc, 1;
end;
$$;

revoke execute on function public.call_audience(), public.call_create(text, date, int, text), public.call_inbox(), public.call_answer(uuid, text),
  public.call_mine(), public.call_cancel(uuid), public.call_people(uuid) from public, anon;
grant execute on function public.call_audience(), public.call_create(text, date, int, text), public.call_inbox(), public.call_answer(uuid, text),
  public.call_mine(), public.call_cancel(uuid), public.call_people(uuid) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('10_calls.sql', '0bfb5001f16164e569784c99568bf8ac68e565547eaedf18ced5866fb9605c84');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('10_calls.sql');
  end if;
end $$;


-- ============================================================
--  DIRECT MESSAGES   (11_dms.sql)
-- ============================================================

-- pasaport — direct messages
--   dm_threads                 one row per pair of friends who wrote each other (a < b),
--                              with the last line each side has seen
--   dm_messages                the lines, 1000 characters at most; client_id so a line sent
--                              twice from the outbox is stored once
--   dm_start(handle)           opens (or finds) the thread with a friend you can reach
--   dm_send(thread, body, client_id) · dm_unsay(id)
--   dm_thread(thread, after)   the lines after a given id (0: the last 80), oldest first
--   dm_list()                  your threads, newest first, with the unread count
--   dm_seen(thread, id)        "I have read up to here"
-- Friends only, and only while neither has blocked the other and neither is banned.

create table if not exists public.dm_threads (
  id          uuid primary key default gen_random_uuid(),
  a           uuid not null references public.profiles on delete cascade,
  b           uuid not null references public.profiles on delete cascade,
  created_at  timestamptz not null default now(),
  last_at     timestamptz not null default now(),
  seen_a      bigint not null default 0,
  seen_b      bigint not null default 0,
  check (a < b),
  unique (a, b)
);
create table if not exists public.dm_messages (
  id          bigserial primary key,
  thread_id   uuid not null references public.dm_threads on delete cascade,
  user_id     uuid not null references public.profiles on delete cascade,
  body        text not null check (length(body) between 1 and 1000),
  client_id   uuid,
  created_at  timestamptz not null default now()
);
create index if not exists dm_messages_thread on public.dm_messages (thread_id, id);
create unique index if not exists dm_messages_client_idx on public.dm_messages (user_id, client_id);
alter table public.dm_threads enable row level security;
alter table public.dm_messages enable row level security;
revoke all on public.dm_threads, public.dm_messages from public, anon, authenticated;
drop trigger if exists guard_banned on public.dm_messages;
create trigger guard_banned before insert or update on public.dm_messages for each row execute function public.guard_banned();

create or replace function public.dm_other(p_thread uuid, p_me uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select case when t.a = p_me then t.b when t.b = p_me then t.a end from public.dm_threads t where t.id = p_thread;
$$;
revoke execute on function public.dm_other(uuid, uuid) from public, anon, authenticated;

create or replace function public.dm_start(p_handle text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  other uuid := public.handle_to_id(p_handle);
  t uuid;
begin
  if other is null or other = me then raise exception 'no such person'; end if;
  if not public.are_friends(me, other) then raise exception 'friends only'; end if;
  if not public.reachable(me, other) then raise exception 'no such person'; end if;
  insert into public.dm_threads (a, b) values (least(me, other), greatest(me, other))
  on conflict (a, b) do update set last_at = public.dm_threads.last_at returning id into t;
  return t;
end;
$$;

create or replace function public.dm_send(p_thread uuid, p_body text, p_client_id uuid default null)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  other uuid := public.dm_other(p_thread, me);
  r bigint;
begin
  if p_client_id is not null then
    select id into r from public.dm_messages where user_id = me and client_id = p_client_id;
    if r is not null then return r; end if;
  end if;
  if other is null or not public.are_friends(me, other) or not public.reachable(me, other) then raise exception 'no such conversation'; end if;
  if length(btrim(coalesce(p_body, ''))) not between 1 and 1000 then raise exception '1 to 1000 characters'; end if;
  if (select count(*) from public.dm_messages m where m.user_id = me and m.created_at > now() - interval '1 minute') >= 20 then
    raise exception 'slow down' using errcode = '53400';
  end if;
  insert into public.dm_messages (thread_id, user_id, body, client_id) values (p_thread, me, btrim(p_body), p_client_id) returning id into r;
  update public.dm_threads set last_at = now() where id = p_thread;
  if to_regprocedure('public.push_enqueue(uuid, text, text, jsonb)') is not null then
    perform public.push_enqueue(other, 'dm', format('dm:%s', r), jsonb_build_object('name', public.push_name(me), 'url', '/dm/' || p_thread));
  end if;
  return r;
end;
$$;

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

drop function if exists public.dm_thread(uuid, bigint);
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
    order by m.id desc limit case when p_after = 0 then 80 else 500 end) last order by last.id;
end;
$$;

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
  select t.id, o.id, o.handle, coalesce(o.display_name, o.handle), l.body, l.user_id = me, l.id, t.last_at,
         (select count(*)::int from public.dm_messages u where u.thread_id = t.id and u.user_id <> me
            and u.id > case when t.a = me then t.seen_a else t.seen_b end)
  from public.dm_threads t
  join public.profiles o on o.id = case when t.a = me then t.b else t.a end
  left join lateral (select m.id, m.body, m.user_id from public.dm_messages m where m.thread_id = t.id order by m.id desc limit 1) l on true
  where me in (t.a, t.b) and public.reachable(me, o.id)
  order by t.last_at desc;
end;
$$;

create or replace function public.dm_seen(p_thread uuid, p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  update public.dm_threads
     set seen_a = case when a = me then greatest(seen_a, p_id) else seen_a end,
         seen_b = case when b = me then greatest(seen_b, p_id) else seen_b end
   where id = p_thread and me in (a, b);
end;
$$;

revoke execute on function public.dm_start(text), public.dm_send(uuid, text, uuid), public.dm_unsay(bigint), public.dm_thread(uuid, bigint),
  public.dm_list(), public.dm_seen(uuid, bigint) from public, anon;
grant execute on function public.dm_start(text), public.dm_send(uuid, text, uuid), public.dm_unsay(bigint), public.dm_thread(uuid, bigint),
  public.dm_list(), public.dm_seen(uuid, bigint) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('11_dms.sql', '545884dc84790eadbb55e9d6f6a1324354fb787cdbe9dcca93482e0ee54c3589');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('11_dms.sql');
  end if;
end $$;


-- ============================================================
--  ABOUT A PROJECT — who runs it, what the model says; the panel's projects   (12_about.sql)
-- ============================================================

-- pasaport — about the project: who runs it, and what the model says
--   project_about     a few lines about the institution or person behind a project, per
--                     language (en · de · tr): a kicker, the text, facts, a source link
--   project_samples   three lines of what the model answers, per language: the "sample"
--                     card on the deck (not thirty seconds of sound: three lines of text)
--   about_for(ids, lang)    the texts for the projects in a deck (the language asked, else en)
--   samples_for(ids, lang)  the samples for the projects in a deck
--   staff_about_set / staff_samples_set   the panel writes them
-- Anyone may read them: they are the project's own words, nothing about a person.

create table if not exists public.project_about (
  project_id  uuid not null references public.projects on delete cascade,
  lang        text not null check (lang in ('en', 'de', 'tr')),
  kicker      text,
  who         text not null check (length(who) <= 1200),
  facts       text[] not null default '{}',
  source_url  text,
  updated_at  timestamptz not null default now(),
  primary key (project_id, lang)
);
create table if not exists public.project_samples (
  project_id  uuid not null references public.projects on delete cascade,
  lang        text not null check (lang in ('en', 'de', 'tr')),
  prompt      text not null check (length(prompt) <= 200),
  lines       text[] not null check (cardinality(lines) between 1 and 3),
  updated_at  timestamptz not null default now(),
  primary key (project_id, lang)
);
alter table public.project_about enable row level security;
alter table public.project_samples enable row level security;
revoke all on public.project_about, public.project_samples from public, anon, authenticated;

drop function if exists public.about_for(uuid[], text);
create or replace function public.about_for(p_projects uuid[], p_lang text default 'en')
returns table (project_id uuid, lang text, kicker text, who text, facts text[], source_url text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (a.project_id) a.project_id, a.lang, a.kicker, a.who, a.facts, a.source_url
  from public.project_about a
  where a.project_id = any (p_projects) and a.lang in (coalesce(p_lang, 'en'), 'en')
  order by a.project_id, (a.lang = coalesce(p_lang, 'en')) desc;
$$;
drop function if exists public.samples_for(uuid[], text);
create or replace function public.samples_for(p_projects uuid[], p_lang text default 'en')
returns table (project_id uuid, lang text, prompt text, lines text[])
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (s.project_id) s.project_id, s.lang, s.prompt, s.lines
  from public.project_samples s
  where s.project_id = any (p_projects) and s.lang in (coalesce(p_lang, 'en'), 'en')
  order by s.project_id, (s.lang = coalesce(p_lang, 'en')) desc;
$$;
grant execute on function public.about_for(uuid[], text), public.samples_for(uuid[], text) to anon, authenticated;

create or replace function public.staff_about_set(p_slug text, p_lang text, p_kicker text, p_who text, p_facts text[], p_source_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  pid uuid;
begin
  perform public.need_admin();
  select id into pid from public.projects where slug = p_slug;
  if pid is null then raise exception 'no such project'; end if;
  insert into public.project_about (project_id, lang, kicker, who, facts, source_url) values (pid, p_lang, p_kicker, p_who, coalesce(p_facts, '{}'), p_source_url)
  on conflict (project_id, lang) do update set kicker = excluded.kicker, who = excluded.who, facts = excluded.facts, source_url = excluded.source_url, updated_at = now();
end;
$$;
create or replace function public.staff_samples_set(p_slug text, p_lang text, p_prompt text, p_lines text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  pid uuid;
begin
  perform public.need_admin();
  select id into pid from public.projects where slug = p_slug;
  if pid is null then raise exception 'no such project'; end if;
  insert into public.project_samples (project_id, lang, prompt, lines) values (pid, p_lang, p_prompt, p_lines)
  on conflict (project_id, lang) do update set prompt = excluded.prompt, lines = excluded.lines, updated_at = now();
end;
$$;
revoke execute on function public.staff_about_set(text, text, text, text, text[], text), public.staff_samples_set(text, text, text, text[]) from public, anon;
grant execute on function public.staff_about_set(text, text, text, text, text[], text), public.staff_samples_set(text, text, text, text[]) to authenticated;

-- The panel: projects are entered by hand (no sync). Save makes or changes one by slug.
create or replace function public.staff_project_save(p_slug text, p_title text, p_summary text, p_model text, p_params_b numeric,
  p_nights int, p_phones int, p_org text, p_city text, p_status text default 'open', p_image_url text default null, p_poster_no int default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  cid uuid;
  s text := btrim(regexp_replace(lower(btrim(coalesce(p_slug, ''))), '[^a-z0-9]+', '-', 'g'), '-');
begin
  perform public.need_admin();
  if s !~ '^[a-z0-9-]{3,60}$' then raise exception 'slug: letters, digits, dashes'; end if;
  if p_city is not null then
    select id into cid from public.cities where cities.slug = p_city;
    if cid is null then raise exception 'unknown city'; end if;
  end if;
  insert into public.projects (slug, title, summary, model, params_b, nights_wanted, phones_wanted, est_kwh, est_eur, org, city_id, status, image_url, poster_no)
  values (s, btrim(p_title), btrim(p_summary), p_model, p_params_b, p_nights, p_phones,
          round(p_phones * p_nights * 4 * 8.5 / 1000.0, 2), round(p_phones * p_nights * 4 * 8.5 / 1000.0 * 0.30, 2),
          btrim(p_org), cid, coalesce(p_status, 'open'), p_image_url, p_poster_no)
  on conflict (slug) do update set title = excluded.title, summary = excluded.summary, model = excluded.model, params_b = excluded.params_b,
    nights_wanted = excluded.nights_wanted, phones_wanted = excluded.phones_wanted, est_kwh = excluded.est_kwh, est_eur = excluded.est_eur,
    org = excluded.org, city_id = excluded.city_id, status = excluded.status, image_url = excluded.image_url, poster_no = excluded.poster_no;
  return s;
end;
$$;
create or replace function public.staff_project_delete(p_slug text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_admin();
  -- a project with nights keeps its cards: it is retired, not deleted
  if exists (select 1 from public.contributions k join public.projects r on r.id = k.project_id where r.slug = p_slug and k.card_no is not null) then
    update public.projects set status = 'done', is_published = false where slug = p_slug;
  else
    delete from public.projects where slug = p_slug;
  end if;
end;
$$;
drop function if exists public.staff_projects();
create or replace function public.staff_projects()
returns table (slug text, title text, model text, status text, is_published boolean, city_slug text, phones_in int, nights_done int, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_admin();
  return query
  select r.slug, r.title, r.model, r.status, r.is_published, c.slug,
         (select count(*)::int from public.joins j where j.project_id = r.id and j.direction = 'right'),
         (select count(*)::int from public.contributions k where k.project_id = r.id and k.card_no is not null), r.created_at
  from public.projects r left join public.cities c on c.id = r.city_id order by r.created_at desc;
end;
$$;
revoke execute on function public.staff_project_save(text, text, text, text, numeric, int, int, text, text, text, text, int), public.staff_project_delete(text), public.staff_projects() from public, anon;
grant execute on function public.staff_project_save(text, text, text, text, numeric, int, int, text, text, text, text, int), public.staff_project_delete(text), public.staff_projects() to authenticated;

-- the seed's words: one about and one sample per project, in English (the panel adds de · tr)
insert into public.project_about (project_id, lang, kicker, who, facts, source_url)
select r.id, 'en', v.kicker, v.who, v.facts, null from (values
  ('koy-okulu-ogretmen', 'a teachers'' association in van', 'Twelve teachers in the villages around Van who kept lessons going through the winters without a connection. They write the questions, check the answers, and carry the tablets.', array['founded 2019', '38 schools', 'runs on ten-year-old tablets']),
  ('afet-mesaj-siniflandirma', 'volunteers of a search and rescue association', 'The people who read the messages in February 2023, by hand, for days. They want the first hour back.', array['messages anonymised', 'trained offline', 'open weights after']),
  ('deprem-sonrasi-ceviri', 'translators without borders', 'A network of volunteer translators that worked the phones after the earthquake. The model is for the days when no server is up.', array['tr · ar · ku', 'runs on the phone', 'no network needed']),
  ('yerel-tarih-arsivi', 'the city archive of istanbul', 'The archive holds forty years of scanned newspapers nobody can search. The summaries become the catalogue.', array['1980 – 2020', '140 000 pages', 'summaries reviewed by archivists']),
  ('turkce-ders-asistani', 'a network of teachers', 'Teachers from state schools who write and check the lesson answers in their evenings.', array['open curriculum', 'grades 5 to 8', 'checked by teachers']),
  ('isaret-dili-altyazi', 'the federation of the hearing impaired', 'The federation collects the signed sentences; its members check the captions.', array['turkish sign language', 'camera on the phone', 'captions, not voice']),
  ('behoerdenbrief', 'an association for plain language', 'Volunteers who have rewritten letters from offices for twenty years, by hand. The letter never leaves the phone.', array['de · tr · ar · uk', 'letters anonymised', 'berlin, since 2004']),
  ('pflege-nachtassistent', 'care companions in munich', 'A group of carers and nurses who answer the phone at night for families. They want the answers on the phone, in every language.', array['guidelines of the pflegekasse', 'tr · de · en', 'munich']),
  ('stadtarchiv-ocr', 'friends of the hamburg state archive', 'Volunteers who read handwriting. The phones learn from their corrections.', array['1850 – 1950', 'registers and letters', 'corrections by volunteers']),
  ('jobcenter-dolmetscher', 'a migrant women''s network in cologne', 'Women who have interpreted at the jobcenter for each other for years. The model is for when nobody is free to come along.', array['de · tr · fa', 'spoken, on the phone', 'cologne'])
) as v(slug, kicker, who, facts) join public.projects r on r.slug = v.slug
on conflict (project_id, lang) do nothing;

insert into public.project_samples (project_id, lang, prompt, lines)
select r.id, 'en', v.prompt, v.lines from (values
  ('koy-okulu-ogretmen', 'why does the moon change shape?', array['The moon does not change; what changes is how much of its lit side we see.', 'As it goes around the earth, the sun lights it from different angles.', 'Try it: a ball, a lamp, and walk around the lamp.']),
  ('afet-mesaj-siniflandirma', '"we are on the 3rd floor, the stairs are gone, my mother cannot walk"', array['category: trapped · priority: high', 'floor: 3 · mobility: limited', 'needs: rescue team, stretcher']),
  ('deprem-sonrasi-ceviri', 'su var mı? → arabic', array['هل يوجد ماء؟', '(hal yujad maa?)', 'also: "is there water?"']),
  ('yerel-tarih-arsivi', 'summarise: kadıköy council minutes, march 1994', array['The council approved the new ferry pier and postponed the market move.', 'Three members objected to the parking plan on Bahariye.', 'Keywords: ferry, pier, market, parking.']),
  ('turkce-ders-asistani', 'özne ile yüklem arasındaki fark ne?', array['Özne işi yapandır, yüklem yapılan iştir.', '"Ali koştu": Ali özne, koştu yüklem.', 'Sen bir cümle söyle, birlikte bulalım.']),
  ('isaret-dili-altyazi', '[signed: where is the pharmacy]', array['caption: where is the pharmacy?', 'confidence: 0.91', 'reply suggestion: two streets down, on the left']),
  ('behoerdenbrief', 'brief vom jobcenter, 2 seiten, "mitwirkungspflicht"', array['Sie müssen bis zum 14. März Unterlagen schicken.', 'Welche: Kontoauszüge der letzten 3 Monate.', 'Wenn nicht: das Geld kann weniger werden.']),
  ('pflege-nachtassistent', 'annem gece uyanıyor ve evi tanımıyor, ne yapmalıyım?', array['Sakin kalın, ışığı açın, adıyla seslenin.', 'Nerede olduğunu kısa cümlelerle söyleyin.', 'Sabah hekime bildirin: bu bir uyku bozukluğu olabilir.']),
  ('stadtarchiv-ocr', '[handwritten register, 1887]', array['Carl Friedrich Lüders, Schiffszimmermann, geb. 12. Mai 1861', 'wohnhaft Steinstraße 14', 'confidence: 0.84 (surname corrected by a volunteer)']),
  ('jobcenter-dolmetscher', '"Haben Sie die Bewerbungen mitgebracht?" → turkish', array['Başvuruları getirdiniz mi?', '(spoken, 1.2 s)', 'reply: evet, işte buradalar → ja, hier sind sie'])
) as v(slug, prompt, lines) join public.projects r on r.slug = v.slug
on conflict (project_id, lang) do nothing;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('12_about.sql', 'e790b8068d4ee661f020c21eac5efda819239dd2ba44ef5947d74d00a8c0b168');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('12_about.sql');
  end if;
end $$;


-- ============================================================
--  PUSH — a sentence and a name, never the words   (13_push.sql)
-- ============================================================

-- pasaport — push notifications: a fixed sentence and a name, never the words
-- The rule from the start: a push carries a sentence chosen here and a name, never a
-- message, never a project's text beyond its title ("Ayşe started a project night").
--   kinds     friend_request · friend_accepted (notify_friends)
--             call (someone in your waves started a night) · call_in (someone is in on
--             yours) (notify_calls)
--             coop_night (a coop you are in chose tonight's project) (notify_coops)
--             dm (notify_dms) · card (your card from last night is in) (notify_cards)
-- The path: a trigger writes one row to push_outbox, unless the person turned that kind
-- off; a unique key keeps the same thing from going out twice. A trigger on push_outbox
-- hands due rows to the Expo push service through pg_net; without pg_net (the tests) rows
-- wait in the outbox, unsent. Quiet hours: between 00:00 and 09:00 on the phone, everything
-- but a card waits until 09:00 (a card is the morning itself).
-- The phone registers its token with push_register(); a token belongs to one account at
-- a time and carries the app language and the time zone of the phone.

do $$ begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net is not available here; push rows stay in the outbox';
end $$;

create table if not exists public.push_tokens (
  token       text primary key check (token ~ '^Expo(nent)?PushToken\[.+\]$'),
  user_id     uuid not null references public.profiles on delete cascade,
  platform    text not null check (platform in ('ios', 'android')),
  lang        text not null default 'en' check (lang in ('en', 'de', 'tr')),
  tz          text not null default 'Europe/Berlin',
  updated_at  timestamptz not null default now()
);
create index if not exists push_tokens_user_idx on public.push_tokens (user_id, updated_at desc);
create table if not exists public.push_outbox (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles on delete cascade,
  kind        text not null check (kind in ('friend_request', 'friend_accepted', 'call', 'call_in', 'coop_night', 'dm', 'card')),
  key         text not null unique,
  data        jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  send_after  timestamptz not null default now(),
  sent_at     timestamptz,
  request_id  bigint,
  tokens      text[]
);
create index if not exists push_outbox_due_idx on public.push_outbox (send_after) where sent_at is null;
alter table public.push_tokens enable row level security;
alter table public.push_outbox enable row level security;
revoke all on public.push_tokens, public.push_outbox from public, anon, authenticated;

create or replace function public.push_register(p_token text, p_platform text, p_lang text default 'en', p_tz text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  zone text := 'Europe/Berlin';
begin
  if p_tz is not null and exists (select 1 from pg_timezone_names where name = p_tz) then zone := p_tz; end if;
  insert into public.push_tokens (token, user_id, platform, lang, tz) values (p_token, me, p_platform, coalesce(p_lang, 'en'), zone)
  on conflict (token) do update set user_id = excluded.user_id, platform = excluded.platform, lang = excluded.lang, tz = excluded.tz, updated_at = now();
  return true;
end;
$$;
create or replace function public.push_unregister(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.push_tokens where token = p_token and user_id = auth.uid();
  return found;
end;
$$;
revoke execute on function public.push_register(text, text, text, text), public.push_unregister(text) from public, anon;
grant execute on function public.push_register(text, text, text, text), public.push_unregister(text) to authenticated;

create or replace function public.push_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p.display_name, p.handle, 'someone') from public.profiles p where p.id = p_user;
$$;
create or replace function public.push_zone(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select k.tz from public.push_tokens k where k.user_id = p_user order by k.updated_at desc limit 1), 'Europe/Berlin');
$$;
create or replace function public.push_wants(p_user uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select case
             when p_kind in ('friend_request', 'friend_accepted') then s.notify_friends
             when p_kind in ('call', 'call_in') then s.notify_calls
             when p_kind = 'coop_night' then s.notify_coops
             when p_kind = 'dm' then s.notify_dms
             when p_kind = 'card' then s.notify_cards end
    from public.profile_settings s where s.user_id = p_user), true);
$$;
create or replace function public.push_enqueue(p_user uuid, p_kind text, p_key text, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  zone text;
  here timestamp;
  due timestamptz := now();
begin
  if p_user is null or public.is_banned(p_user) or not public.push_wants(p_user, p_kind) then return; end if;
  if p_kind <> 'card' then
    zone := public.push_zone(p_user);
    here := now() at time zone zone;
    if extract(hour from here) < 9 then due := (date_trunc('day', here) + interval '9 hours') at time zone zone; end if;
  end if;
  insert into public.push_outbox (user_id, kind, key, data, send_after) values (p_user, p_kind, p_key, p_data, due) on conflict (key) do nothing;
end;
$$;
revoke execute on function public.push_name(uuid), public.push_zone(uuid), public.push_wants(uuid, text), public.push_enqueue(uuid, text, text, jsonb) from public, anon, authenticated;

-- The words: title and body in the language of the phone; {name} and {title} are filled
-- from data, nothing else ever is.
drop function if exists public.push_text(text, text, jsonb);
create or replace function public.push_text(p_kind text, p_lang text, p_data jsonb)
returns table (title text, body text)
language plpgsql
immutable
as $$
declare
  pair record;
begin
  select x.title, x.body into title, body from (values
    ('friend_request',  'en', 'friend request',           '{name} wants to add you'),
    ('friend_request',  'de', 'freundschaftsanfrage',     '{name} möchte dich hinzufügen'),
    ('friend_request',  'tr', 'arkadaşlık isteği',        '{name} seni eklemek istiyor'),
    ('friend_accepted', 'en', 'you are friends now',      '{name} accepted your request'),
    ('friend_accepted', 'de', 'ihr seid jetzt freunde',   '{name} hat deine anfrage angenommen'),
    ('friend_accepted', 'tr', 'artık arkadaşsınız',       '{name} isteğini kabul etti'),
    ('call',            'en', 'a project night',          '{name} started a project night'),
    ('call',            'de', 'eine projektnacht',        '{name} hat eine projektnacht gestartet'),
    ('call',            'tr', 'bir proje gecesi',         '{name} bir proje gecesi başlattı'),
    ('call_in',         'en', 'someone is in',            '{name} is in on your project night'),
    ('call_in',         'de', 'jemand ist dabei',         '{name} ist bei deiner projektnacht dabei'),
    ('call_in',         'tr', 'biri katıldı',             '{name} proje gecene katıldı'),
    ('coop_night',      'en', 'tonight, together',        '{name} chose tonight''s project for {title}'),
    ('coop_night',      'de', 'heute nacht, zusammen',    '{name} hat das projekt für heute nacht gewählt: {title}'),
    ('coop_night',      'tr', 'bu gece, beraber',         '{name} bu gecenin projesini seçti: {title}'),
    ('dm',              'en', 'a message',                '{name} wrote to you'),
    ('dm',              'de', 'eine nachricht',           '{name} hat dir geschrieben'),
    ('dm',              'tr', 'bir mesaj',                '{name} sana yazdı'),
    ('card',            'en', 'your card is in',          'last night on {title}: the card is yours'),
    ('card',            'de', 'deine karte ist da',       'letzte nacht bei {title}: die karte gehört dir'),
    ('card',            'tr', 'kartın hazır',             'dün gece {title}: kart senin')
  ) as x(kind, lang, title, body) where x.kind = p_kind and x.lang = coalesce(p_lang, 'en');
  if title is null then
    select x.title, x.body into title, body from (values ('x', 'pasaport', 'open the app')) as x(k, title, body);
  end if;
  for pair in select key, value from jsonb_each_text(coalesce(p_data, '{}')) where key in ('name', 'title') loop
    title := replace(title, '{' || pair.key || '}', coalesce(pair.value, ''));
    body := replace(body, '{' || pair.key || '}', coalesce(pair.value, ''));
  end loop;
  return next;
end;
$$;

create or replace function public.push_send(p_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  item public.push_outbox;
  messages jsonb;
  phones text[];
  request bigint;
begin
  if to_regnamespace('net') is null then return false; end if;
  select * into item from public.push_outbox where id = p_id and sent_at is null;
  if not found then return false; end if;
  select jsonb_agg(jsonb_build_object('to', k.token, 'title', x.title, 'body', x.body, 'sound', 'default', 'channelId', 'default',
                                      'data', item.data || jsonb_build_object('kind', item.kind)) order by k.token),
         array_agg(k.token order by k.token) into messages, phones
  from public.push_tokens k cross join lateral public.push_text(item.kind, k.lang, item.data) x where k.user_id = item.user_id;
  if messages is not null then
    execute 'select net.http_post(url := $1, body := $2, headers := $3)' into request
      using 'https://exp.host/' || repeat('-', 2) || '/api/v2/push/send', messages, '{"Content-Type": "application/json", "Accept": "application/json"}'::jsonb;
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
  if new.send_after <= now() then perform public.push_send(new.id); end if;
  return new;
end;
$$;
drop trigger if exists push_outbox_deliver on public.push_outbox;
create trigger push_outbox_deliver after insert on public.push_outbox for each row execute function public.push_deliver();

-- The five-minute flush (a cron job on Supabase) sends what waited for 09:00 and forgets
-- what was sent more than a week ago.
create or replace function public.push_flush()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
  r record;
begin
  for r in select id from public.push_outbox where sent_at is null and send_after <= now() order by id limit 200 loop
    if public.push_send(r.id) then n := n + 1; end if;
  end loop;
  delete from public.push_outbox where sent_at < now() - interval '7 days';
  return n;
end;
$$;
revoke execute on function public.push_send(bigint), public.push_flush() from public, anon, authenticated;

-- ------------------------------------------------------------ the triggers
create or replace function public.push_on_friendship()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.status = 'pending' then
    perform public.push_enqueue(new.addressee_id, 'friend_request', format('friend_request:%s:%s', new.requester_id, new.addressee_id),
      jsonb_build_object('name', public.push_name(new.requester_id), 'url', '/friend/' || new.requester_id));
  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'accepted' then
    perform public.push_enqueue(new.requester_id, 'friend_accepted', format('friend_accepted:%s:%s', new.requester_id, new.addressee_id),
      jsonb_build_object('name', public.push_name(new.addressee_id), 'url', '/friend/' || new.addressee_id));
  end if;
  return new;
end;
$$;
drop trigger if exists friendships_push on public.friendships;
create trigger friendships_push after insert or update on public.friendships for each row execute function public.push_on_friendship();

-- a call: everyone inside the wave hears the name; an answer "in": the host hears the name
create or replace function public.push_on_call()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  w record;
begin
  for w in select person from public.waves(new.host_id) where hops <= new.reach loop
    perform public.push_enqueue(w.person, 'call', format('call:%s:%s', new.id, w.person),
      jsonb_build_object('name', public.push_name(new.host_id), 'url', '/call/' || new.id));
  end loop;
  return new;
end;
$$;
drop trigger if exists calls_push on public.calls;
create trigger calls_push after insert on public.calls for each row execute function public.push_on_call();
create or replace function public.push_on_call_answer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  h uuid;
begin
  if new.answer = 'in' and (tg_op = 'INSERT' or old.answer <> 'in') then
    select host_id into h from public.calls where id = new.call_id;
    perform public.push_enqueue(h, 'call_in', format('call_in:%s:%s', new.call_id, new.user_id),
      jsonb_build_object('name', public.push_name(new.user_id), 'url', '/call/' || new.call_id));
  end if;
  return new;
end;
$$;
drop trigger if exists call_answers_push on public.call_answers;
create trigger call_answers_push after insert or update on public.call_answers for each row execute function public.push_on_call_answer();

-- a coop chose tonight: the other members hear the name and the project's title
create or replace function public.push_on_coop_night()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
  t text;
begin
  if new.night <> public.night_of() then return new; end if;
  select title into t from public.projects where id = new.project_id;
  for m in select user_id from public.coop_members where coop_id = new.coop_id and user_id <> new.set_by loop
    perform public.push_enqueue(m.user_id, 'coop_night', format('coop_night:%s:%s:%s', new.coop_id, new.night, m.user_id),
      jsonb_build_object('name', public.push_name(new.set_by), 'title', t, 'url', '/coops/' || new.coop_id));
  end loop;
  return new;
end;
$$;
drop trigger if exists coop_nights_push on public.coop_nights;
create trigger coop_nights_push after insert or update on public.coop_nights for each row execute function public.push_on_coop_night();

-- the morning: the card is in
create or replace function public.push_on_card()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  t text;
begin
  if new.card_no is not null and old.card_no is null then
    select title into t from public.projects where id = new.project_id;
    perform public.push_enqueue(new.user_id, 'card', format('card:%s', new.id), jsonb_build_object('title', t, 'url', '/passport'));
  end if;
  return new;
end;
$$;
drop trigger if exists contributions_push on public.contributions;
create trigger contributions_push after update on public.contributions for each row execute function public.push_on_card();

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('13_push.sql', '67d27a9fc464c3712658c3582621b37d3b4b446feb36fde80cde3007b201eaa8');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('13_push.sql');
  end if;
end $$;


-- ============================================================
--  WHAT THE STORES REQUIRE — terms, reports, errors, the floor, feedback, pruning   (14_safety.sql)
-- ============================================================

-- pasaport — what the stores require
--   the terms       accept_terms(version) · terms_status(): asked once, before anything
--                   else, and again when the version rises
--   reports         report(kind, target, reason) for profiles, dm lines, coops, calls;
--                   staff_reports() · staff_report_settle(kind, target, remove) for the
--                   admin. Removing takes the content away (a line deleted, a call or coop
--                   deleted, a profile cleared of its words); either way the report is settled.
--   client errors   log_error() from any phone; admin_errors() · admin_errors_clear()
--   the floor       min_app_version() · set_min_app_version(v): the oldest app that still works
--   feedback        feedback_send(subject, body, contact) from anyone; feedback_list() for the admin
--   retention       retention_prune(): abandoned nights older than a day, errors older than
--                   30 days. Passports are not pruned (21.10.2026: every measurement is kept
--                   for the device catalog, 16_devices.sql; they go with the account)

create or replace function public.accept_terms(p_version int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  if p_version is null or p_version < 1 then raise exception 'which terms?'; end if;
  update public.profiles set terms_version = greatest(coalesce(terms_version, 0), p_version), terms_at = now() where id = me;
end;
$$;
create or replace function public.terms_status()
returns table (version int, at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select p.terms_version, p.terms_at from public.profiles p where p.id = auth.uid();
$$;

create table if not exists public.reports (
  id          bigserial primary key,
  kind        text not null check (kind in ('profile', 'dm', 'coop', 'call')),
  target      text not null,
  reporter_id uuid references public.profiles on delete set null,
  reason      text check (reason is null or length(reason) <= 400),
  snapshot    text,
  created_at  timestamptz not null default now(),
  settled_at  timestamptz,
  removed     boolean
);
create index if not exists reports_open_idx on public.reports (kind, target) where settled_at is null;
alter table public.reports enable row level security;
revoke all on public.reports from public, anon, authenticated;

create or replace function public.report(p_kind text, p_target text, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  snap text;
begin
  if p_kind not in ('profile', 'dm', 'coop', 'call') then raise exception 'what kind of thing?'; end if;
  if (select count(*) from public.reports r where r.reporter_id = me and r.created_at > now() - interval '1 day') >= 20 then raise exception 'slow down'; end if;
  snap := case p_kind
    when 'profile' then (select concat_ws(' · ', p.handle, p.display_name, p.bio) from public.profiles p where p.id::text = p_target or p.handle = p_target)
    when 'dm' then (select m.body from public.dm_messages m where m.id::text = p_target)
    when 'coop' then (select c.name from public.coops c where c.id::text = p_target)
    when 'call' then (select r.title || ' · ' || coalesce(c.note, '') from public.calls c join public.projects r on r.id = c.project_id where c.id::text = p_target) end;
  insert into public.reports (kind, target, reporter_id, reason, snapshot) values (p_kind, p_target, me, nullif(btrim(coalesce(p_reason, '')), ''), left(snap, 400));
end;
$$;
drop function if exists public.staff_reports();
create or replace function public.staff_reports()
returns table (kind text, target text, snapshot text, reports int, reasons text[], first_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_admin();
  return query
  select r.kind, r.target, max(r.snapshot), count(*)::int, array_remove(array_agg(distinct r.reason), null), min(r.created_at)
  from public.reports r where r.settled_at is null group by r.kind, r.target order by min(r.created_at);
end;
$$;
create or replace function public.staff_report_settle(p_kind text, p_target text, p_remove boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_admin();
  if p_remove then
    case p_kind
      when 'profile' then update public.profiles set bio = null, display_name = handle where id::text = p_target or handle = p_target;
      when 'dm' then delete from public.dm_messages where id::text = p_target;
      when 'coop' then delete from public.coops where id::text = p_target;
      when 'call' then delete from public.calls where id::text = p_target;
      else null;
    end case;
  end if;
  update public.reports set settled_at = now(), removed = p_remove where kind = p_kind and target = p_target and settled_at is null;
end;
$$;

create table if not exists public.client_errors (
  id         bigserial primary key,
  user_id    uuid references public.profiles on delete set null,
  message    text not null,
  stack      text,
  where_     text,
  platform   text,
  version    text,
  fatal      boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.client_errors enable row level security;
revoke all on public.client_errors from public, anon, authenticated;
create or replace function public.log_error(p_message text, p_stack text, p_where text, p_platform text, p_version text, p_fatal boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.client_errors e where e.created_at > now() - interval '1 minute') >= 60 then return; end if;
  insert into public.client_errors (user_id, message, stack, where_, platform, version, fatal)
  values (auth.uid(), left(coalesce(p_message, '?'), 500), left(p_stack, 4000), left(p_where, 120), left(p_platform, 20), left(p_version, 20), coalesce(p_fatal, false));
end;
$$;
drop function if exists public.admin_errors(int);
create or replace function public.admin_errors(p_limit int default 100)
returns table (id bigint, message text, stack text, where_ text, platform text, version text, fatal boolean, at timestamptz, who text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_admin();
  return query select e.id, e.message, e.stack, e.where_, e.platform, e.version, e.fatal, e.created_at, p.handle
  from public.client_errors e left join public.profiles p on p.id = e.user_id order by e.id desc limit least(coalesce(p_limit, 100), 500);
end;
$$;
create or replace function public.admin_errors_clear()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_admin();
  delete from public.client_errors;
end;
$$;

create table if not exists public.app_floor (
  id         boolean primary key default true check (id),
  version    text not null,
  note       text,
  set_at     timestamptz not null default now()
);
alter table public.app_floor enable row level security;
revoke all on public.app_floor from public, anon, authenticated;
insert into public.app_floor (version) values ('0.1.0') on conflict (id) do nothing;
create or replace function public.version_lt(a text, b text)
returns boolean
language sql
immutable
as $$
  select string_to_array(a, '.')::int[] < string_to_array(b, '.')::int[];
$$;
create or replace function public.min_app_version()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select version from public.app_floor where id;
$$;
create or replace function public.set_min_app_version(p_version text, p_note text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_admin();
  if p_version !~ '^\d+\.\d+\.\d+$' then raise exception 'a version looks like 0.2.0'; end if;
  update public.app_floor set version = p_version, note = p_note, set_at = now() where id;
  return p_version;
end;
$$;

create table if not exists public.feedback (
  id         bigserial primary key,
  user_id    uuid references public.profiles on delete set null,
  subject    text not null check (length(subject) between 1 and 120),
  body       text not null check (length(body) between 1 and 4000),
  contact    text check (contact is null or length(contact) <= 200),
  created_at timestamptz not null default now()
);
alter table public.feedback enable row level security;
revoke all on public.feedback from public, anon, authenticated;
create or replace function public.feedback_send(p_subject text, p_body text, p_contact text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.feedback f where f.created_at > now() - interval '1 hour') >= 100 then return; end if;
  insert into public.feedback (user_id, subject, body, contact) values (auth.uid(), btrim(p_subject), btrim(p_body), nullif(btrim(coalesce(p_contact, '')), ''));
end;
$$;
drop function if exists public.feedback_list(int);
create or replace function public.feedback_list(p_limit int default 100)
returns table (id bigint, subject text, body text, contact text, who text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_admin();
  return query select f.id, f.subject, f.body, f.contact, p.handle, f.created_at from public.feedback f left join public.profiles p on p.id = f.user_id
  order by f.id desc limit least(coalesce(p_limit, 100), 500);
end;
$$;

create or replace function public.retention_prune()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
  m int;
begin
  delete from public.contributions where card_no is null and ended_at is not null and started_at < now() - interval '1 day'; get diagnostics m = row_count; n := n + m;
  delete from public.client_errors where created_at < now() - interval '30 days'; get diagnostics m = row_count; n := n + m;
  delete from public.push_outbox where sent_at < now() - interval '7 days'; get diagnostics m = row_count; n := n + m;
  return n;
end;
$$;
revoke execute on function public.retention_prune() from public, anon, authenticated;

-- staff: people by handle, for the panel
drop function if exists public.admin_people(text);
create or replace function public.admin_people(p_query text)
returns table (id uuid, handle text, display_name text, created_at timestamptz, nights int, banned boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  q text := lower(btrim(coalesce(p_query, '')));
begin
  perform public.need_admin();
  return query select p.id, p.handle, p.display_name, p.created_at,
    (select count(*)::int from public.contributions k where k.user_id = p.id and k.card_no is not null), public.is_banned(p.id)
  from public.profiles p where q = '' or p.handle like q || '%' or lower(coalesce(p.display_name, '')) like '%' || q || '%'
  order by p.created_at desc limit 100;
end;
$$;

revoke execute on function public.accept_terms(int), public.terms_status(), public.report(text, text, text), public.staff_reports(), public.staff_report_settle(text, text, boolean),
  public.admin_errors(int), public.admin_errors_clear(), public.set_min_app_version(text, text), public.feedback_list(int), public.admin_people(text) from public, anon;
grant execute on function public.accept_terms(int), public.terms_status(), public.report(text, text, text), public.staff_reports(), public.staff_report_settle(text, text, boolean),
  public.admin_errors(int), public.admin_errors_clear(), public.set_min_app_version(text, text), public.feedback_list(int), public.admin_people(text) to authenticated;
grant execute on function public.log_error(text, text, text, text, text, boolean), public.min_app_version(), public.feedback_send(text, text, text) to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('14_safety.sql', '0c72f26de1a1598042b3c869795a3676aac50b1e447f6254aaf5b7cdaf21f5db');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('14_safety.sql');
  end if;
end $$;


-- ============================================================
--  HEALTH   (15_health.sql)
-- ============================================================

-- pasaport — the status check: is the content in place, what wants attention
-- Numbers only, readable with the public key (tools/health.mjs, the site's help page).
-- health_more marks the two that go red: a night left open for more than a day, pushes
-- older than six hours still unsent.

drop function if exists public.health();
create or replace function public.health()
returns table (projects bigint, open_projects bigint, people bigint, joins bigint, friendships bigint,
               nights bigint, nights_tonight bigint, tokens bigint, kwh numeric, credits numeric,
               passports bigint, coops bigint, calls_open bigint, nights_stuck bigint, outbox_stuck bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*) from public.projects where is_published),
    (select count(*) from public.projects where is_published and status = 'open'),
    (select count(*) from public.profiles),
    (select count(*) from public.joins where direction = 'right'),
    (select count(*) from public.friendships where status = 'accepted'),
    (select count(*) from public.contributions where card_no is not null),
    (select count(*) from public.contributions where ended_at is null),
    coalesce((select sum(tokens) from public.contributions), 0)::bigint,
    coalesce((select round(sum(kwh), 2) from public.contributions), 0),
    coalesce((select sum(amount) from public.credits), 0),
    (select count(distinct user_id) from public.passports),
    (select count(*) from public.coops),
    (select count(*) from public.calls where night >= public.night_of()),
    (select count(*) from public.contributions where ended_at is null and started_at < now() - interval '1 day'),
    (select count(*) from public.push_outbox where sent_at is null and send_after < now() - interval '6 hours');
$$;
grant execute on function public.health() to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('15_health.sql', 'b8b7a43cc149385a7f4ddd9bfd28059ba00292919a3e7fcf5dfe9344d87e0a51');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('15_health.sql');
  end if;
end $$;


-- ============================================================
--  DEVICES — the catalog of every device model, the network's night estimated   (16_devices.sql)
-- ============================================================

-- kula — every device in detail, and the network's night estimated from them (21.10.2026)
--   device_catalog()           one row per device model (device + soc) from every passport
--                              ever saved: how many phones and measurements, the medians
--                              of what they measured (bandwidth only from native
--                              measurements, never the JS fallback), the speed range.
--                              Counts and medians, never who.
--   network_estimate(hours)    what the network could do tonight: per person their newest
--                              passport of the last 30 days, or what their finished nights
--                              really ran at when there are any (observed beats estimated),
--                              summed. The sum assumes every phone runs its own copy of a
--                              model on its own jobs; one model split across phones is far
--                              slower (wifi split test, 11.10.2026) and is not counted here.
-- The passports are device-passport's passport/0.x json; 0.3 brings estimate.tps_low /
-- tps_high and budget.ram_gb, older ones only est_tps (then low = high = est_tps).

drop function if exists public.device_catalog();
create or replace function public.device_catalog()
returns table (device text, soc text, phones int, passports int, native int,
               ram_total_gb numeric, ram_free_gb numeric, ram_free_min numeric, ram_free_max numeric,
               mem_bw_gbs numeric, mem_bw_read_gbs numeric, best_threads int,
               budget_ram_gb numeric, tps_low numeric, tps_high numeric, last_measured timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  with p as (
    select p.user_id, p.measured_at, p.data,
           coalesce(p.data ->> 'approx', 'false') = 'true' as approx,
           (p.data ->> 'ram_total_gb')::numeric as ram_total,
           (p.data ->> 'ram_free_gb')::numeric as ram_free,
           (p.data ->> 'mem_bw_gbs')::numeric as bw,
           nullif((p.data ->> 'mem_bw_read_gbs')::numeric, 0) as bw_read,
           nullif((p.data ->> 'best_threads')::int, 0) as threads,
           (p.data -> 'budget' ->> 'ram_gb')::numeric as budget_ram,
           coalesce((p.data -> 'estimate' ->> 'tps_low')::numeric, (p.data ->> 'est_tps')::numeric) as low,
           coalesce((p.data -> 'estimate' ->> 'tps_high')::numeric, (p.data ->> 'est_tps')::numeric) as high
    from public.passports p
  )
  select coalesce(nullif(data ->> 'device', ''), 'unknown'), coalesce(nullif(data ->> 'soc', ''), 'unknown'),
         count(distinct user_id)::int, count(*)::int, count(*) filter (where not approx)::int,
         round((percentile_cont(0.5) within group (order by ram_total))::numeric, 1),
         round((percentile_cont(0.5) within group (order by ram_free))::numeric, 1),
         round(min(ram_free), 1), round(max(ram_free), 1),
         round((percentile_cont(0.5) within group (order by bw) filter (where not approx))::numeric, 2),
         round((percentile_cont(0.5) within group (order by bw_read) filter (where not approx))::numeric, 2),
         mode() within group (order by threads),
         round((percentile_cont(0.5) within group (order by budget_ram))::numeric, 2),
         round((percentile_cont(0.5) within group (order by low) filter (where not approx))::numeric, 1),
         round((percentile_cont(0.5) within group (order by high) filter (where not approx))::numeric, 1),
         max(measured_at)
  from p
  group by 1, 2
  order by 3 desc, 4 desc, 1;
$$;

drop function if exists public.network_estimate(numeric);
create or replace function public.network_estimate(p_hours numeric default 8.5)
returns table (phones int, observed int, tps_low numeric, tps_high numeric,
               tokens_night_low bigint, tokens_night_high bigint, hours numeric, by_device jsonb)
language sql
stable
security definer
set search_path = public
as $$
  with h as (select least(greatest(coalesce(p_hours, 8.5), 0.5), 24) as hours),
  last as (
    select distinct on (p.user_id) p.user_id, p.data from public.passports p
    where p.measured_at > now() - interval '30 days' order by p.user_id, p.measured_at desc),
  seen as ( -- what finished nights really ran at, per person, last 30 days
    select k.user_id, (percentile_cont(0.5) within group (order by k.tokens::numeric / k.seconds))::numeric as tps
    from public.contributions k
    where k.card_no is not null and k.seconds > 0 and k.ended_at > now() - interval '30 days'
    group by k.user_id),
  per as (
    select l.user_id, coalesce(nullif(l.data ->> 'device', ''), 'unknown') as device, s.tps is not null as observed,
           coalesce(s.tps, (l.data -> 'estimate' ->> 'tps_low')::numeric, (l.data ->> 'est_tps')::numeric, 0) as low,
           coalesce(s.tps, (l.data -> 'estimate' ->> 'tps_high')::numeric, (l.data ->> 'est_tps')::numeric, 0) as high
    from last l left join seen s on s.user_id = l.user_id)
  select count(*)::int, (count(*) filter (where e.observed))::int,
         round(coalesce(sum(e.low), 0), 1), round(coalesce(sum(e.high), 0), 1),
         round(coalesce(sum(e.low), 0) * 3600 * (select hours from h))::bigint,
         round(coalesce(sum(e.high), 0) * 3600 * (select hours from h))::bigint,
         (select hours from h),
         coalesce((select jsonb_agg(jsonb_build_object('device', d.device, 'phones', d.n, 'tps_low', d.low, 'tps_high', d.high) order by d.n desc, d.device)
                   from (select device, count(*) n, round(sum(low), 1) low, round(sum(high), 1) high from per group by device) d), '[]')
  from per e;
$$;

grant execute on function public.device_catalog(), public.network_estimate(numeric) to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('16_devices.sql', 'a51bcb721c6957399458fc0af33c4bb23daf54d3523e75024a85b3d2137a8796');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('16_devices.sql');
  end if;
end $$;
