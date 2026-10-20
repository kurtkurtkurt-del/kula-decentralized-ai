-- afterhours — check-in, the afterhours card, and the room
--
-- The heart of the product, in three tables and a handful of calls.
--
--   checkins    one row per person per night: "I was there". Written only
--               through check_in(), which asks two questions: is it that
--               night right now (six hours before the start until twelve
--               after), and are you close (500 m) when both sides have a
--               point. Every row takes a card number from one shared
--               sequence, so NO. 0208 means the 208th card ever issued.
--   room_posts  what the people who were there say, up to 200 characters.
--               Only they can read it, only they can write it, and only
--               until the room freezes: 48 hours after the night ends.
--   my_cards    everything the card generator needs, one row per card.
--
-- Nobody sees who checked in where except the person, their confirmed
-- friends (if show_friends is on), and the others in the same room, who
-- see initials only.

create sequence if not exists public.card_no_seq;

create table if not exists public.checkins (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references public.profiles on delete cascade,
  event_id      uuid not null references public.events on delete cascade,
  card_no       bigint not null default nextval('public.card_no_seq'),
  checked_at    timestamptz not null default now(),
  lat           double precision,
  lng           double precision,
  show_friends  boolean not null default true,
  unique (user_id, event_id)
);
create index if not exists checkins_event_idx on public.checkins (event_id);
create index if not exists checkins_user_idx  on public.checkins (user_id, checked_at desc);

create table if not exists public.room_posts (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events on delete cascade,
  user_id     uuid default auth.uid() references public.profiles on delete set null,
  body        text not null check (length(btrim(body)) between 1 and 200),
  created_at  timestamptz not null default now()
);
create index if not exists room_posts_event_idx on public.room_posts (event_id, created_at);

alter table public.checkins   enable row level security;
alter table public.room_posts enable row level security;

-- ------------------------------------------------------------ helpers

-- confirmed friends, either direction
create or replace function public.is_friend(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester_id = auth.uid() and f.addressee_id = other)
        or (f.addressee_id = auth.uid() and f.requester_id = other))
  );
$$;

