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
