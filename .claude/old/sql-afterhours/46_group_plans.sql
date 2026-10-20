-- afterhours — a group decides and makes a plan (46, after 44_groups.sql)
--
-- From the matches to one night:
--
--   a vote      any member puts two or three nights to a vote for 1, 3, 12 or 24
--               hours; one vote each, changeable until it closes. It closes when
--               the time is up or everyone has voted; the night with most votes
--               wins (a tie goes to the one more members kept in the group, then
--               the earlier one) and becomes the plan. One vote open at a time.
--   the plan    one night per group. Any member can set it straight from the
--               matches too. Who comes is the usual in · maybe · out (32_rsvp.sql:
--               rsvp_set), shown here for the members; and each says whether they
--               have a ticket, so the group sees who still needs one.
--   the chat    a thread for the group. Setting a plan, starting a vote and its
--               result are written into it as well.
--
-- Closed tables again; every function checks membership first (need_member, 44).

alter table public.groups add column if not exists plan_event_id uuid references public.events on delete set null;
alter table public.groups add column if not exists plan_set_by uuid references public.profiles on delete set null;
alter table public.groups add column if not exists plan_set_at timestamptz;

create table if not exists public.group_rounds (
  id           uuid primary key default gen_random_uuid(),
  group_id     uuid not null references public.groups on delete cascade,
  started_by   uuid references public.profiles on delete set null,
  created_at   timestamptz not null default now(),
  closes_at    timestamptz not null,
  closed_at    timestamptz,
  winner_id    uuid references public.events on delete set null
);
create index if not exists group_rounds_group_idx on public.group_rounds (group_id, created_at desc);
create unique index if not exists group_rounds_one_open on public.group_rounds (group_id) where closed_at is null;

create table if not exists public.group_round_options (
  round_id  uuid not null references public.group_rounds on delete cascade,
  event_id  uuid not null references public.events on delete cascade,
  primary key (round_id, event_id)
);

create table if not exists public.group_ballots (
  round_id  uuid not null references public.group_rounds on delete cascade,
  user_id   uuid not null references public.profiles on delete cascade,
  event_id  uuid not null references public.events on delete cascade,
  at        timestamptz not null default now(),
  primary key (round_id, user_id)
);

create table if not exists public.group_tickets (
  group_id  uuid not null references public.groups on delete cascade,
  event_id  uuid not null references public.events on delete cascade,
  user_id   uuid not null references public.profiles on delete cascade,
  primary key (group_id, event_id, user_id)
);

