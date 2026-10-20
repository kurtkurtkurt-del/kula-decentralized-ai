-- afterhours — sparks: nights you start yourself
-- Every other card in the deck is a night someone else organises. A spark is
-- one nobody has organised yet: the derby at yours, a grill at the river, a
-- hike. Swiping a spark right creates it and invites friends; the invite
-- reaches them inside the app, as a card on top of their scene deck, and they
-- answer with the same swipe (right = in, left = out).
--
--   sparks          one row per plan: who hosts it, what, when, where
--   spark_invites   who was asked, and what they answered
--
-- Nobody reads or writes the tables directly (no grants, RLS on with no
-- policies). Everything goes through five definer calls that check who you are:
--
--   spark_create(kind, title, starts_at, place, invite[])   host: start one
--   spark_inbox()                                           invited: open asks
--   spark_answer(spark, answer)                             invited: in / out
--   spark_mine()                                            host: yours + answers
--   spark_cancel(spark)                                     host: call it off
--
-- Only confirmed friends can be invited; anyone else in the list is dropped
-- without a word, so the call cannot be used to find out who exists.

create table if not exists public.sparks (
  id          uuid primary key default gen_random_uuid(),
  host_id     uuid not null references public.profiles on delete cascade,
  kind        text not null check (kind in ('derby', 'grill', 'hike')),
  title       text not null check (char_length(btrim(title)) between 1 and 80),
  starts_at   timestamptz not null,
  place       text check (place is null or char_length(place) <= 80),
  created_at  timestamptz not null default now()
);
create index if not exists sparks_host_idx on public.sparks (host_id, starts_at);

create table if not exists public.spark_invites (
  spark_id     uuid not null references public.sparks on delete cascade,
  user_id      uuid not null references public.profiles on delete cascade,
  answer       text not null default 'waiting' check (answer in ('waiting', 'in', 'out')),
  answered_at  timestamptz,
  primary key (spark_id, user_id)
);
create index if not exists spark_invites_user_idx on public.spark_invites (user_id, answer);

alter table public.sparks        enable row level security;
alter table public.spark_invites enable row level security;
revoke all on public.sparks, public.spark_invites from public, anon, authenticated;

-- --------------------------------------------------------------- create

-- Returns the new id. Raises when you are signed out, the time is in the past,
-- or none of the people asked is a confirmed friend.
drop function if exists public.spark_create(text, text, timestamptz, text, uuid[]);
create or replace function public.spark_create(
  p_kind      text,
  p_title     text,
  p_starts_at timestamptz,
  p_place     text,
  p_invite    uuid[]
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  me     uuid := auth.uid();
  new_id uuid;
begin
  if me is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if p_starts_at is null or p_starts_at < now() - interval '1 hour' then
    raise exception 'that time has passed' using errcode = '22023';
  end if;
  if not exists (
    select 1 from unnest(coalesce(p_invite, '{}'::uuid[])) as u(id)
    where u.id <> me and public.is_friend(u.id)
  ) then
    raise exception 'invite at least one friend' using errcode = '22023';
  end if;

  insert into public.sparks (host_id, kind, title, starts_at, place)
  values (me, p_kind, btrim(p_title), p_starts_at, nullif(btrim(coalesce(p_place, '')), ''))
  returning id into new_id;

  insert into public.spark_invites (spark_id, user_id)
  select distinct new_id, u.id
  from unnest(p_invite) as u(id)
  where u.id <> me and public.is_friend(u.id);

  return new_id;
end;
$$;

-- ---------------------------------------------------------------- inbox

-- Asks you have not answered yet, for plans that have not ended (a plan counts
-- as running for six hours after it starts). Soonest first.
drop function if exists public.spark_inbox();
create or replace function public.spark_inbox()
returns table (
  id            uuid,
  kind          text,
  title         text,
  starts_at     timestamptz,
  place         text,
  host_handle   text,
  host_name     text,
  going         int
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.kind, s.title, s.starts_at, s.place, p.handle, p.display_name,
         (select count(*)::int from public.spark_invites g where g.spark_id = s.id and g.answer = 'in')
  from public.spark_invites i
  join public.sparks s on s.id = i.spark_id
  join public.profiles p on p.id = s.host_id
  where i.user_id = auth.uid()
    and i.answer = 'waiting'
    and s.starts_at > now() - interval '6 hours'
  order by s.starts_at;
$$;

-- --------------------------------------------------------------- answer

-- in or out. Answering again changes it (the deck has an undo).
drop function if exists public.spark_answer(uuid, text);
create or replace function public.spark_answer(p_spark uuid, p_answer text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if p_answer not in ('in', 'out', 'waiting') then
    raise exception 'answer is in, out or waiting' using errcode = '22023';
  end if;
  update public.spark_invites
     set answer = p_answer,
         answered_at = case when p_answer = 'waiting' then null else now() end
   where spark_id = p_spark and user_id = auth.uid();
  if not found then
    raise exception 'no such invite' using errcode = '42501';
  end if;
end;
$$;

-- ----------------------------------------------------------------- mine

-- What you host, with the answers so far. Ended plans drop off after a day.
drop function if exists public.spark_mine();
create or replace function public.spark_mine()
returns table (
  id         uuid,
  kind       text,
  title      text,
  starts_at  timestamptz,
  place      text,
  invited    int,
  going      int,
  not_going  int
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.kind, s.title, s.starts_at, s.place,
         count(i.user_id)::int,
         count(*) filter (where i.answer = 'in')::int,
         count(*) filter (where i.answer = 'out')::int
  from public.sparks s
  left join public.spark_invites i on i.spark_id = s.id
  where s.host_id = auth.uid()
    and s.starts_at > now() - interval '1 day'
  group by s.id
  order by s.starts_at;
$$;

-- --------------------------------------------------------------- cancel

drop function if exists public.spark_cancel(uuid);
create or replace function public.spark_cancel(p_spark uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  delete from public.sparks where id = p_spark and host_id = auth.uid();
  if not found then
    raise exception 'not yours' using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.spark_create(text, text, timestamptz, text, uuid[]) from public, anon;
revoke execute on function public.spark_inbox()                                       from public, anon;
revoke execute on function public.spark_answer(uuid, text)                            from public, anon;
revoke execute on function public.spark_mine()                                        from public, anon;
revoke execute on function public.spark_cancel(uuid)                                  from public, anon;
grant execute on function public.spark_create(text, text, timestamptz, text, uuid[])  to authenticated;
grant execute on function public.spark_inbox()                                        to authenticated;
grant execute on function public.spark_answer(uuid, text)                             to authenticated;
grant execute on function public.spark_mine()                                         to authenticated;
grant execute on function public.spark_cancel(uuid)                                   to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('27_sparks.sql', '27cfc3c6b692e2e458aad2c909c131e233de71539ebf53312fa972d00a981ffb');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('27_sparks.sql');
  end if;
end $$;
