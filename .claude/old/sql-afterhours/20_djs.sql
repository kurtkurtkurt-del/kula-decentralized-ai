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
