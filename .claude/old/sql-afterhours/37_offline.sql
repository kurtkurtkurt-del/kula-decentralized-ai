-- afterhours — writes made offline (37)
--
-- The app now keeps every write in an outbox on the phone and sends it when the
-- connection returns (app/src/lib/offline.ts). A job can go out twice: the first try
-- reaches the server but the answer is lost, so the phone tries again. Each job carries
-- an id made on the phone; with it the second try finds the first and changes nothing.
--
--   comments.client_id     a topic or reply sent twice is stored once
--   room_posts.client_id   the same for lines in a room
--   room_post(slug, body, client_id)   returns the line already stored for that id
--   check_in(slug, lat, lng, at)       at: when you pressed the button on the phone;
--                                      checked_at of the card, never in the future and
--                                      never more than 12 hours back (else now)
--
-- The freeze rule of a room still goes by the clock of the server: a line written offline
-- that arrives after the room froze is refused (the app says so).
-- Old app versions keep working: the new parameters have defaults.

-- ------------------------------------------------------------ comments

alter table public.comments add column if not exists client_id uuid;
create unique index if not exists comments_client_idx on public.comments (author_id, client_id);
grant insert (event_id, parent_id, author_id, body, client_id) on public.comments to authenticated;

-- ------------------------------------------------------------ room lines

alter table public.room_posts add column if not exists client_id uuid;
create unique index if not exists room_posts_client_idx on public.room_posts (user_id, client_id);

drop function if exists public.room_post(text, text);
drop function if exists public.room_post(text, text, uuid);
create or replace function public.room_post(p_slug text, p_body text, p_client_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  ev uuid;
  n  uuid;
begin
  if auth.uid() is null or public.is_guest() then raise exception 'signedout'; end if;
  if p_client_id is not null then
    select id into n from public.room_posts where user_id = auth.uid() and client_id = p_client_id;
    if found then return n; end if;
  end if;
  select id into ev from public.events where slug = p_slug;
  if ev is null then raise exception 'nonight'; end if;
  if not public.checked_in(ev) then raise exception 'notthere'; end if;
  if now() >= public.room_freeze_at(ev) then raise exception 'frozen'; end if;
  insert into public.room_posts (event_id, user_id, body, client_id)
  values (ev, auth.uid(), btrim(p_body), p_client_id)
  returning id into n;
  return n;
end;
$$;

-- ------------------------------------------------------------ check-in

drop function if exists public.check_in(text, double precision, double precision);
drop function if exists public.check_in(text, double precision, double precision, timestamptz);
create or replace function public.check_in(
  p_slug text,
  p_lat  double precision default null,
  p_lng  double precision default null,
  p_at   timestamptz default null
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  e  public.events%rowtype;
  n  bigint;
  at timestamptz := least(coalesce(p_at, now()), now());
begin
  if auth.uid() is null or public.is_guest() then raise exception 'signedout'; end if;
  select * into e from public.events where slug = p_slug and is_published;
  if not found then raise exception 'nonight'; end if;

  -- One card per person per night: a second try returns the first card.
  select card_no into n from public.checkins where user_id = auth.uid() and event_id = e.id;
  if found then return n; end if;

  if at < now() - interval '12 hours' then at := now(); end if;
  insert into public.checkins (user_id, event_id, checked_at) values (auth.uid(), e.id, at) returning card_no into n;
  return n;
end;
$$;

revoke all on function public.room_post(text, text, uuid) from public, anon;
revoke all on function public.check_in(text, double precision, double precision, timestamptz) from public, anon;
grant execute on function public.room_post(text, text, uuid) to authenticated;
grant execute on function public.check_in(text, double precision, double precision, timestamptz) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('37_offline.sql', 'c7de2e6b7ae4b4ccef3496ddce998f61bb25a3d576eb909a9505d5227ab14144');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('37_offline.sql');
  end if;
end $$;
