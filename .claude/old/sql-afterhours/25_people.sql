-- afterhours — finding people: search and suggestions
-- 07 could only send a request to a handle you already knew by heart.
-- These two calls let the yours tab find someone:
--
--   people_search(q)     by handle or name, as you type
--   people_suggested(n)  a few you may know: the friends of your friends first,
--                        then people in your city
--
-- Both go around the profiles rule (the row of a stranger is closed), so both are
-- definer functions that hand back only the public card: handle, name, city.
-- Nobody hidden by "discoverable = off" appears in either. What someone kept
-- is never used for a stranger: kept nights are for friends only (12).

-- ------------------------------------------------ how you stand with someone

-- friend · outgoing (you asked) · incoming (they asked) · none
create or replace function public.people_relation(other uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select case
              when f.status = 'accepted' then 'friend'
              when f.requester_id = auth.uid() then 'outgoing'
              else 'incoming'
            end
     from public.friendships f
     where (f.requester_id = auth.uid() and f.addressee_id = other)
        or (f.addressee_id = auth.uid() and f.requester_id = other)
     limit 1),
    'none');
$$;

-- How many confirmed friends you and someone share.
create or replace function public.people_mutual(other uuid)
returns int
language sql
stable
security definer
set search_path = public
as $$
  with mine as (
    select case when f.requester_id = auth.uid() then f.addressee_id else f.requester_id end as id
    from public.friendships f
    where f.status = 'accepted' and auth.uid() in (f.requester_id, f.addressee_id)
  ),
  theirs as (
    select case when f.requester_id = other then f.addressee_id else f.requester_id end as id
    from public.friendships f
    where f.status = 'accepted' and other in (f.requester_id, f.addressee_id)
  )
  select count(*)::int from mine join theirs using (id);
$$;

-- ------------------------------------------------------------------ search

-- Two letters at least; a dozen answers at most. The handle is matched from
-- its start, the name anywhere in it. % and _ typed by the person are taken
-- literally, not as wildcards.
drop function if exists public.people_search(text, int);
create or replace function public.people_search(p_query text, p_limit int default 12)
returns table (
  id            uuid,
  handle        text,
  display_name  text,
  city_name     text,
  mutual        int,
  relation      text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  q    text := lower(btrim(regexp_replace(coalesce(p_query, ''), '^@', '')));
  safe text;
begin
  if auth.uid() is null or length(q) < 2 then
    return;
  end if;
  safe := replace(replace(replace(q, '\', '\\'), '%', '\%'), '_', '\_');
  return query
    select p.id, p.handle, p.display_name, c.name,
           public.people_mutual(p.id), public.people_relation(p.id)
    from public.profiles p
    left join public.cities c on c.id = p.city_id
    where p.handle is not null
      and p.id <> auth.uid()
      and public.card_visible(p.id)
      and (p.handle like safe || '%' or lower(coalesce(p.display_name, '')) like '%' || safe || '%')
    order by (p.handle = q) desc,
             (p.handle like safe || '%') desc,
             public.people_mutual(p.id) desc,
             p.handle
    limit least(greatest(coalesce(p_limit, 12), 1), 20);
end;
$$;

-- ------------------------------------------------------------- suggestions

-- Someone you have no link with yet. Order: shared friends (most first),
-- then the same city, then who was around lately. reason tells the app
-- which line to write under the card: mutual · city · new.
drop function if exists public.people_suggested(int);
create or replace function public.people_suggested(p_limit int default 3)
returns table (
  id            uuid,
  handle        text,
  display_name  text,
  city_name     text,
  mutual        int,
  reason        text
)
language sql
stable
security definer
set search_path = public
as $$
  with me as (
    select p.city_id from public.profiles p where p.id = auth.uid()
  ),
  pool as (
    select p.id, p.handle, p.display_name, c.name as city_name,
           public.people_mutual(p.id) as mutual,
           (p.city_id is not null and p.city_id = (select city_id from me)) as same_city,
           p.last_seen_at
    from public.profiles p
    left join public.cities c on c.id = p.city_id
    where auth.uid() is not null
      and p.handle is not null
      and p.id <> auth.uid()
      and not public.is_linked(p.id)
      and public.card_visible(p.id)
  )
  select id, handle, display_name, city_name, mutual,
         case when mutual > 0 then 'mutual' when same_city then 'city' else 'new' end
  from pool
  order by mutual desc, same_city desc, last_seen_at desc nulls last, handle
  limit least(greatest(coalesce(p_limit, 3), 1), 12);
$$;

revoke execute on function public.people_relation(uuid)      from public, anon;
revoke execute on function public.people_mutual(uuid)        from public, anon;
revoke execute on function public.people_search(text, int)   from public, anon;
revoke execute on function public.people_suggested(int)      from public, anon;
grant execute on function public.people_relation(uuid)       to authenticated;
grant execute on function public.people_mutual(uuid)         to authenticated;
grant execute on function public.people_search(text, int)    to authenticated;
grant execute on function public.people_suggested(int)       to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('25_people.sql', '4881b3365b5165d7527cd2210d01d09d26b2196cee59b2c3ea211bfb5817e9fb');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('25_people.sql');
  end if;
end $$;
