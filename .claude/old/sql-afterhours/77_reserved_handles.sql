-- afterhours — some names belong to nobody (77)
--
-- Anyone could take @admin, @afterhours or @support and write to people as the team
-- (F15, 20.10.2026). A short list of reserved words, and anything that starts with
-- afterhours, is now taken for everyone who is not staff: handle_status says so on
-- every keystroke, handle_new_user drops the wish at sign-up, and profile_setup (12)
-- goes through handle_status and so refuses it too. The staff keep the right to use
-- them (the panel accounts). Both functions are those of 74 / 12 with the one check.

create or replace function public.handle_reserved(p_handle text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select not coalesce(public.is_staff(), false)
     and (p_handle in ('admin', 'administrator', 'afterhours', 'support', 'help', 'staff', 'team',
                       'moderator', 'mod', 'official', 'security', 'root', 'system', 'info', 'contact',
                       'ticketmaster', 'supabase', 'apple', 'google', 'null', 'undefined', 'someone')
          or p_handle like 'afterhours%'
          or p_handle like 'admin\_%'
          or p_handle like 'support\_%');
$$;
grant execute on function public.handle_reserved(text) to anon, authenticated;

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
    when public.handle_reserved(lower(btrim(p_handle))) then 'taken'
    when exists (select 1 from public.profiles
                 where handle = lower(btrim(p_handle)) and id = auth.uid()) then 'yours'
    when exists (select 1 from public.profiles
                 where handle = lower(btrim(p_handle))) then 'taken'
    when exists (select 1 from public.banned_marks
                 where handle = lower(btrim(p_handle))) then 'taken'
    else 'ok'
  end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  wanted text := lower(btrim(coalesce(new.raw_user_meta_data ->> 'handle', '')));
  city_slug_in   text := lower(btrim(coalesce(new.raw_user_meta_data ->> 'city', '')));
  city_uuid uuid;
begin
  if wanted !~ '^[a-z0-9_]{3,20}$'
     or public.handle_reserved(wanted)
     or exists (select 1 from public.profiles where handle = wanted) then
    wanted := null;
  end if;

  if city_slug_in <> '' then
    select id into city_uuid from public.cities where slug = city_slug_in;
  end if;

  insert into public.profiles (id, display_name, handle, city_id, onboarded_at)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    wanted,
    city_uuid,
    case when wanted is null then null else now() end
  )
  on conflict (id) do nothing;

  insert into public.profile_settings (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('77_reserved_handles.sql', 'fa5b62cfc06e366950440065eed78c7d055bf325bc82226489865c81cae07c2e');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('77_reserved_handles.sql');
  end if;
end $$;
