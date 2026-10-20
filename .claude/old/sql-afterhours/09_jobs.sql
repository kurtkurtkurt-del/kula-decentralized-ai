-- afterhours — the jobs that run in the background
-- The pg_cron extension is switched on under Database → Extensions.
-- Without the extension the functions still work, they just do not run
-- on their own; you can also call them by hand.

-- Drop past events off the list.
-- IMPORTANT: it only touches events with a CONFIRMED date. Dropping one
-- of the 24 inferred dates could be wrong, and hiding those on their own
-- whose year was merely guessed would take a real event off the site.
create or replace function public.hide_past_events()
returns integer
language sql
security definer
set search_path = public
as $$
  with closed as (
    update public.events
    set is_published = false
    where is_published
      and starts_at is not null
      and not starts_at_estimated
      and starts_at < now() - interval '12 hours'   -- let the night end first
    returning 1
  )
  select count(*)::int from closed;
$$;

-- This is the cron job’s tool (pg_cron runs it as the owner). Postgres
-- hands EXECUTE to everyone by default, and there is no reason a browser
-- should be able to trigger it through the API.
revoke execute on function public.hide_past_events() from public, anon, authenticated;

-- The maintenance summary: one row saying what wants attention.
-- The database side of the warnings in the admin panel.
-- create or replace is not enough when the return type changes; drop first.
drop function if exists public.health();
create or replace function public.health()
returns table (
  events            bigint,
  published         bigint,
  missing_venue     bigint,
  unverified_date   bigint,
  past_still_up     bigint,
  comments          bigint,
  hidden_comments   bigint,
  people            bigint,
  swipes            bigint,
  -- confirmed pairs only: the number the help page shows as
  -- "friend connections". A pending request is not a connection yet.
  friendships       bigint
)
language sql
security definer
set search_path = public
as $$
  select
    (select count(*) from public.events),
    (select count(*) from public.events where is_published),
    (select count(*) from public.events where venue_id is null),
    (select count(*) from public.events where starts_at_estimated),
    (select count(*) from public.events
      where is_published and starts_at is not null
        and not starts_at_estimated and starts_at < now()),
    (select count(*) from public.comments),
    (select count(*) from public.comments where is_hidden),
    (select count(*) from public.profiles),
    (select count(*) from public.swipes),
    (select count(*) from public.friendships where status = 'accepted');
$$;

grant execute on function public.health() to anon, authenticated;

-- The schedule. If pg_cron is off, this block is skipped quietly.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('afterhours-gecmisi-dusur')
      where exists (select 1 from cron.job where jobname = 'afterhours-gecmisi-dusur');
    perform cron.unschedule('afterhours-drop-past')
      where exists (select 1 from cron.job where jobname = 'afterhours-drop-past');
    perform cron.schedule(
      'afterhours-drop-past',
      '30 5 * * *',                       -- 05:30 UTC daily, after the night is over
      $job$ select public.hide_past_events(); $job$
    );
  end if;
end
$$;

-- Stamp the migration log, if it is there. Each numbered file still runs on
-- its own (the tests load them one at a time), so this cannot insist.
do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('09_jobs.sql', 'ccef9d46b66b63da9bdae6308b5048818171e6ece9006ce66537522fbae90030');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('09_jobs.sql');
  end if;
end $$;
