-- afterhours — the staff: admin, community managers, djs who run their own page (42)
--
-- 41 gave every profile a type as a label. Here the types start to mean something:
--
--   normal user        as before.
--   dj                 opens and edits one dj page of their own, and lists the
--                      nights they play (dj_save_mine, dj_set_add).
--   community manager  creates and edits nights, rooms (venues) and djs, hides
--                      comments. Only an admin makes someone one.
--   admin              everything a community manager can, plus: people and
--                      their types, feedback, the log. An admin is
--                      profiles.is_admin, appointed in the SQL editor as before.
--
-- Because the types now carry power, the code that equals the name can no longer
-- reach them: set_account_type only switches between normal user and dj.
-- Anyone who typed their way to "admin" or "community manager" under 41 goes back
-- to normal user below.
--
-- Every write by the staff goes through a function here (security definer, with
-- its own check) and leaves a line in staff_log, so it is always clear who made
-- what. Nights made here carry source = staff; the ticketmaster sync and the seed
-- cleanup never touch them.

-- ------------------------------------------------------------- who is who

-- Under 41 anyone could pick admin or community manager with the name as code.
update public.profiles set account_type = 'user'
  where account_type in ('admin', 'community_manager') and not is_admin;
update public.profiles set account_type = 'admin' where is_admin and account_type <> 'admin';

create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select p.is_admin or p.account_type = 'community_manager'
                   from public.profiles p where p.id = auth.uid()), false);
$$;

create or replace function public.my_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case when p.is_admin then 'admin' else p.account_type end
  from public.profiles p where p.id = auth.uid();
$$;

grant execute on function public.is_staff() to authenticated;
grant execute on function public.my_role() to authenticated;

