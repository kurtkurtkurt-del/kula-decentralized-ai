-- afterhours — sparks reach a wave, not a list
-- 27 sent a spark to the friends the host ticked one by one. Now the host picks
-- how far it travels, the same three waves the yours tab already speaks of:
--
--   1st wave   your friends
--   2nd wave   and their friends
--   3rd wave   one step further
--
-- Everyone inside the wave finds the spark in their spark panel and answers it
-- with the same swipe (right = in, left = out). Nobody is written down in
-- advance: an answer row appears the moment someone answers. Sparks made the
-- old way (27, a ticked list) keep working: their invite rows are still read.
--
--   spark_audience()                                    how many people each wave holds
--   spark_create(kind, title, starts_at, place, reach)  start one for a wave (no list)
--   spark_inbox()                                       + reach-based sparks, + wave
--   spark_answer(spark, answer)                         also for someone inside the wave
--   spark_mine()                                        + reach
--
-- The wave is counted from the person looking, over CONFIRMED friendships only,
-- and only ever up to three steps.

alter table public.sparks add column if not exists reach smallint;
alter table public.sparks drop constraint if exists sparks_reach_range;
alter table public.sparks add constraint sparks_reach_range check (reach is null or reach between 1 and 3);

-- ------------------------------------------------------------ the waves

-- Everyone within three confirmed steps of you, with the fewest steps it takes.
-- You are not in it.
create or replace function public.spark_waves(p_me uuid)
returns table (person uuid, hops int)
language sql
stable
security definer
set search_path = public
as $$
  with recursive f as (
    select requester_id as a, addressee_id as b from public.friendships where status = 'accepted'
    union all
    select addressee_id, requester_id from public.friendships where status = 'accepted'
  ),
  walk(person, hops) as (
    select b, 1 from f where a = p_me
    union
    select f.b, w.hops + 1 from walk w join f on f.a = w.person where w.hops < 3
  )
  select person, min(hops)::int from walk where person <> p_me group by person;
$$;
revoke execute on function public.spark_waves(uuid) from public, anon, authenticated;

-- How many people each wave reaches, counted up (the 2nd includes the 1st).
create or replace function public.spark_audience()
returns table (wave1 int, wave2 int, wave3 int)
language sql
stable
security definer
set search_path = public
as $$
  select count(*) filter (where hops <= 1)::int,
         count(*) filter (where hops <= 2)::int,
         count(*)::int
  from public.spark_waves(auth.uid());
$$;

-- --------------------------------------------------------------- create

-- One press: no list, a wave. Works with nobody in it yet (it waits for them).
drop function if exists public.spark_create(text, text, timestamptz, text, int);
create or replace function public.spark_create(
  p_kind      text,
  p_title     text,
  p_starts_at timestamptz,
  p_place     text,
  p_reach     int
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
  if p_reach is null or p_reach not between 1 and 3 then
    raise exception 'the wave is 1, 2 or 3' using errcode = '22023';
  end if;
  insert into public.sparks (host_id, kind, title, starts_at, place, reach)
  values (me, p_kind, btrim(p_title), p_starts_at, nullif(btrim(coalesce(p_place, '')), ''), p_reach)
  returning id into new_id;
  return new_id;
end;
$$;

-- ---------------------------------------------------------------- inbox

-- Open sparks for you: ticked for you (27) and not answered, or inside the
-- wave of a spark and not answered. wave = how many steps the host is from you
-- (null when you were ticked by name). Soonest first.
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
  going         int,
  wave          int
)
language sql
stable
security definer
set search_path = public
as $$
  with near as (select person, hops from public.spark_waves(auth.uid()))
  select s.id, s.kind, s.title, s.starts_at, s.place, p.handle, p.display_name,
         (select count(*)::int from public.spark_invites g where g.spark_id = s.id and g.answer = 'in'),
         n.hops
  from public.sparks s
  join public.profiles p on p.id = s.host_id
  left join near n on n.person = s.host_id
  left join public.spark_invites i on i.spark_id = s.id and i.user_id = auth.uid()
  where auth.uid() is not null
    and s.host_id <> auth.uid()
    and s.starts_at > now() - interval '6 hours'
    and (
      (i.user_id is not null and i.answer = 'waiting')
      or (i.user_id is null and s.reach is not null and n.hops <= s.reach)
    )
  order by s.starts_at;
$$;

-- --------------------------------------------------------------- answer

-- in / out / waiting (undo). Someone inside the wave gets their answer row now.
drop function if exists public.spark_answer(uuid, text);
create or replace function public.spark_answer(p_spark uuid, p_answer text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if p_answer not in ('in', 'out', 'waiting') then
    raise exception 'answer is in, out or waiting' using errcode = '22023';
  end if;
  update public.spark_invites
     set answer = p_answer,
         answered_at = case when p_answer = 'waiting' then null else now() end
   where spark_id = p_spark and user_id = me;
  if found then
    return;
  end if;
  if exists (
    select 1 from public.sparks s
    join public.spark_waves(me) w on w.person = s.host_id
    where s.id = p_spark and s.reach is not null and w.hops <= s.reach and s.host_id <> me
  ) then
    insert into public.spark_invites (spark_id, user_id, answer, answered_at)
    values (p_spark, me, p_answer, case when p_answer = 'waiting' then null else now() end);
    return;
  end if;
  raise exception 'no such invite' using errcode = '42501';
end;
$$;

-- ----------------------------------------------------------------- mine

drop function if exists public.spark_mine();
create or replace function public.spark_mine()
returns table (
  id         uuid,
  kind       text,
  title      text,
  starts_at  timestamptz,
  place      text,
  reach      int,
  invited    int,
  going      int,
  not_going  int
)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.kind, s.title, s.starts_at, s.place, s.reach::int,
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

revoke execute on function public.spark_audience()                                  from public, anon;
revoke execute on function public.spark_create(text, text, timestamptz, text, int)  from public, anon;
revoke execute on function public.spark_inbox()                                     from public, anon;
revoke execute on function public.spark_answer(uuid, text)                          from public, anon;
revoke execute on function public.spark_mine()                                      from public, anon;
grant execute on function public.spark_audience()                                   to authenticated;
grant execute on function public.spark_create(text, text, timestamptz, text, int)   to authenticated;
grant execute on function public.spark_inbox()                                      to authenticated;
grant execute on function public.spark_answer(uuid, text)                           to authenticated;
grant execute on function public.spark_mine()                                       to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('28_spark_waves.sql', '06299f66604c846e9f1257e5f57b60e557112216921aa35615c8cf1bf0af0821');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('28_spark_waves.sql');
  end if;
end $$;
