-- pasaport — the deck, the keep, the project page
--   deck(country, limit)       published, open projects you have not swiped; a guest sees all
--   join_set(slug, direction)  keep (right) or let go (left); swiping again overwrites
--   join_unset(slug)           undo: the card comes back
--   joins_reset()              every swipe of yours goes
--   kept()                     what you kept, newest first
--   friends_kept(limit)        what your friends kept (friends who allow it)
--   project_page(slug)         one project with its numbers: phones in, nights done so far
--   project_counts()           per project: how many keep it (the number, never who)
-- One row shape, projects_public, for all of them: flat columns, the same in every REST version.

drop view if exists public.projects_public cascade;
create view public.projects_public as
select p.id, p.slug, p.title, p.summary, p.model, p.params_b, p.nights_wanted, p.phones_wanted,
       p.est_kwh, p.est_eur, p.org, p.poster_no, p.image_url, p.status, p.created_at,
       c.slug as city_slug, c.name as city_name, c.country, c.lat, c.lng
from public.projects p left join public.cities c on c.id = p.city_id
where p.is_published;
revoke all on public.projects_public from public, anon, authenticated;

drop function if exists public.deck(text, int);
create or replace function public.deck(p_country text default null, p_limit int default 40)
returns setof public.projects_public
language sql
stable
security definer
set search_path = public
as $$
  select e.* from public.projects_public e
  where e.status = 'open'
    and (p_country is null or e.country = p_country)
    and not exists (select 1 from public.joins j where j.project_id = e.id and j.user_id = auth.uid())
  order by e.created_at, e.poster_no
  limit least(greatest(coalesce(p_limit, 40), 1), 200);
$$;
grant execute on function public.deck(text, int) to anon, authenticated;

create or replace function public.join_set(p_slug text, p_direction text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  pid uuid;
begin
  if p_direction not in ('left', 'right') then raise exception 'left or right' using errcode = '22023'; end if;
  select id into pid from public.projects where slug = p_slug and is_published;
  if pid is null then raise exception 'no such project' using errcode = '22023'; end if;
  insert into public.joins (user_id, project_id, direction) values (me, pid, p_direction)
  on conflict (user_id, project_id) do update set direction = excluded.direction, created_at = now();
end;
$$;
create or replace function public.join_unset(p_slug text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  delete from public.joins j using public.projects p where p.id = j.project_id and p.slug = p_slug and j.user_id = me;
end;
$$;
create or replace function public.joins_reset()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  n int;
begin
  with gone as (delete from public.joins where user_id = me returning 1) select count(*)::int into n from gone;
  return n;
end;
$$;

drop function if exists public.kept();
create or replace function public.kept()
returns setof public.projects_public
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  select e.* from public.joins j join public.projects_public e on e.id = j.project_id
  where j.user_id = me and j.direction = 'right' order by j.created_at desc;
end;
$$;

drop function if exists public.friends_kept(int);
create or replace function public.friends_kept(p_limit int default 60)
returns table (friend text, friend_id uuid, kept_at timestamptz, id uuid, slug text, title text, model text, city_name text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  select coalesce(p.handle, p.display_name), p.id, j.created_at, e.id, e.slug, e.title, e.model, e.city_name
  from public.joins j
  join public.projects_public e on e.id = j.project_id
  join public.profiles p on p.id = j.user_id
  left join public.profile_settings s on s.user_id = p.id
  where j.direction = 'right' and j.user_id <> me
    and public.are_friends(me, j.user_id) and public.reachable(me, j.user_id)
    and coalesce(s.kept_visibility, 'friends') = 'friends'
  order by j.created_at desc
  limit least(greatest(coalesce(p_limit, 60), 1), 200);
end;
$$;

-- One project and its numbers. A guest may read it (the site's share link opens here).
drop function if exists public.project_page(text);
create or replace function public.project_page(p_slug text)
returns table (id uuid, slug text, title text, summary text, model text, params_b numeric, nights_wanted int, phones_wanted int,
               est_kwh numeric, est_eur numeric, org text, poster_no int, image_url text, status text,
               city_slug text, city_name text, country text, lat double precision, lng double precision,
               phones_in int, nights_done int, tokens bigint, kept boolean, friends text[])
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.slug, e.title, e.summary, e.model, e.params_b, e.nights_wanted, e.phones_wanted,
         e.est_kwh, e.est_eur, e.org, e.poster_no, e.image_url, e.status,
         e.city_slug, e.city_name, e.country, e.lat, e.lng,
         (select count(*)::int from public.joins j where j.project_id = e.id and j.direction = 'right'),
         (select count(*)::int from public.contributions k where k.project_id = e.id and k.card_no is not null),
         coalesce((select sum(k.tokens) from public.contributions k where k.project_id = e.id), 0)::bigint,
         exists (select 1 from public.joins j where j.project_id = e.id and j.user_id = auth.uid() and j.direction = 'right'),
         coalesce((select array_agg(coalesce(p.handle, p.display_name) order by j.created_at desc)
                   from public.joins j join public.profiles p on p.id = j.user_id
                   left join public.profile_settings s on s.user_id = p.id
                   where j.project_id = e.id and j.direction = 'right' and j.user_id <> auth.uid()
                     and auth.uid() is not null and public.are_friends(auth.uid(), j.user_id)
                     and coalesce(s.kept_visibility, 'friends') = 'friends'), '{}')
  from public.projects_public e where e.slug = p_slug;
$$;
grant execute on function public.project_page(text) to anon, authenticated;

drop function if exists public.project_counts();
create or replace function public.project_counts()
returns table (project_id uuid, n int)
language sql
stable
security definer
set search_path = public
as $$
  select j.project_id, count(*)::int from public.joins j where j.direction = 'right' group by j.project_id;
$$;
grant execute on function public.project_counts() to anon, authenticated;

revoke execute on function public.join_set(text, text), public.join_unset(text), public.joins_reset(), public.kept(), public.friends_kept(int) from public, anon;
grant execute on function public.join_set(text, text), public.join_unset(text), public.joins_reset(), public.kept(), public.friends_kept(int) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('06_deck.sql', '737310bfc894c73c9685295f9c8673c7a9b1c4ec5b74449f43d5ee49ac4db978');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('06_deck.sql');
  end if;
end $$;
