-- afterhours — anyone with an account suggests a ticketed night; the staff decide (43)
--
-- The + on the flow opens "with a ticket" or "among friends" (a spark). With a
-- ticket: the staff publish at once (42_staff.sql); everyone else sends it in,
-- and it waits, unseen, until a community manager or an admin lets it through.
--
--   events.review         pending · rejected · null (decided, or never asked)
--   event_submit(…)       a signed-in person (not a guest) sends a night in;
--                         at most 5 waiting at a time. A ticket link is required.
--   event_submissions()   your own, with where they stand
--   staff_pending()       the staff: what waits
--   staff_review(id, ok, note)  publish it, or turn it down with a line why
--
-- Nights sent in carry source = user. Once let through they show like any other;
-- the staff can still edit or delete them in the panel.

alter table public.events add column if not exists review text check (review in ('pending', 'rejected'));
alter table public.events add column if not exists review_note text;
create index if not exists events_review_idx on public.events (review) where review is not null;

-- ------------------------------------------------- one writer for both doors

-- No check of who calls: the two doors below each check first. Nobody else may call it.
create or replace function public.night_write(
  p_id uuid, p_title text, p_city text, p_type text, p_venue uuid,
  p_date text, p_time text, p_body text, p_ticket_url text, p_image_url text,
  p_published boolean, p_source text, p_review text)
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
begin
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
                               date_text, is_published, source, image_url, ticket_url, lat, lng, created_by, review)
    values (public.make_slug(t), c.id, ty, v.id, t, concat_ws(' · ', coalesce(v.name, c.name), short, hm),
            coalesce(btrim(p_body), ''), (d::text || 'T' || hm)::timestamptz, false, short || ' · ' || hm,
            coalesce(p_published, true), p_source, nullif(btrim(p_image_url), ''), nullif(btrim(p_ticket_url), ''),
            v.lat, v.lng, auth.uid(), p_review)
    returning slug into s;
  else
    update public.events set city_id = c.id, type_id = ty, venue_id = v.id, title = t,
           meta = concat_ws(' · ', coalesce(v.name, c.name), short, hm), body = coalesce(btrim(p_body), ''),
           starts_at = (d::text || 'T' || hm)::timestamptz, date_text = short || ' · ' || hm,
           is_published = coalesce(p_published, true), image_url = nullif(btrim(p_image_url), ''),
           ticket_url = nullif(btrim(p_ticket_url), ''), lat = v.lat, lng = v.lng, updated_at = now()
     where id = p_id returning slug into s;
  end if;
  return s;
end;
$$;
revoke all on function public.night_write(uuid, text, text, text, uuid, text, text, text, text, text, boolean, text, text) from public, anon, authenticated;

