-- paste 21/24: 92 93 94
do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('92_timezones.sql', 'bb1f5f9b344cce65c9f9b6c0f4a0680a7d768a0160d4116bc1aa66b611e3d676');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('92_timezones.sql');
  end if;
end $$;

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

create or replace function public.retention_prune()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
  k int;
begin
  delete from public.push_outbox where (sent_at is not null and sent_at < now() - interval '30 days')
                                    or (sent_at is null and created_at < now() - interval '7 days');
  get diagnostics k = row_count; n := n + k;
  delete from public.reports where handled and created_at < now() - interval '1 year';
  get diagnostics k = row_count; n := n + k;
  delete from public.appeals where settled_at is not null and settled_at < now() - interval '1 year';
  get diagnostics k = row_count; n := n + k;
  delete from public.notices where created_at < now() - interval '90 days';
  get diagnostics k = row_count; n := n + k;
  return n;
end;
$$;

revoke execute on function public.retention_prune() from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'afterhours-retention';
    perform cron.schedule('afterhours-retention', '45 4 * * *', $q$select public.retention_prune()$q$);
  end if;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('94_retention.sql', '97eaddca67f1c86737829fd9206277640cf2c524ef5964688cf53d8d100ef94a');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('94_retention.sql');
  end if;
end $$;
