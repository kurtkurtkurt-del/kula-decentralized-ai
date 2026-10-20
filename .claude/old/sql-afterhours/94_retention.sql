-- afterhours — what is kept, and for how long (94)
--
-- The privacy notice promised periods the code did not keep: pushes stayed in the
-- outbox for ever, settled reports and objections never left (F5, 20.10.2026).
-- retention_prune() runs every night at 04:45 and holds the database to the notice:
--   push_outbox     sent pushes after 30 days, unsent ones after 7
--   reports         settled ones a year after they were made (repeat offences are
--                   recognised within that year; the copy of 84 goes with them)
--   appeals         settled ones after a year
--   notices         read or not, after 90 days
-- Guests (54, 30 days), client errors (51, 30 days) and the backups (90 and 30 days)
-- keep their own clocks. Returns how many rows went, for the log.

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
