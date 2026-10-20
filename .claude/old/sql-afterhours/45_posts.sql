-- afterhours — posts: a photo and a few words for your friends (45)
--
-- The + on the yours tab makes a post: a photo (from the phone, into your own
-- folder of the photos bucket), a few words, and if you like the night it was
-- about. Your friends see it in their yours tab, newest first; so do you.
--
--   posts                 author, text, photo, night, hidden (by the staff)
--   post_reports          who reported what and why; the staff look at them
--   post_create(…)        an account (not a guest), at most 20 a day
--   post_delete(id)       the author, or the staff
--   posts_feed(before, n) you and your confirmed friends, a page at a time
--   post_report(id, why)  anyone who can see it; once per person
--   staff_posts_reported() / staff_post_hide(id, hidden)   the staff
--
-- A report is the store requirement for anything people write: there must be a
-- way to flag it and someone who looks.

create table if not exists public.posts (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null references public.profiles on delete cascade,
  body        text not null default '' check (length(body) <= 500),
  photo_path  text,
  event_id    uuid references public.events on delete set null,
  is_hidden   boolean not null default false,
  created_at  timestamptz not null default now(),
  constraint posts_something check (length(btrim(body)) > 0 or photo_path is not null)
);
create index if not exists posts_author_idx on public.posts (author_id, created_at desc);
create index if not exists posts_recent_idx on public.posts (created_at desc);

create table if not exists public.post_reports (
  post_id     uuid not null references public.posts on delete cascade,
  reporter_id uuid not null references public.profiles on delete cascade,
  reason      text check (reason is null or length(reason) <= 300),
  created_at  timestamptz not null default now(),
  handled     boolean not null default false,
  primary key (post_id, reporter_id)
);

alter table public.posts enable row level security;
alter table public.post_reports enable row level security;
revoke all on public.posts, public.post_reports from public, anon, authenticated;

create or replace function public.can_see_post(p_author uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_author = auth.uid() or public.is_friend(p_author);
$$;
revoke all on function public.can_see_post(uuid) from public, anon;

create or replace function public.post_create(p_body text, p_photo text, p_event uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  r uuid;
begin
  perform public.need_account();
  if length(coalesce(p_body, '')) > 500 then raise exception 'at most 500 characters'; end if;
  if length(btrim(coalesce(p_body, ''))) = 0 and p_photo is null then raise exception 'a photo or a few words'; end if;
  if p_photo is not null and p_photo not like auth.uid()::text || '/%' then raise exception 'not your file'; end if;
  if p_event is not null and not exists (select 1 from public.events where id = p_event) then raise exception 'no such night'; end if;
  if (select count(*) from public.posts where author_id = auth.uid() and created_at > now() - interval '1 day') >= 20 then
    raise exception 'twenty today is enough; more tomorrow';
  end if;
  insert into public.posts (author_id, body, photo_path, event_id)
  values (auth.uid(), btrim(coalesce(p_body, '')), p_photo, p_event)
  returning id into r;
  return r;
end;
$$;

-- Returns the photo path, so the app can remove the file.
create or replace function public.post_delete(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.posts%rowtype;
begin
  select * into p from public.posts where id = p_id;
  if p.id is null then return null; end if;
  if p.author_id <> auth.uid() and not public.is_staff() then raise exception 'not your post' using errcode = '42501'; end if;
  delete from public.posts where id = p_id;
  if p.author_id <> auth.uid() then perform public.staff_note('delete', 'post', p_id::text, left(p.body, 80)); end if;
  return p.photo_path;
end;
$$;

-- 55 adds columns; a second run of the setup meets that shape first.
drop function if exists public.posts_feed(timestamptz, int);
create or replace function public.posts_feed(p_before timestamptz default null, p_limit int default 20)
returns table (id uuid, author_id uuid, handle text, name text, body text, photo_path text,
               event_slug text, event_title text, created_at timestamptz, mine boolean)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.author_id, pr.handle, pr.display_name, p.body, p.photo_path, e.slug, e.title, p.created_at,
         p.author_id = auth.uid()
  from public.posts p
  join public.profiles pr on pr.id = p.author_id
  left join public.events e on e.id = p.event_id
  where auth.uid() is not null
    and not p.is_hidden
    and public.can_see_post(p.author_id)
    and (p_before is null or p.created_at < p_before)
  order by p.created_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;

create or replace function public.post_report(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a uuid;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select author_id into a from public.posts where id = p_id;
  if a is null or not public.can_see_post(a) then raise exception 'no such post'; end if;
  if a = auth.uid() then raise exception 'your own post: delete it instead'; end if;
  insert into public.post_reports (post_id, reporter_id, reason)
  values (p_id, auth.uid(), left(nullif(btrim(p_reason), ''), 300))
  on conflict (post_id, reporter_id) do nothing;
end;
$$;

create or replace function public.staff_posts_reported()
returns table (id uuid, body text, photo_path text, author text, reports int, reasons text[], is_hidden boolean, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  return query
    select p.id, p.body, p.photo_path, coalesce(pr.handle, pr.display_name), count(r.*)::int,
           array_remove(array_agg(r.reason), null), p.is_hidden, p.created_at
    from public.post_reports r
    join public.posts p on p.id = r.post_id
    join public.profiles pr on pr.id = p.author_id
    where not r.handled
    group by p.id, pr.handle, pr.display_name
    order by count(r.*) desc, max(r.created_at) desc;
end;
$$;

-- Hiding settles the reports; showing again (a wrong report) settles them too.
create or replace function public.staff_post_hide(p_id uuid, p_hidden boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  update public.posts set is_hidden = coalesce(p_hidden, true) where id = p_id;
  update public.post_reports set handled = true where post_id = p_id;
  perform public.staff_note(case when coalesce(p_hidden, true) then 'hide' else 'show' end, 'post', p_id::text, null);
end;
$$;

-- The panel counts what waits.
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
    'reported', (select count(distinct post_id) from public.post_reports where not handled),
    'feedback_open', case when public.is_admin() then (select count(*) from public.feedback where not handled) end
  );
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'post_create(text, text, uuid)', 'post_delete(uuid)', 'posts_feed(timestamptz, int)',
    'post_report(uuid, text)', 'staff_posts_reported()', 'staff_post_hide(uuid, boolean)', 'admin_overview()'
  ] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('45_posts.sql', '466a971652fc35d228348cb57c334e6e0f9cd2f9347c31e343d8b7f7bcb29ae5');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('45_posts.sql');
  end if;
end $$;
