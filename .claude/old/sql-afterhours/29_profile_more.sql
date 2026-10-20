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
