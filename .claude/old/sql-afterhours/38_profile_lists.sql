-- afterhours — WhatsApp among the links, and the two lists under a profile (38)
--
--   profile_links  new kind: whatsapp, a phone number in digits (country code
--                  first, no plus); spaces, dashes and a leading + are dropped
--   person_kept(handle)     the nights they kept, newest first
--   person_people(handle)   their confirmed friends (handle and name)
--
-- Both lists follow the same rules as the rest of a profile: you see your own,
-- and those of your CONFIRMED friends. person_kept also needs their kept
-- nights to be visible to friends (kept_visible). Anyone else gets no rows.

-- ------------------------------------------------------------------ links

alter table public.profile_links drop constraint if exists profile_links_kind_check;
alter table public.profile_links add constraint profile_links_kind_check
  check (kind in ('instagram', 'tiktok', 'spotify', 'soundcloud', 'x', 'website', 'whatsapp'));
alter table public.profile_links drop constraint if exists profile_links_value;
alter table public.profile_links add constraint profile_links_value check (
  (kind = 'website' and value ~ '^https?://[^[:space:]]{3,200}$')
  or (kind = 'whatsapp' and value ~ '^[0-9]{6,16}$')
  or (kind not in ('website', 'whatsapp') and value ~ '^[A-Za-z0-9._-]{1,40}$')
);

-- Every kind present in p_links is set (or cleared when empty); kinds that are
-- not mentioned stay as they are. A leading @ is dropped; for whatsapp everything
-- but the digits. Returns ok, or format:<kind> for the first value that does not
-- fit (nothing is written then).
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
    if k not in ('instagram', 'tiktok', 'spotify', 'soundcloud', 'x', 'website', 'whatsapp') then
      return 'format:' || k;
    end if;
    if k = 'whatsapp' then
      -- Something was typed but no digit in it: not a number (empty clears it).
      if v <> '' and v !~ '[0-9]' then
        return 'format:' || k;
      end if;
      v := regexp_replace(v, '[^0-9]', '', 'g');
    elsif k <> 'website' then
      v := regexp_replace(v, '^@+', '');
    end if;
    if v <> '' and not (
      (k = 'website' and v ~ '^https?://[^[:space:]]{3,200}$')
      or (k = 'whatsapp' and v ~ '^[0-9]{6,16}$')
      or (k not in ('website', 'whatsapp') and v ~ '^[A-Za-z0-9._-]{1,40}$')
    ) then
      return 'format:' || k;
    end if;
  end loop;

  for k, v in select key, btrim(coalesce(value, '')) from jsonb_each_text(p_links) loop
    if k = 'whatsapp' then
      v := regexp_replace(v, '[^0-9]', '', 'g');
    elsif k <> 'website' then
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

-- ------------------------------------------------------------------ lists

drop function if exists public.person_kept(text);
create or replace function public.person_kept(p_handle text)
returns setof public.events_public
language sql
stable
security definer
set search_path = public
as $$
  select e.*
  from public.profiles p
  join public.swipes s on s.user_id = p.id and s.direction = 'right'
  join public.events_public e on e.id = s.event_id
  where p.handle = lower(btrim(p_handle))
    and (p.id = auth.uid() or (public.is_friend(p.id) and public.kept_visible(p.id)))
  order by s.created_at desc;
$$;

drop function if exists public.person_people(text);
create or replace function public.person_people(p_handle text)
returns table (handle text, display_name text)
language sql
stable
security definer
set search_path = public
as $$
  with target as (
    select p.id from public.profiles p
    where p.handle = lower(btrim(p_handle))
      and (p.id = auth.uid() or public.is_friend(p.id))
  )
  select o.handle, o.display_name
  from public.friendships f
  join public.profiles o on o.id = case when f.requester_id = (select id from target) then f.addressee_id else f.requester_id end
  where f.status = 'accepted'
    and (f.requester_id = (select id from target) or f.addressee_id = (select id from target))
  order by coalesce(o.handle, o.display_name);
$$;

revoke all on function public.profile_links_set(jsonb) from public, anon;
revoke all on function public.person_kept(text) from public, anon;
revoke all on function public.person_people(text) from public, anon;
grant execute on function public.profile_links_set(jsonb) to authenticated;
grant execute on function public.person_kept(text) to authenticated;
grant execute on function public.person_people(text) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('38_profile_lists.sql', '8bc6454831b9aa30bc2cceb0cf760eae823442d2301a43e99ffb967b15862b2b');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('38_profile_lists.sql');
  end if;
end $$;
