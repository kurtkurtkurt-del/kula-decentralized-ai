-- pasaport — the status check: is the content in place, what wants attention
-- Numbers only, readable with the public key (tools/health.mjs, the site's help page).
-- health_more marks the two that go red: a night left open for more than a day, pushes
-- older than six hours still unsent.

drop function if exists public.health();
create or replace function public.health()
returns table (projects bigint, open_projects bigint, people bigint, joins bigint, friendships bigint,
               nights bigint, nights_tonight bigint, tokens bigint, kwh numeric, credits numeric,
               passports bigint, coops bigint, calls_open bigint, nights_stuck bigint, outbox_stuck bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*) from public.projects where is_published),
    (select count(*) from public.projects where is_published and status = 'open'),
    (select count(*) from public.profiles),
    (select count(*) from public.joins where direction = 'right'),
    (select count(*) from public.friendships where status = 'accepted'),
    (select count(*) from public.contributions where card_no is not null),
    (select count(*) from public.contributions where ended_at is null),
    coalesce((select sum(tokens) from public.contributions), 0)::bigint,
    coalesce((select round(sum(kwh), 2) from public.contributions), 0),
    coalesce((select sum(amount) from public.credits), 0),
    (select count(distinct user_id) from public.passports),
    (select count(*) from public.coops),
    (select count(*) from public.calls where night >= public.night_of()),
    (select count(*) from public.contributions where ended_at is null and started_at < now() - interval '1 day'),
    (select count(*) from public.push_outbox where sent_at is null and send_after < now() - interval '6 hours');
$$;
grant execute on function public.health() to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('15_health.sql', 'b8b7a43cc149385a7f4ddd9bfd28059ba00292919a3e7fcf5dfe9344d87e0a51');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('15_health.sql');
  end if;
end $$;
