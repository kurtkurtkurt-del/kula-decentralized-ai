-- afterhours — is the clock running (87)
--
-- Six jobs hang off pg_cron: push_flush, push_hourly, group_push_hourly,
-- hide_past_events, guests_prune, the error prune. If the extension is off or a job
-- is unscheduled, every one of them dies in silence and nothing says so (F11,
-- 20.10.2026; the deck has filtered its own dates since 67). cron_health() reads
-- the cron schema when it is there - how many afterhours jobs are scheduled, when
-- one last ran well, when one last failed - and tools/health.mjs goes red when the
-- last good run is more than two hours old. Outside Supabase (the tests) the schema
-- is missing and the answer is zero and null.

create or replace function public.cron_health()
returns table (jobs int, last_ok timestamptz, last_failed timestamptz, failed_24h int)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if to_regclass('cron.job') is null or to_regclass('cron.job_run_details') is null then
    return query select 0, null::timestamptz, null::timestamptz, 0;
    return;
  end if;
  return query execute $q$
    select (select count(*)::int from cron.job where active),
           (select max(end_time) from cron.job_run_details where status = 'succeeded'),
           (select max(end_time) from cron.job_run_details where status = 'failed'),
           (select count(*)::int from cron.job_run_details where status = 'failed' and end_time > now() - interval '24 hours')
  $q$;
end;
$$;
grant execute on function public.cron_health() to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('87_cron_health.sql', '66855abff143fb2e064f228a9169eda723792c65e627a10e8998c1f8813e3715');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('87_cron_health.sql');
  end if;
end $$;