create table if not exists public.group_messages (
  id          bigserial primary key,
  group_id    uuid not null references public.groups on delete cascade,
  user_id     uuid references public.profiles on delete set null,
  kind        text not null default 'say' check (kind in ('say', 'plan', 'round', 'won')),
  body        text not null check (length(body) between 1 and 1000),
  event_id    uuid references public.events on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists group_messages_group_idx on public.group_messages (group_id, id);

alter table public.group_rounds enable row level security;
alter table public.group_round_options enable row level security;
alter table public.group_ballots enable row level security;
alter table public.group_tickets enable row level security;
alter table public.group_messages enable row level security;
revoke all on public.group_rounds, public.group_round_options, public.group_ballots,
              public.group_tickets, public.group_messages from public, anon, authenticated;

-- ------------------------------------------------------------- helpers

create or replace function public.group_note(p_group uuid, p_kind text, p_body text, p_event uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.group_messages (group_id, user_id, kind, body, event_id)
  values (p_group, auth.uid(), p_kind, left(p_body, 1000), p_event);
$$;
revoke all on function public.group_note(uuid, text, text, uuid) from public, anon, authenticated;

-- A night a group can still go to.
create or replace function public.night_ahead(p_event uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.events e where e.id = p_event and e.is_published
                 and (e.starts_at is null or e.starts_at > now() - interval '6 hours'));
$$;

-- Closes a round whose time is up or that everyone voted in; the winner becomes the plan.
create or replace function public.round_settle(p_round uuid, p_force boolean default false)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.group_rounds%rowtype;
  members int;
  voted int;
  w uuid;
  title text;
begin
  select * into r from public.group_rounds where id = p_round for update;
  if r.id is null or r.closed_at is not null then return r.winner_id; end if;
  select count(*) into members from public.group_members where group_id = r.group_id;
  select count(*) into voted from public.group_ballots b
    join public.group_members m on m.group_id = r.group_id and m.user_id = b.user_id where b.round_id = r.id;
  if not p_force and r.closes_at > now() and voted < members then return null; end if;
  select o.event_id into w
  from public.group_round_options o
  join public.events e on e.id = o.event_id
  where o.round_id = r.id
  order by (select count(*) from public.group_ballots b where b.round_id = r.id and b.event_id = o.event_id) desc,
           (select count(*) from public.group_swipes s where s.group_id = r.group_id and s.event_id = o.event_id and s.direction = 'right') desc,
           e.starts_at nulls last, e.id
  limit 1;
  update public.group_rounds set closed_at = now(), winner_id = w where id = r.id;
  if w is not null and voted > 0 then
    update public.groups set plan_event_id = w, plan_set_by = r.started_by, plan_set_at = now() where id = r.group_id;
    select e.title into title from public.events e where e.id = w;
    insert into public.group_messages (group_id, user_id, kind, body, event_id) values (r.group_id, null, 'won', title, w);
  end if;
  return w;
end;
$$;
revoke all on function public.round_settle(uuid, boolean) from public, anon, authenticated;

-- --------------------------------------------------------------- votes

create or replace function public.round_start(p_group uuid, p_events uuid[], p_hours int)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  open_round uuid;
  r uuid;
  e uuid;
  picked uuid[] := array(select distinct x from unnest(coalesce(p_events, '{}')) x);
begin
  perform public.need_member(p_group);
  select id into open_round from public.group_rounds where group_id = p_group and closed_at is null;
  if open_round is not null then perform public.round_settle(open_round); end if;
  if exists (select 1 from public.group_rounds where group_id = p_group and closed_at is null) then
    raise exception 'a vote is already open';
  end if;
  if cardinality(picked) not between 2 and 3 then raise exception 'two or three nights'; end if;
  if coalesce(p_hours, 0) not in (1, 3, 12, 24) then raise exception '1, 3, 12 or 24 hours'; end if;
  foreach e in array picked loop
    if not public.night_ahead(e) then raise exception 'one of those nights is over or gone'; end if;
  end loop;
  insert into public.group_rounds (group_id, started_by, closes_at)
  values (p_group, auth.uid(), now() + make_interval(hours => p_hours)) returning id into r;
  insert into public.group_round_options (round_id, event_id) select r, x from unnest(picked) x;
  perform public.group_note(p_group, 'round', (select string_agg(title, ' · ') from public.events where id = any(picked)), null);
  return r;
end;
$$;

create or replace function public.round_vote(p_round uuid, p_event uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.group_rounds%rowtype;
begin
  select * into r from public.group_rounds where id = p_round;
  if r.id is null then raise exception 'no such vote'; end if;
  perform public.need_member(r.group_id);
  perform public.round_settle(r.id);
  if (select closed_at from public.group_rounds where id = r.id) is not null then raise exception 'this vote is closed'; end if;
  if not exists (select 1 from public.group_round_options where round_id = r.id and event_id = p_event) then
    raise exception 'not one of the choices';
  end if;
  insert into public.group_ballots (round_id, user_id, event_id) values (r.id, auth.uid(), p_event)
  on conflict (round_id, user_id) do update set event_id = excluded.event_id, at = now();
  perform public.round_settle(r.id);
end;
$$;

-- Whoever started it, or the owner, ends it early (the votes so far decide).
create or replace function public.round_close(p_round uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.group_rounds%rowtype;
begin
  select * into r from public.group_rounds where id = p_round;
  if r.id is null then raise exception 'no such vote'; end if;
  perform public.need_member(r.group_id);
  if r.started_by is distinct from auth.uid()
     and not exists (select 1 from public.group_members where group_id = r.group_id and user_id = auth.uid() and role = 'owner') then
    raise exception 'whoever started it, or the owner' using errcode = '42501';
  end if;
  return public.round_settle(r.id, true);
end;
$$;

-- ---------------------------------------------------------------- plan

create or replace function public.plan_set(p_group uuid, p_event uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_group);
  if p_event is null then
    update public.groups set plan_event_id = null, plan_set_by = auth.uid(), plan_set_at = now() where id = p_group;
    return;
  end if;
  if not public.night_ahead(p_event) then raise exception 'that night is over or gone'; end if;
  update public.groups set plan_event_id = p_event, plan_set_by = auth.uid(), plan_set_at = now() where id = p_group;
  perform public.group_note(p_group, 'plan', (select title from public.events where id = p_event), p_event);
end;
$$;

create or replace function public.plan_ticket(p_group uuid, p_got boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e uuid;
begin
  perform public.need_member(p_group);
  select plan_event_id into e from public.groups where id = p_group;
  if e is null then raise exception 'no plan yet'; end if;
  if p_got then
    insert into public.group_tickets (group_id, event_id, user_id) values (p_group, e, auth.uid()) on conflict do nothing;
  else
    delete from public.group_tickets where group_id = p_group and event_id = e and user_id = auth.uid();
  end if;
end;
$$;

-- Everything the plan tab shows, in one read. Settles a vote whose time is up.
create or replace function public.group_plan(p_group uuid)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  g public.groups%rowtype;
  r public.group_rounds%rowtype;
  open_id uuid;
begin
  perform public.need_member(p_group);
  select id into open_id from public.group_rounds where group_id = p_group and closed_at is null;
  if open_id is not null then perform public.round_settle(open_id); end if;
  select * into g from public.groups where id = p_group;
  select * into r from public.group_rounds where group_id = p_group and closed_at is null;
  return json_build_object(
    'members', (select count(*) from public.group_members where group_id = p_group),
    'round', case when r.id is null then null else json_build_object(
      'id', r.id, 'closes_at', r.closes_at,
      'started_by', (select coalesce(p.display_name, p.handle) from public.profiles p where p.id = r.started_by),
      'mine', r.started_by = auth.uid(),
      'voted', (select count(*) from public.group_ballots where round_id = r.id),
      'my_vote', (select event_id from public.group_ballots where round_id = r.id and user_id = auth.uid()),
      'options', (select json_agg(json_build_object(
          'id', e.id, 'slug', e.slug, 'title', e.title, 'starts_at', e.starts_at, 'venue_name', v.name, 'image_url', e.image_url,
          'votes', (select count(*) from public.group_ballots b where b.round_id = r.id and b.event_id = e.id),
          'voters', (select coalesce(json_agg(coalesce(p.display_name, p.handle)), '[]'::json) from public.group_ballots b
                     join public.profiles p on p.id = b.user_id where b.round_id = r.id and b.event_id = e.id)) order by e.starts_at)
        from public.group_round_options o join public.events e on e.id = o.event_id left join public.venues v on v.id = e.venue_id
        where o.round_id = r.id)) end,
    'plan', case when g.plan_event_id is null or not public.night_ahead(g.plan_event_id) then null else (
      select json_build_object(
        'id', e.id, 'slug', e.slug, 'title', e.title, 'starts_at', e.starts_at, 'venue_name', v.name, 'city_name', c.name,
        'image_url', e.image_url, 'ticket_url', e.ticket_url,
        'set_by', (select coalesce(p.display_name, p.handle) from public.profiles p where p.id = g.plan_set_by),
        'people', (select json_agg(json_build_object(
            'id', p.id, 'name', coalesce(p.display_name, p.handle),
            'answer', (select a.answer from public.rsvps a where a.user_id = p.id and a.event_id = e.id),
            'ticket', exists (select 1 from public.group_tickets t where t.group_id = p_group and t.event_id = e.id and t.user_id = p.id))
            order by m.joined_at)
          from public.group_members m join public.profiles p on p.id = m.user_id where m.group_id = p_group))
      from public.events e join public.cities c on c.id = e.city_id left join public.venues v on v.id = e.venue_id
      where e.id = g.plan_event_id) end
  );
end;
$$;

-- ---------------------------------------------------------------- chat

create or replace function public.group_say(p_group uuid, p_body text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  r bigint;
begin
  perform public.need_member(p_group);
  if length(btrim(coalesce(p_body, ''))) not between 1 and 1000 then raise exception '1 to 1000 characters'; end if;
  if (select count(*) from public.group_messages where user_id = auth.uid() and created_at > now() - interval '1 minute') >= 20 then
    raise exception 'slow down a little';
  end if;
  insert into public.group_messages (group_id, user_id, body) values (p_group, auth.uid(), btrim(p_body)) returning id into r;
  return r;
end;
$$;

create or replace function public.group_unsay(p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.group_messages where id = p_id and user_id = auth.uid() and kind = 'say';
end;
$$;

-- The thread after message p_after (0: the last 80), oldest first.
create or replace function public.group_thread(p_group uuid, p_after bigint default 0)
returns table (id bigint, user_id uuid, name text, kind text, body text, event_slug text, created_at timestamptz, mine boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_group);
  return query
    select * from (
      select m.id, m.user_id, coalesce(p.display_name, p.handle), m.kind, m.body, e.slug, m.created_at, m.user_id = auth.uid()
      from public.group_messages m
      left join public.profiles p on p.id = m.user_id
      left join public.events e on e.id = m.event_id
      where m.group_id = p_group and m.id > coalesce(p_after, 0)
      order by m.id desc
      limit 80) x
    order by x.id;
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'night_ahead(uuid)', 'round_start(uuid, uuid[], int)', 'round_vote(uuid, uuid)', 'round_close(uuid)',
    'plan_set(uuid, uuid)', 'plan_ticket(uuid, boolean)', 'group_plan(uuid)',
    'group_say(uuid, text)', 'group_unsay(bigint)', 'group_thread(uuid, bigint)'
  ] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('46_group_plans.sql', '8f2895631eb58bb03e788cb0d06b2fb85bd9dfa6af3d34081d246d7501084feb');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('46_group_plans.sql');
  end if;
end $$;
