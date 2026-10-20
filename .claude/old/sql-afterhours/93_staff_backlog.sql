-- afterhours — what the staff have left waiting (93)
--
-- The staff hear of a report by push alone (staff_ping); with no phone registered
-- nobody hears, and nothing watches the promise of a look within 24 hours
-- (F38, 20.10.2026). staff_backlog() counts what has waited too long - reports
-- open for 20 hours, objections for 3 days, nights sent in for 3 days - and
-- tools/health.mjs goes red on it, which the morning health workflow turns into
-- a failed run and a mail. No new service; the repository already sends those.

create or replace function public.staff_backlog()
returns table (reports_waiting int, oldest_report timestamptz, appeals_waiting int, nights_waiting int)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(distinct (r.kind, r.target))::int from public.reports r
      where not r.handled and r.created_at < now() - interval '20 hours'),
    (select min(r.created_at) from public.reports r where not r.handled),
    (select count(*)::int from public.appeals a where a.settled_at is null and a.created_at < now() - interval '3 days'),
    (select count(*)::int from public.events e where not e.is_published and e.source = 'user' and e.created_at < now() - interval '3 days');
$$;
grant execute on function public.staff_backlog() to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('93_staff_backlog.sql', 'fbc4f21a9db0099d046ecc689a1c54cd1b1a3476683c1e0da9181a290cb9b6fc');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('93_staff_backlog.sql');
  end if;
end $$;
