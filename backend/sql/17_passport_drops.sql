/* 17: a passport handed over by a connect id (21.10.2026).

   The Passport app on a phone shows a connect id — six letters and digits — and waits. On
   a computer, the site's passport page gives a terminal command with that id
   (passport/mac.sh, a native measurement of a Mac) or sends the browser's own measurement;
   either one drops the passport here under the id. The phone picks it up and adds the
   computer to its list. Nobody signs in: the id is the key, a drop lives 15 minutes, and a
   pickup deletes it. What waits here is a device's measurement, never who owns it.

     passport_drop(code, data)  anyone: store a passport under a connect id; a second drop
                                under the same id replaces the first
     passport_pick(code)        anyone: the passport waiting under the id, once; null when
                                there is none (not dropped yet, picked, or older than 15 min)

   The alphabet leaves out 0 O 1 I L, which read alike on a screen. */

create table if not exists public.passport_drops (
  code text primary key check (code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$'),
  data jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.passport_drops enable row level security;
revoke all on public.passport_drops from public, anon, authenticated;

create or replace function public.passport_drop(p_code text, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c text := upper(btrim(coalesce(p_code, '')));
begin
  if c !~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$' then
    raise exception 'connect id: six letters and digits' using errcode = '22023';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' or coalesce(p_data ->> 'schema', '') !~ '^passport/0\.' then
    raise exception 'not a passport' using errcode = '22023';
  end if;
  if coalesce(jsonb_typeof(p_data -> 'est_tps'), '') <> 'number' or (p_data ->> 'est_tps')::numeric < 0
     or coalesce(jsonb_typeof(p_data -> 'device'), '') <> 'string' then
    raise exception 'passport incomplete' using errcode = '22023';
  end if;
  if octet_length(p_data::text) > 16384 then
    raise exception 'passport too large' using errcode = '22023';
  end if;
  delete from public.passport_drops where created_at < now() - interval '15 minutes';
  insert into public.passport_drops (code, data) values (c, p_data)
  on conflict (code) do update set data = excluded.data, created_at = now();
end;
$$;

create or replace function public.passport_pick(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c text := upper(btrim(coalesce(p_code, '')));
  d jsonb;
begin
  if c !~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$' then return null; end if;
  delete from public.passport_drops where created_at < now() - interval '15 minutes';
  delete from public.passport_drops where code = c returning data into d;
  return d;
end;
$$;

revoke execute on function public.passport_drop(text, jsonb), public.passport_pick(text) from public;
grant execute on function public.passport_drop(text, jsonb), public.passport_pick(text) to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('17_passport_drops.sql', '44bba64d446668f1e83827e1f3cf9c599b197f9cac3269c7f83ee1cb2a1a0bc6');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('17_passport_drops.sql');
  end if;
end $$;
