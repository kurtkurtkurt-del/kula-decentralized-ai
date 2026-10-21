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
