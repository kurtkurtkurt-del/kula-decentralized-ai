-- afterhours — the health check says when the sync last brought a night, and
-- whether the push outbox is stuck (71)
--
-- health() (09) counted rows; it could not say whether the morning sync still ran or
-- whether pushes were leaving. On 11.10.2026 nobody knew for a week that 680 past
-- nights sat on the deck (F34, 20.10.2026). Two more numbers, and tools/health.mjs
-- now goes red on them: a last synced night older than three days, more than fifty
-- past nights still published, pushes older than six hours still unsent.
-- The return type grows, so the function is dropped and made again with its grants.

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
  friendships       bigint,
  newest_synced     timestamptz,
  outbox_stuck      bigint
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
    (select count(*) from public.friendships where status = 'accepted'),
    (select max(created_at) from public.events where source = 'ticketmaster'),
    (select count(*) from public.push_outbox
      where sent_at is null
        and greatest(created_at, coalesce(send_after, created_at)) < now() - interval '6 hours');
$$;
grant execute on function public.health() to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('71_health_more.sql', '8454b42f5a542d7fa6e981f35678d9dd0f029d4e79f77cb64ad099e93da0e904');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('71_health_more.sql');
  end if;
end $$;
