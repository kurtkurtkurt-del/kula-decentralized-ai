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
