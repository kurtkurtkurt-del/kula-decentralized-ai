-- paste 11/24: 76 77 78
create or replace function public.staff_pending()
returns table (id uuid, slug text, title text, city_slug text, type_slug text, venue_name text,
               starts_at timestamptz, body text, ticket_url text, image_url text, maker text, handle text, sent_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_staff() then
    perform public.submissions_expire();
  end if;
  return query
    select e.id, e.slug, e.title, c.slug, t.slug, v.name, e.starts_at, e.body, e.ticket_url, e.image_url,
           p.display_name, p.handle, e.created_at
    from public.events e
    join public.cities c on c.id = e.city_id
    join public.event_types t on t.id = e.type_id
    left join public.venues v on v.id = e.venue_id
    left join public.profiles p on p.id = e.created_by
    where e.review = 'pending' and public.is_staff()
    order by e.created_at;
end;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('76_sent_nights.sql', '6083e440d0d3933f27cc25255c38e079b8d251c5e3994c4741ba85b8eeccb3e8');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('76_sent_nights.sql');
  end if;
end $$;

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
