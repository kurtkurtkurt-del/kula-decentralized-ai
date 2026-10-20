-- afterhours — a night that happened stays (66)
--
-- The morning sync used to DELETE every Ticketmaster night whose date had passed.
-- events is the parent of nearly everything a person does on a night: the check-in
-- card in their collection, the room posts, the swipes, the comments, the answers to
-- who is coming, the ticket answers, the group votes. All of it went with the row,
-- every morning at 04:10. Found by the first autonomous night (A1 / F1, 20.10.2026).
--
-- From now on a past night is RETIRED, not deleted: is_published = false, which the
-- deck, the map and the counters already honour (06, 15, 18), while the collection
-- (19), the past feed (31) and the export (14) keep reading it. The sync does this
-- with a PATCH; hide_past_events() (09) does the same on its own clock.
--
-- Rows that nobody ever touched are still pruned, after a year: a night no one
-- swiped, kept, checked in to, answered or voted on carries no memory, and the
-- feed only reaches back 365 days. events_prune_untouched() is the only place that
-- deletes a synced night now, and it refuses any row something still points at.
--
--   events_prune_untouched(days)   service only; returns how many rows went

drop function if exists public.events_prune_untouched(int);
create or replace function public.events_prune_untouched(p_days int default 400)
returns integer
language sql
security definer
set search_path = public
as $$
  with gone as (
    delete from public.events e
    where e.source = 'ticketmaster'
      and e.starts_at is not null
      and e.starts_at < now() - make_interval(days => greatest(coalesce(p_days, 400), 365))
      and not exists (select 1 from public.swipes              x where x.event_id = e.id)
      and not exists (select 1 from public.comments            x where x.event_id = e.id)
      and not exists (select 1 from public.checkins            x where x.event_id = e.id)
      and not exists (select 1 from public.room_posts          x where x.event_id = e.id)
      and not exists (select 1 from public.rsvps               x where x.event_id = e.id)
      and not exists (select 1 from public.tickets             x where x.event_id = e.id)
      and not exists (select 1 from public.event_about         x where x.event_id = e.id)
      and not exists (select 1 from public.group_swipes        x where x.event_id = e.id)
      and not exists (select 1 from public.group_live_skips    x where x.event_id = e.id)
      and not exists (select 1 from public.group_photos        x where x.event_id = e.id)
      and not exists (select 1 from public.group_round_options x where x.event_id = e.id)
      and not exists (select 1 from public.group_ballots       x where x.event_id = e.id)
      and not exists (select 1 from public.group_tickets       x where x.event_id = e.id)
      and not exists (select 1 from public.posts               x where x.event_id = e.id)
      and not exists (select 1 from public.groups              x where x.plan_event_id = e.id)
    returning 1
  )
  select count(*)::int from gone;
$$;

-- The sync calls it with the service key; no browser role may.
revoke execute on function public.events_prune_untouched(int) from public, anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('66_keep_past_nights.sql', 'c6bbe32a8697b1597cb2030db487d991b3ea853f0acc2413116ee63f59c143e6');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('66_keep_past_nights.sql');
  end if;
end $$;
