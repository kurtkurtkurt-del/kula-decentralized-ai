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
