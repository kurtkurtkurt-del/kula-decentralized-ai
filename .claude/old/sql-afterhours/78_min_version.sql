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