-- when a room freezes: the night ends eight hours after it starts, the
-- room stays open 48 hours after that. A night without a date runs from
-- its first check-in.
create or replace function public.room_freeze_at(p_event uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(e.starts_at, (select min(c.checked_at) from public.checkins c where c.event_id = e.id), now())
         + interval '8 hours' + interval '48 hours'
  from public.events e where e.id = p_event;
$$;

create or replace function public.checked_in(p_event uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.checkins c where c.event_id = p_event and c.user_id = auth.uid());
$$;

-- ------------------------------------------------------------- rules

drop policy if exists checkins_read on public.checkins;
create policy checkins_read on public.checkins for select
  using (user_id = auth.uid() or (show_friends and public.is_friend(user_id)));

drop policy if exists checkins_update on public.checkins;
create policy checkins_update on public.checkins for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- no insert policy on purpose: rows come through check_in() below

drop policy if exists room_posts_read on public.room_posts;
create policy room_posts_read on public.room_posts for select
  using (public.checked_in(event_id));

drop policy if exists room_posts_write on public.room_posts;
create policy room_posts_write on public.room_posts for insert
  with check (user_id = auth.uid() and public.checked_in(event_id) and now() < public.room_freeze_at(event_id));

drop policy if exists room_posts_delete on public.room_posts;
create policy room_posts_delete on public.room_posts for delete
  using (user_id = auth.uid());

-- ----------------------------------------------------------- check in

-- Returns the card number. Errors are short codes the app turns into
-- sentences: signedout, nonight, notnow, far.
create or replace function public.check_in(
  p_slug text,
  p_lat  double precision default null,
  p_lng  double precision default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  e   public.events%rowtype;
  n   bigint;
  km  double precision;
begin
  if auth.uid() is null then raise exception 'signedout'; end if;
  select * into e from public.events where slug = p_slug and is_published;
  if not found then raise exception 'nonight'; end if;

  if e.starts_at is not null
     and (now() < e.starts_at - interval '6 hours' or now() > e.starts_at + interval '12 hours') then
    raise exception 'notnow';
  end if;

  if e.lat is not null and e.lng is not null and p_lat is not null and p_lng is not null then
    km := 2 * 6371.0 * asin(sqrt(
            power(sin(radians(e.lat - p_lat) / 2), 2)
            + cos(radians(p_lat)) * cos(radians(e.lat))
            * power(sin(radians(e.lng - p_lng) / 2), 2)));
    if km > 0.5 then raise exception 'far'; end if;
  end if;

  insert into public.checkins (user_id, event_id, lat, lng)
  values (auth.uid(), e.id, p_lat, p_lng)
  on conflict (user_id, event_id) do nothing;

  select card_no into n from public.checkins where user_id = auth.uid() and event_id = e.id;
  return n;
end;
$$;

-- ------------------------------------------------------------- cards

-- One row per card, shaped for the generator: the night, when you came,
-- who else was there (initials, never ids), how many spoke, the first two
-- lines from the room, and when it froze.
drop function if exists public.my_cards();
create or replace function public.my_cards()
returns table (
  card_no     bigint,
  checked_at  timestamptz,
  freeze_at   timestamptz,
  frozen      boolean,
  slug        text,
  title       text,
  type_name   text,
  venue_name  text,
  city_name   text,
  starts_at   timestamptz,
  image_url   text,
  crew        text[],
  crew_more   int,
  who_count   int,
  post_count  int,
  q1_body     text,
  q1_who      text,
  q1_at       timestamptz,
  q2_body     text,
  q2_who      text,
  q2_at       timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with mine as (
    select c.*, public.room_freeze_at(c.event_id) as freeze_at
    from public.checkins c where c.user_id = auth.uid()
  ),
  others as (
    select c.event_id,
           array_agg(lower(left(coalesce(p.display_name, p.handle, 's'), 1)) order by c.checked_at) as initials,
           count(*)::int as n
    from public.checkins c
    join public.profiles p on p.id = c.user_id
    where c.user_id <> auth.uid() and c.event_id in (select event_id from mine)
    group by c.event_id
  ),
  posts as (
    select r.event_id, r.body, lower(left(coalesce(p.display_name, p.handle, 's'), 1)) as who, r.created_at,
           row_number() over (partition by r.event_id order by r.created_at) as rn,
           count(*) over (partition by r.event_id)::int as total
    from public.room_posts r
    left join public.profiles p on p.id = r.user_id
    where r.event_id in (select event_id from mine)
  )
  select m.card_no, m.checked_at, m.freeze_at, now() >= m.freeze_at,
         e.slug, e.title, t.name, v.name, ci.name, e.starts_at, e.image_url,
         coalesce(o.initials[1:4], '{}'), greatest(coalesce(o.n, 0) - 4, 0),
         coalesce(o.n, 0) + 1,
         coalesce((select total from posts p where p.event_id = m.event_id limit 1), 0),
         (select body from posts p where p.event_id = m.event_id and rn = 1),
         (select who  from posts p where p.event_id = m.event_id and rn = 1),
         (select created_at from posts p where p.event_id = m.event_id and rn = 1),
         (select body from posts p where p.event_id = m.event_id and rn = 2),
         (select who  from posts p where p.event_id = m.event_id and rn = 2),
         (select created_at from posts p where p.event_id = m.event_id and rn = 2)
  from mine m
  join public.events e on e.id = m.event_id
  join public.event_types t on t.id = e.type_id
  join public.cities ci on ci.id = e.city_id
  left join public.venues v on v.id = e.venue_id
  left join others o on o.event_id = m.event_id
  order by m.checked_at desc;
$$;

-- -------------------------------------------------------------- room

create or replace function public.room_info(p_slug text)
returns table (
  event_id    uuid,
  checked_in  boolean,
  freeze_at   timestamptz,
  frozen      boolean,
  who_count   int,
  initials    text[]
)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, public.checked_in(e.id), public.room_freeze_at(e.id), now() >= public.room_freeze_at(e.id),
         (select count(*)::int from public.checkins c where c.event_id = e.id),
         case when public.checked_in(e.id)
              then (select coalesce(array_agg(lower(left(coalesce(p.display_name, p.handle, 's'), 1)) order by c.checked_at), '{}')
                    from public.checkins c join public.profiles p on p.id = c.user_id where c.event_id = e.id)
              else '{}' end
  from public.events e where e.slug = p_slug;
$$;

create or replace function public.room_list(p_slug text)
returns table (
  id          uuid,
  body        text,
  who         text,
  mine        boolean,
  created_at  timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select r.id, r.body, lower(left(coalesce(p.display_name, p.handle, 's'), 1)), r.user_id = auth.uid(), r.created_at
  from public.room_posts r
  join public.events e on e.id = r.event_id
  left join public.profiles p on p.id = r.user_id
  where e.slug = p_slug and public.checked_in(e.id)
  order by r.created_at;
$$;

create or replace function public.room_post(p_slug text, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  ev uuid;
  n  uuid;
begin
  if auth.uid() is null then raise exception 'signedout'; end if;
  select id into ev from public.events where slug = p_slug;
  if ev is null then raise exception 'nonight'; end if;
  if not public.checked_in(ev) then raise exception 'notthere'; end if;
  if now() >= public.room_freeze_at(ev) then raise exception 'frozen'; end if;
  insert into public.room_posts (event_id, user_id, body) values (ev, auth.uid(), btrim(p_body)) returning id into n;
  return n;
end;
$$;

-- --------------------------------------------------- friends, tonight

-- where your confirmed friends are right now (last 8 hours), if they let you see
create or replace function public.friends_live()
returns table (
  friend_id     uuid,
  handle        text,
  display_name  text,
  slug          text,
  title         text,
  venue_name    text,
  checked_at    timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select c.user_id, p.handle, p.display_name, e.slug, e.title, v.name, c.checked_at
  from public.checkins c
  join public.profiles p on p.id = c.user_id
  join public.events e on e.id = c.event_id
  left join public.venues v on v.id = e.venue_id
  where c.show_friends
    and c.checked_at > now() - interval '8 hours'
    and public.is_friend(c.user_id)
  order by c.checked_at desc;
$$;

grant execute on function public.is_friend(uuid)                         to authenticated;
grant execute on function public.room_freeze_at(uuid)                    to anon, authenticated;
grant execute on function public.checked_in(uuid)                        to authenticated;
grant execute on function public.check_in(text, double precision, double precision) to authenticated;
grant execute on function public.my_cards()                              to authenticated;
grant execute on function public.room_info(text)                         to anon, authenticated;
grant execute on function public.room_list(text)                         to authenticated;
grant execute on function public.room_post(text, text)                   to authenticated;
grant execute on function public.friends_live()                          to authenticated;
grant select, update on public.checkins to authenticated;
grant select, insert, delete on public.room_posts to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('19_checkins.sql', '20c26372a269344c166562e355958ef7a756774194c77e03adf674cf596b4b73');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('19_checkins.sql');
  end if;
end $$;