-- The code still switches between normal user and dj; the other two are given.
create or replace function public.set_account_type(p_type text, p_code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  name text := case p_type when 'user' then 'normal user' when 'dj' then 'dj' end;
  me public.profiles%rowtype;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if p_type in ('community_manager', 'admin') then return 'locked'; end if;
  if name is null then return 'type'; end if;
  select * into me from public.profiles where id = auth.uid();
  if me.is_admin or me.account_type = 'community_manager' then return 'locked'; end if;
  if lower(btrim(coalesce(p_code, ''))) <> name then return 'code'; end if;
  perform set_config('afterhours.account_type', 'on', true);
  update public.profiles set account_type = p_type where id = auth.uid();
  perform set_config('afterhours.account_type', '', true);
  return 'ok';
end;
$$;

-- --------------------------------------------------------------- the log

create table if not exists public.staff_log (
  id          bigserial primary key,
  actor_id    uuid references public.profiles on delete set null,
  action      text not null,
  target      text not null,
  target_id   text,
  note        text,
  at          timestamptz not null default now()
);
create index if not exists staff_log_at_idx on public.staff_log (at desc);
alter table public.staff_log enable row level security;
revoke all on public.staff_log from public, anon, authenticated;

create or replace function public.staff_note(p_action text, p_target text, p_id text, p_note text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.staff_log (actor_id, action, target, target_id, note)
  values (auth.uid(), p_action, p_target, p_id, left(p_note, 200));
$$;
revoke all on function public.staff_note(text, text, text, text) from public, anon, authenticated;

-- ------------------------------------------------------------- the columns

alter table public.events add column if not exists created_by uuid references public.profiles on delete set null;
alter table public.venues add column if not exists created_by uuid references public.profiles on delete set null;
alter table public.djs add column if not exists created_by uuid references public.profiles on delete set null;
alter table public.djs add column if not exists owner_id uuid references public.profiles on delete set null;
alter table public.djs add column if not exists bio text check (bio is null or length(bio) <= 600);
alter table public.dj_sets add column if not exists created_by uuid references public.profiles on delete set null;
create unique index if not exists djs_owner_idx on public.djs (owner_id) where owner_id is not null;

create or replace function public.make_slug(p_text text)
returns text
language sql
volatile
as $$
  select coalesce(nullif(trim(both '-' from left(regexp_replace(lower(coalesce(p_text, '')), '[^a-z0-9]+', '-', 'g'), 60)), ''), 'x')
         || '-' || substr(md5(random()::text), 1, 6);
$$;

create or replace function public.need_staff()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_staff() then raise exception 'staff only' using errcode = '42501'; end if;
end;
$$;

-- ----------------------------------------------------------------- venues

-- p_id null makes a new room; otherwise edits it. Returns the id.
create or replace function public.staff_venue_save(p_id uuid, p_city text, p_name text, p_lat double precision, p_lng double precision)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  c uuid;
  v uuid;
  n text := btrim(coalesce(p_name, ''));
begin
  perform public.need_staff();
  if length(n) not between 2 and 80 then raise exception 'name: 2 to 80 characters'; end if;
  select id into c from public.cities where slug = p_city;
  if c is null then raise exception 'unknown city'; end if;
  if p_lat is not null and (p_lat not between -90 and 90 or p_lng is null or p_lng not between -180 and 180) then
    raise exception 'that point is not on the map';
  end if;
  if p_id is null then
    insert into public.venues (city_id, slug, name, lat, lng, created_by)
    values (c, public.make_slug(n), n, p_lat, p_lng, auth.uid()) returning id into v;
    perform public.staff_note('create', 'venue', v::text, n);
  else
    update public.venues set city_id = c, name = n, lat = p_lat, lng = p_lng where id = p_id returning id into v;
    if v is null then raise exception 'no such room'; end if;
    perform public.staff_note('edit', 'venue', v::text, n);
  end if;
  return v;
end;
$$;

-- ----------------------------------------------------------------- nights

-- p_date YYYY-MM-DD and p_time HH:MM are the local time of the night, stored
-- the way the ticketmaster sync stores it. Returns the slug.
create or replace function public.staff_event_save(
  p_id uuid, p_title text, p_city text, p_type text, p_venue uuid,
  p_date text, p_time text, p_body text, p_ticket_url text, p_image_url text, p_published boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.cities%rowtype;
  ty uuid;
  v public.venues%rowtype;
  t text := btrim(coalesce(p_title, ''));
  d date;
  hm text := coalesce(nullif(btrim(p_time), ''), '22:00');
  short text;
  s text;
  old public.events%rowtype;
begin
  perform public.need_staff();
  if length(t) not between 2 and 120 then raise exception 'title: 2 to 120 characters'; end if;
  select * into c from public.cities where slug = p_city;
  if c.id is null then raise exception 'unknown city'; end if;
  select id into ty from public.event_types where slug = p_type;
  if ty is null then raise exception 'unknown kind'; end if;
  if p_venue is not null then
    select * into v from public.venues where id = p_venue;
    if v.id is null or v.city_id <> c.id then raise exception 'that room is not in this city'; end if;
  end if;
  begin d := p_date::date; exception when others then raise exception 'date: YYYY-MM-DD'; end;
  if hm !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'time: HH:MM'; end if;
  if d < current_date - 1 then raise exception 'that night is over'; end if;
  if coalesce(p_ticket_url, '') <> '' and p_ticket_url !~ '^https://' then raise exception 'ticket link: https:// only'; end if;
  if coalesce(p_image_url, '') <> '' and p_image_url !~ '^https://' then raise exception 'photo link: https:// only'; end if;
  if length(coalesce(p_body, '')) > 2000 then raise exception 'text: at most 2000 characters'; end if;

  short := to_char(d, 'DD.MM.YY');
  if p_id is null then
    insert into public.events (slug, city_id, type_id, venue_id, title, meta, body, starts_at, starts_at_estimated,
                               date_text, is_published, source, image_url, ticket_url, lat, lng, created_by)
    values (public.make_slug(t), c.id, ty, v.id, t, concat_ws(' · ', coalesce(v.name, c.name), short, hm),
            coalesce(btrim(p_body), ''), (d::text || 'T' || hm)::timestamptz, false, short || ' · ' || hm,
            coalesce(p_published, true), 'staff', nullif(btrim(p_image_url), ''), nullif(btrim(p_ticket_url), ''),
            v.lat, v.lng, auth.uid())
    returning slug into s;
    perform public.staff_note('create', 'night', s, t);
  else
    select * into old from public.events where id = p_id;
    if old.id is null then raise exception 'no such night'; end if;
    if old.source <> 'staff' then raise exception 'only nights made here can be edited here'; end if;
    update public.events set city_id = c.id, type_id = ty, venue_id = v.id, title = t,
           meta = concat_ws(' · ', coalesce(v.name, c.name), short, hm), body = coalesce(btrim(p_body), ''),
           starts_at = (d::text || 'T' || hm)::timestamptz, date_text = short || ' · ' || hm,
           is_published = coalesce(p_published, true), image_url = nullif(btrim(p_image_url), ''),
           ticket_url = nullif(btrim(p_ticket_url), ''), lat = v.lat, lng = v.lng, updated_at = now()
     where id = p_id returning slug into s;
    perform public.staff_note('edit', 'night', s, t);
  end if;
  return s;
end;
$$;

-- An admin deletes any night made here; a community manager only their own.
create or replace function public.staff_event_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.events%rowtype;
begin
  perform public.need_staff();
  select * into e from public.events where id = p_id;
  if e.id is null then return; end if;
  if e.source <> 'staff' then raise exception 'only nights made here can be deleted here'; end if;
  if not public.is_admin() and e.created_by is distinct from auth.uid() then
    raise exception 'only the admin or whoever made it' using errcode = '42501';
  end if;
  delete from public.events where id = p_id;
  perform public.staff_note('delete', 'night', e.slug, e.title);
end;
$$;

-- The nights the staff made, newest first, unpublished ones too. (43 widens it;
-- the drop lets this file run again after that.)
drop function if exists public.staff_events(int);
create or replace function public.staff_events(p_limit int default 100)
returns table (id uuid, slug text, title text, city_slug text, type_slug text, venue_id uuid,
               starts_at timestamptz, body text, ticket_url text, image_url text, is_published boolean,
               created_by uuid, maker text)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.slug, e.title, c.slug, t.slug, e.venue_id, e.starts_at, e.body, e.ticket_url, e.image_url,
         e.is_published, e.created_by, p.display_name
  from public.events e
  join public.cities c on c.id = e.city_id
  join public.event_types t on t.id = e.type_id
  left join public.profiles p on p.id = e.created_by
  where e.source = 'staff' and public.is_staff()
  order by e.created_at desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

-- -------------------------------------------------------------------- djs

create or replace function public.dj_check(p_name text, p_genre text, p_sound text, p_bio text, p_photo text)
returns void
language plpgsql
immutable
as $$
begin
  if length(btrim(coalesce(p_name, ''))) not between 2 and 60 then raise exception 'name: 2 to 60 characters'; end if;
  if length(btrim(coalesce(p_genre, ''))) not between 2 and 60 then raise exception 'genre: 2 to 60 characters'; end if;
  if p_sound not in ('house', 'techno', 'rap') then raise exception 'sound: house, techno or rap'; end if;
  if length(coalesce(p_bio, '')) > 600 then raise exception 'about: at most 600 characters'; end if;
  if coalesce(p_photo, '') <> '' and p_photo !~ '^https://' then raise exception 'photo link: https:// only'; end if;
end;
$$;

-- Staff: p_id null makes a new dj page; otherwise edits one. Returns the slug.
create or replace function public.staff_dj_save(p_id uuid, p_name text, p_genre text, p_sound text,
                                                p_city text, p_bio text, p_photo text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  c uuid;
  s text;
begin
  perform public.need_staff();
  perform public.dj_check(p_name, p_genre, p_sound, p_bio, p_photo);
  select id into c from public.cities where slug = p_city;
  if p_id is null then
    insert into public.djs (slug, name, genre, sound, city_id, bio, photo_url, source, sort_order, created_by)
    values (public.make_slug(p_name), btrim(p_name), btrim(p_genre), p_sound, c, nullif(btrim(p_bio), ''),
            nullif(btrim(p_photo), ''), 'staff', 100, auth.uid())
    returning slug into s;
    perform public.staff_note('create', 'dj', s, btrim(p_name));
  else
    update public.djs set name = btrim(p_name), genre = btrim(p_genre), sound = p_sound, city_id = c,
           bio = nullif(btrim(p_bio), ''), photo_url = nullif(btrim(p_photo), '')
     where id = p_id returning slug into s;
    if s is null then raise exception 'no such dj'; end if;
    perform public.staff_note('edit', 'dj', s, btrim(p_name));
  end if;
  return s;
end;
$$;

-- A dj: the one page that is theirs.
create or replace function public.dj_mine()
returns table (id uuid, slug text, name text, genre text, sound text, city_slug text, bio text, photo_url text)
language sql
stable
security definer
set search_path = public
as $$
  select d.id, d.slug, d.name, d.genre, d.sound, c.slug, d.bio, d.photo_url
  from public.djs d left join public.cities c on c.id = d.city_id
  where d.owner_id = auth.uid();
$$;

create or replace function public.dj_save_mine(p_name text, p_genre text, p_sound text,
                                               p_city text, p_bio text, p_photo text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  c uuid;
  s text;
begin
  if coalesce(public.my_role(), '') <> 'dj' then
    raise exception 'switch your account to dj first' using errcode = '42501';
  end if;
  perform public.dj_check(p_name, p_genre, p_sound, p_bio, p_photo);
  select id into c from public.cities where slug = p_city;
  update public.djs set name = btrim(p_name), genre = btrim(p_genre), sound = p_sound, city_id = c,
         bio = nullif(btrim(p_bio), ''), photo_url = nullif(btrim(p_photo), '')
   where owner_id = auth.uid() returning slug into s;
  if s is null then
    insert into public.djs (slug, name, genre, sound, city_id, bio, photo_url, source, sort_order, owner_id, created_by)
    values (public.make_slug(p_name), btrim(p_name), btrim(p_genre), p_sound, c, nullif(btrim(p_bio), ''),
            nullif(btrim(p_photo), ''), 'self', 100, auth.uid(), auth.uid())
    returning slug into s;
    perform public.staff_note('create', 'dj', s, 'own page: ' || btrim(p_name));
  end if;
  return s;
end;
$$;

-- A night a dj plays: the staff for any dj, a dj for their own page.
create or replace function public.dj_set_add(p_dj uuid, p_venue text, p_city text, p_date text, p_time text, p_hours numeric)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  d date;
  hm text := coalesce(nullif(btrim(p_time), ''), '23:00');
  r uuid;
begin
  if not public.is_staff() and not exists (select 1 from public.djs where id = p_dj and owner_id = auth.uid()) then
    raise exception 'not your page' using errcode = '42501';
  end if;
  if not exists (select 1 from public.djs where id = p_dj) then raise exception 'no such dj'; end if;
  if length(btrim(coalesce(p_venue, ''))) not between 2 and 80 then raise exception 'room: 2 to 80 characters'; end if;
  begin d := p_date::date; exception when others then raise exception 'date: YYYY-MM-DD'; end;
  if hm !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'time: HH:MM'; end if;
  if d < current_date - 1 then raise exception 'that night is over'; end if;
  if coalesce(p_hours, 3) not between 0.5 and 24 then raise exception 'hours: 0.5 to 24'; end if;
  insert into public.dj_sets (dj_id, venue, city_id, starts_at, hours, created_by)
  values (p_dj, btrim(p_venue), (select id from public.cities where slug = p_city),
          (d::text || 'T' || hm)::timestamptz, coalesce(p_hours, 3), auth.uid())
  returning id into r;
  perform public.staff_note('create', 'set', r::text, btrim(p_venue) || ' · ' || p_date);
  return r;
end;
$$;

create or replace function public.dj_set_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_staff() and not exists (
    select 1 from public.dj_sets s join public.djs d on d.id = s.dj_id where s.id = p_id and d.owner_id = auth.uid()) then
    raise exception 'not your page' using errcode = '42501';
  end if;
  delete from public.dj_sets where id = p_id;
  perform public.staff_note('delete', 'set', p_id::text, null);
end;
$$;

-- The sets of one dj from today on, with their ids (for deleting).
create or replace function public.dj_sets_of(p_dj uuid)
returns table (id uuid, venue text, starts_at timestamptz, hours numeric)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.venue, s.starts_at, s.hours from public.dj_sets s
  where s.dj_id = p_dj and s.starts_at > now() - interval '12 hours'
  order by s.starts_at;
$$;

-- --------------------------------------------------------------- comments

-- Hiding was for the admin alone (02_rls.sql); now for the staff.
create or replace function public.guard_comment_hidden()
returns trigger
language plpgsql
as $$
begin
  if new.is_hidden is distinct from old.is_hidden
     and auth.uid() is not null
     and not public.is_staff() then
    raise exception 'is_hidden can only be changed by the staff';
  end if;
  return new;
end;
$$;

-- Staff hide (or show again) a comment; the author is not told.
create or replace function public.staff_comment_hide(p_id uuid, p_hidden boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  update public.comments set is_hidden = coalesce(p_hidden, true) where id = p_id;
  perform public.staff_note(case when coalesce(p_hidden, true) then 'hide' else 'show' end, 'comment', p_id::text, null);
end;
$$;

create or replace function public.staff_comments(p_limit int default 60)
returns table (id uuid, body text, author text, night text, night_slug text, is_hidden boolean, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.body, coalesce(p.display_name, m.author_name), e.title, e.slug, m.is_hidden, m.created_at
  from public.comments m
  join public.events e on e.id = m.event_id
  left join public.profiles p on p.id = m.author_id
  where public.is_staff()
  order by m.created_at desc
  limit greatest(1, least(coalesce(p_limit, 60), 300));
$$;

-- ------------------------------------------------------------------ admin

create or replace function public.need_admin()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
end;
$$;

-- Find people by handle or name; empty query: the staff first, then the newest.
create or replace function public.admin_people(p_query text)
returns table (id uuid, handle text, display_name text, role text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  q text := lower(btrim(coalesce(p_query, '')));
begin
  perform public.need_admin();
  return query
    select p.id, p.handle, p.display_name,
           case when p.is_admin then 'admin' else p.account_type end, p.created_at
    from public.profiles p
    where q = '' or lower(coalesce(p.handle, '')) like '%' || q || '%' or lower(coalesce(p.display_name, '')) like '%' || q || '%'
    order by (p.is_admin or p.account_type <> 'user') desc, p.created_at desc
    limit 60;
end;
$$;

-- The admin gives a type: normal user, dj or community manager. Admins are
-- appointed in the SQL editor, and an admin cannot be changed from here.
create or replace function public.admin_set_type(p_user uuid, p_type text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  who public.profiles%rowtype;
begin
  perform public.need_admin();
  if p_type not in ('user', 'dj', 'community_manager') then return 'type'; end if;
  select * into who from public.profiles where id = p_user;
  if who.id is null then return 'none'; end if;
  if who.is_admin then return 'admin'; end if;
  perform set_config('afterhours.account_type', 'on', true);
  update public.profiles set account_type = p_type where id = p_user;
  perform set_config('afterhours.account_type', '', true);
  perform public.staff_note('role', 'person', p_user::text, coalesce(who.handle, who.display_name) || ': ' || who.account_type || ' → ' || p_type);
  return 'ok';
end;
$$;

-- The numbers on the first page of the panel.
create or replace function public.admin_overview()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  return json_build_object(
    'people', (select count(*) from public.profiles),
    'people_week', (select count(*) from public.profiles where created_at > now() - interval '7 days'),
    'managers', (select count(*) from public.profiles where account_type = 'community_manager'),
    'djs', (select count(*) from public.profiles where account_type = 'dj'),
    'nights_ahead', (select count(*) from public.events where is_published and starts_at > now()),
    'nights_staff', (select count(*) from public.events where source = 'staff'),
    'venues', (select count(*) from public.venues),
    'comments_week', (select count(*) from public.comments where created_at > now() - interval '7 days'),
    'feedback_open', case when public.is_admin() then (select count(*) from public.feedback where not handled) end
  );
end;
$$;

create or replace function public.admin_log(p_limit int default 100)
returns table (at timestamptz, who text, action text, target text, target_id text, note text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_admin();
  return query
    select l.at, coalesce(p.handle, p.display_name, 'gone'), l.action, l.target, l.target_id, l.note
    from public.staff_log l left join public.profiles p on p.id = l.actor_id
    order by l.at desc
    limit greatest(1, least(coalesce(p_limit, 100), 500));
end;
$$;

-- --------------------------------------------------------------- the doors

do $$
declare f text;
begin
  foreach f in array array[
    'staff_venue_save(uuid, text, text, double precision, double precision)',
    'staff_event_save(uuid, text, text, text, uuid, text, text, text, text, text, boolean)',
    'staff_event_delete(uuid)', 'staff_events(int)',
    'staff_dj_save(uuid, text, text, text, text, text, text)',
    'dj_mine()', 'dj_save_mine(text, text, text, text, text, text)',
    'dj_set_add(uuid, text, text, text, text, numeric)', 'dj_set_delete(uuid)', 'dj_sets_of(uuid)',
    'staff_comment_hide(uuid, boolean)', 'staff_comments(int)',
    'admin_people(text)', 'admin_set_type(uuid, text)', 'admin_overview()', 'admin_log(int)'
  ] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;
revoke all on function public.need_staff() from public, anon;
revoke all on function public.need_admin() from public, anon;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('42_staff.sql', '7df8ea9bbca457f354c134e99f19b72a828a75a2f69a96ab56453be0f7f5c629');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('42_staff.sql');
  end if;
end $$;
