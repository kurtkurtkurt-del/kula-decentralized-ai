-- pasaport — people: the card, the settings, the search, leaving
--
--   handle_status(handle)                   ok · empty · format · taken · yours
--   profile_setup(handle, name, city, bio)  finishes sign-up; 'ok' or the reason
--   profile_me()                            your own card, counts and settings in one read
--   settings_set(jsonb)                     the settings a person may change about themselves
--   profile_card(handle)                    somebody's card, as much as they allow
--   people_search(q, limit)                 by handle or name, discoverable people only
--   people_suggested(limit)                 friends of friends first, then your city
--   seen()                                  stamps last_seen_at (friends see the day only)
--   export_me()                             everything about you, as one json
--   delete_account()                        really deletes; cascades take the rest
--
-- The tables are closed; every call is definer and asks the door first.

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
    when lower(btrim(p_handle)) in ('admin', 'pasaport', 'support', 'staff', 'help') then 'taken'
    when exists (select 1 from public.profiles where handle = lower(btrim(p_handle)) and id = auth.uid()) then 'yours'
    when exists (select 1 from public.profiles where handle = lower(btrim(p_handle))) then 'taken'
    else 'ok'
  end;
$$;
grant execute on function public.handle_status(text) to anon, authenticated;

create or replace function public.profile_setup(p_handle text, p_display_name text default null, p_city_slug text default null, p_bio text default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  state text := public.handle_status(p_handle);
  city_uuid uuid;
begin
  if state not in ('ok', 'yours') then return state; end if;
  if coalesce(btrim(p_city_slug), '') <> '' then
    select id into city_uuid from public.cities where slug = lower(btrim(p_city_slug));
    if city_uuid is null then return 'nocity'; end if;
  end if;
  update public.profiles set
    handle = lower(btrim(p_handle)),
    display_name = coalesce(nullif(btrim(p_display_name), ''), display_name),
    city_id = coalesce(city_uuid, city_id),
    bio = case when p_bio is null then bio else nullif(btrim(p_bio), '') end,
    onboarded_at = coalesce(onboarded_at, now())
  where id = me;
  insert into public.profile_settings (user_id) values (me) on conflict (user_id) do nothing;
  return 'ok';
end;
$$;

drop function if exists public.profile_me();
create or replace function public.profile_me()
returns table (
  id uuid, handle text, display_name text, bio text, city_slug text, city_name text,
  is_admin boolean, onboarded boolean, created_at timestamptz,
  kept_count int, friend_count int, night_count int, credits numeric,
  kept_visibility text, discoverable boolean, locale text,
  night_from text, night_to text, wifi_only boolean,
  notify_friends boolean, notify_calls boolean, notify_coops boolean, notify_dms boolean, notify_cards boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  select p.id, p.handle, p.display_name, p.bio, c.slug, c.name,
         p.is_admin, p.onboarded_at is not null, p.created_at,
         (select count(*)::int from public.joins j where j.user_id = p.id and j.direction = 'right'),
         (select count(*)::int from public.friendships f where f.status = 'accepted' and p.id in (f.requester_id, f.addressee_id)),
         (select count(*)::int from public.contributions k where k.user_id = p.id and k.card_no is not null),
         coalesce((select sum(k.amount) from public.credits k where k.user_id = p.id), 0),
         s.kept_visibility, s.discoverable, s.locale,
         to_char(s.night_from, 'HH24:MI'), to_char(s.night_to, 'HH24:MI'), s.wifi_only,
         s.notify_friends, s.notify_calls, s.notify_coops, s.notify_dms, s.notify_cards
  from public.profiles p
  left join public.cities c on c.id = p.city_id
  join public.profile_settings s on s.user_id = p.id
  where p.id = me;
end;
$$;

-- The settings a person may change, as one object with only the keys they send.
create or replace function public.settings_set(p_patch jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  update public.profile_settings s set
    kept_visibility = coalesce(p_patch ->> 'kept_visibility', s.kept_visibility),
    discoverable = coalesce((p_patch ->> 'discoverable')::boolean, s.discoverable),
    locale = coalesce(p_patch ->> 'locale', s.locale),
    night_from = coalesce((p_patch ->> 'night_from')::time, s.night_from),
    night_to = coalesce((p_patch ->> 'night_to')::time, s.night_to),
    wifi_only = coalesce((p_patch ->> 'wifi_only')::boolean, s.wifi_only),
    notify_friends = coalesce((p_patch ->> 'notify_friends')::boolean, s.notify_friends),
    notify_calls = coalesce((p_patch ->> 'notify_calls')::boolean, s.notify_calls),
    notify_coops = coalesce((p_patch ->> 'notify_coops')::boolean, s.notify_coops),
    notify_dms = coalesce((p_patch ->> 'notify_dms')::boolean, s.notify_dms),
    notify_cards = coalesce((p_patch ->> 'notify_cards')::boolean, s.notify_cards)
  where s.user_id = me;
  if p_patch ? 'display_name' or p_patch ? 'bio' or p_patch ? 'city_slug' then
    update public.profiles p set
      display_name = case when p_patch ? 'display_name' then nullif(btrim(p_patch ->> 'display_name'), '') else p.display_name end,
      bio = case when p_patch ? 'bio' then nullif(btrim(p_patch ->> 'bio'), '') else p.bio end,
      city_id = case when p_patch ? 'city_slug' then (select c.id from public.cities c where c.slug = p_patch ->> 'city_slug') else p.city_id end
    where p.id = me;
  end if;
end;
$$;

-- Identity by handle; the only thing that leaks is whether such a person exists.
create or replace function public.handle_to_id(p_handle text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id from public.profiles where handle = lower(btrim(regexp_replace(coalesce(p_handle, ''), '^@', '')));
$$;
revoke execute on function public.handle_to_id(text) from public, anon, authenticated;

-- friend · outgoing · incoming · none
create or replace function public.people_relation(p_me uuid, p_other uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select case when f.status = 'accepted' then 'friend' when f.requester_id = p_me then 'outgoing' else 'incoming' end
                   from public.friendships f
                   where (f.requester_id = p_me and f.addressee_id = p_other) or (f.addressee_id = p_me and f.requester_id = p_other)
                   limit 1), 'none');
$$;
create or replace function public.people_mutual(p_me uuid, p_other uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  with mine as (select case when f.requester_id = p_me then f.addressee_id else f.requester_id end as id
                from public.friendships f where f.status = 'accepted' and p_me in (f.requester_id, f.addressee_id)),
       theirs as (select case when f.requester_id = p_other then f.addressee_id else f.requester_id end as id
                  from public.friendships f where f.status = 'accepted' and p_other in (f.requester_id, f.addressee_id))
  select count(*)::int from mine join theirs using (id);
$$;
revoke execute on function public.people_relation(uuid, uuid), public.people_mutual(uuid, uuid) from public, anon, authenticated;

-- Somebody's card: the number of nights and projects only to the person and to friends.
drop function if exists public.profile_card(text);
create or replace function public.profile_card(p_handle text)
returns table (id uuid, handle text, display_name text, bio text, city_name text, created_at timestamptz,
               last_seen_day date, relation text, mutual int, kept_count int, night_count int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  select p.id, p.handle, p.display_name, p.bio, c.name, p.created_at,
         case when p.id = me or public.are_friends(me, p.id) then p.last_seen_at::date end,
         public.people_relation(me, p.id), public.people_mutual(me, p.id),
         case when p.id = me or (public.are_friends(me, p.id) and coalesce(s.kept_visibility, 'friends') = 'friends')
              then (select count(*)::int from public.joins j where j.user_id = p.id and j.direction = 'right') end,
         case when p.id = me or public.are_friends(me, p.id)
              then (select count(*)::int from public.contributions k where k.user_id = p.id and k.card_no is not null) end
  from public.profiles p
  left join public.cities c on c.id = p.city_id
  left join public.profile_settings s on s.user_id = p.id
  where p.handle = lower(btrim(regexp_replace(coalesce(p_handle, ''), '^@', '')))
    and public.visible_to(me, p.id);
end;
$$;

create or replace function public.people_search(p_query text, p_limit int default 12)
returns table (id uuid, handle text, display_name text, city_name text, mutual int, relation text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  q text := lower(btrim(regexp_replace(coalesce(p_query, ''), '^@', '')));
  safe text;
begin
  if length(q) < 2 then return; end if;
  safe := replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_');
  return query
  select p.id, p.handle, p.display_name, c.name, public.people_mutual(me, p.id), public.people_relation(me, p.id)
  from public.profiles p left join public.cities c on c.id = p.city_id
  where p.handle is not null and p.id <> me and public.visible_to(me, p.id)
    and (p.handle like safe || '%' or lower(coalesce(p.display_name, '')) like '%' || safe || '%')
  order by (p.handle = q) desc, (p.handle like safe || '%') desc, public.people_mutual(me, p.id) desc, p.handle
  limit least(greatest(coalesce(p_limit, 12), 1), 20);
end;
$$;

create or replace function public.people_suggested(p_limit int default 3)
returns table (id uuid, handle text, display_name text, city_name text, mutual int, reason text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  with mine as (select p.city_id from public.profiles p where p.id = me),
  pool as (
    select p.id, p.handle, p.display_name, c.name as city_name, public.people_mutual(me, p.id) as mutual,
           (p.city_id is not null and p.city_id = (select city_id from mine)) as same_city, p.last_seen_at
    from public.profiles p left join public.cities c on c.id = p.city_id
    where p.handle is not null and p.id <> me
      and public.people_relation(me, p.id) = 'none' and public.visible_to(me, p.id))
  select pool.id, pool.handle, pool.display_name, pool.city_name, pool.mutual,
         case when pool.mutual > 0 then 'mutual' when pool.same_city then 'city' else 'new' end
  from pool order by pool.mutual desc, pool.same_city desc, pool.last_seen_at desc nulls last, pool.handle
  limit least(greatest(coalesce(p_limit, 3), 1), 12);
end;
$$;

create or replace function public.seen()
returns void
language sql
security definer
set search_path = public
as $$
  update public.profiles set last_seen_at = now() where id = public.assert_member();
$$;

-- Everything about you, as one document (the settings page's "download my data").
-- Later files add their own tables to it by replacing this function.
create or replace function public.export_me()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) - 'is_admin' from public.profiles p where p.id = me),
    'settings', (select to_jsonb(s) from public.profile_settings s where s.user_id = me),
    'joins', (select coalesce(jsonb_agg(jsonb_build_object('project', r.slug, 'direction', j.direction, 'at', j.created_at)), '[]')
              from public.joins j join public.projects r on r.id = j.project_id where j.user_id = me),
    'friends', (select coalesce(jsonb_agg(jsonb_build_object('handle', p.handle, 'status', f.status)), '[]')
                from public.friendships f join public.profiles p on p.id = case when f.requester_id = me then f.addressee_id else f.requester_id end
                where me in (f.requester_id, f.addressee_id)));
end;
$$;

create or replace function public.delete_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'sign in first' using errcode = '42501'; end if;
  delete from auth.users where id = me;
end;
$$;

revoke execute on function public.profile_setup(text, text, text, text), public.profile_me(), public.settings_set(jsonb),
  public.profile_card(text), public.people_search(text, int), public.people_suggested(int), public.seen(),
  public.export_me(), public.delete_account() from public, anon;
grant execute on function public.profile_setup(text, text, text, text), public.profile_me(), public.settings_set(jsonb),
  public.profile_card(text), public.people_search(text, int), public.people_suggested(int), public.seen(),
  public.export_me(), public.delete_account() to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('04_profiles.sql', 'ad02589384204ad99c6dab18bd3290c004b725f8d5e7b3de30c64d63d11d701b');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('04_profiles.sql');
  end if;
end $$;