-- The staff door, as in 42, now through night_write, and nights sent in by
-- people can be edited too.
create or replace function public.staff_event_save(
  p_id uuid, p_title text, p_city text, p_type text, p_venue uuid,
  p_date text, p_time text, p_body text, p_ticket_url text, p_image_url text, p_published boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  old public.events%rowtype;
  s text;
begin
  perform public.need_staff();
  if p_id is not null then
    select * into old from public.events where id = p_id;
    if old.id is null then raise exception 'no such night'; end if;
    if old.source not in ('staff', 'user') then raise exception 'only nights made here can be edited here'; end if;
    if old.review = 'pending' and coalesce(p_published, true) then
      raise exception 'let it through first (waiting for review)';
    end if;
  end if;
  s := public.night_write(p_id, p_title, p_city, p_type, p_venue, p_date, p_time, p_body, p_ticket_url, p_image_url,
                          p_published, coalesce(old.source, 'staff'), old.review);
  perform public.staff_note(case when p_id is null then 'create' else 'edit' end, 'night', s, btrim(p_title));
  return s;
end;
$$;

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
  if e.source not in ('staff', 'user') then raise exception 'only nights made here can be deleted here'; end if;
  if not public.is_admin() and e.source = 'staff' and e.created_by is distinct from auth.uid() then
    raise exception 'only the admin or whoever made it' using errcode = '42501';
  end if;
  delete from public.events where id = p_id;
  perform public.staff_note('delete', 'night', e.slug, e.title);
end;
$$;

-- The panel list: nights made by the staff, and the ones sent in that were decided.
drop function if exists public.staff_events(int);
create or replace function public.staff_events(p_limit int default 100)
returns table (id uuid, slug text, title text, city_slug text, type_slug text, venue_id uuid,
               starts_at timestamptz, body text, ticket_url text, image_url text, is_published boolean,
               created_by uuid, maker text, source text, review text)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.slug, e.title, c.slug, t.slug, e.venue_id, e.starts_at, e.body, e.ticket_url, e.image_url,
         e.is_published, e.created_by, p.display_name, e.source, e.review
  from public.events e
  join public.cities c on c.id = e.city_id
  join public.event_types t on t.id = e.type_id
  left join public.profiles p on p.id = e.created_by
  where e.source in ('staff', 'user') and public.is_staff()
  order by e.created_at desc
  limit greatest(1, least(coalesce(p_limit, 100), 500));
$$;

-- ------------------------------------------------------- the door for people

create or replace function public.event_submit(
  p_title text, p_city text, p_type text, p_venue uuid,
  p_date text, p_time text, p_body text, p_ticket_url text, p_image_url text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  s text;
begin
  if auth.uid() is null or public.is_guest() then
    raise exception 'make an account first' using errcode = '42501';
  end if;
  if coalesce(btrim(p_ticket_url), '') = '' then raise exception 'ticket link: needed'; end if;
  if (select count(*) from public.events where created_by = auth.uid() and review = 'pending') >= 5 then
    raise exception 'five are already waiting; wait until they are looked at';
  end if;
  s := public.night_write(null, p_title, p_city, p_type, p_venue, p_date, p_time, p_body, p_ticket_url, p_image_url,
                          false, 'user', 'pending');
  perform public.staff_note('submit', 'night', s, btrim(p_title));
  return s;
end;
$$;

create or replace function public.event_submissions()
returns table (id uuid, slug text, title text, starts_at timestamptz, review text, review_note text, is_published boolean)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.slug, e.title, e.starts_at, e.review, e.review_note, e.is_published
  from public.events e
  where e.created_by = auth.uid() and e.source = 'user'
  order by e.created_at desc
  limit 50;
$$;

create or replace function public.staff_pending()
returns table (id uuid, slug text, title text, city_slug text, type_slug text, venue_name text,
               starts_at timestamptz, body text, ticket_url text, image_url text, maker text, handle text, sent_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select e.id, e.slug, e.title, c.slug, t.slug, v.name, e.starts_at, e.body, e.ticket_url, e.image_url,
         p.display_name, p.handle, e.created_at
  from public.events e
  join public.cities c on c.id = e.city_id
  join public.event_types t on t.id = e.type_id
  left join public.venues v on v.id = e.venue_id
  left join public.profiles p on p.id = e.created_by
  where e.review = 'pending' and public.is_staff()
  order by e.created_at;
$$;

create or replace function public.staff_review(p_id uuid, p_ok boolean, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.events%rowtype;
begin
  perform public.need_staff();
  select * into e from public.events where id = p_id and review = 'pending';
  if e.id is null then raise exception 'nothing waiting with that id'; end if;
  if p_ok then
    update public.events set review = null, review_note = null, is_published = true, updated_at = now() where id = p_id;
  else
    update public.events set review = 'rejected', review_note = left(nullif(btrim(p_note), ''), 300), is_published = false, updated_at = now() where id = p_id;
  end if;
  perform public.staff_note(case when p_ok then 'approve' else 'reject' end, 'night', e.slug, e.title);
end;
$$;

-- The first page of the panel counts what waits.
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
    'pending', (select count(*) from public.events where review = 'pending'),
    'feedback_open', case when public.is_admin() then (select count(*) from public.feedback where not handled) end
  );
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'staff_event_save(uuid, text, text, text, uuid, text, text, text, text, text, boolean)',
    'staff_event_delete(uuid)', 'staff_events(int)',
    'event_submit(text, text, text, uuid, text, text, text, text, text)', 'event_submissions()',
    'staff_pending()', 'staff_review(uuid, boolean, text)', 'admin_overview()'
  ] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('43_event_submit.sql', '2fad57d8c4ba1bcaf884a71be4fddd6d07126aab1d732c8d4eb176b596de2ef6');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('43_event_submit.sql');
  end if;
end $$;
