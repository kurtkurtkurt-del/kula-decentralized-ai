-- afterhours — a night that happened still has its page (95)
--
-- Since 66 a synced night whose date has passed is retired (is_published = false)
-- instead of deleted, and 72 does the same to a cancelled one. The night page reads
-- events_public, whose rule shows published rows only, so a card in the collection,
-- the past feed or a passport opened onto an empty page (F40, found by the second
-- cloud night, 20.10.2026). night_page(slug) returns the one row when it is published,
-- or a synced night that is over or was cancelled: those were public listings and
-- stay public facts. A night someone sent in that the staff have not let through
-- stays hidden. The app falls back to it when the plain read finds nothing.

create or replace function public.night_page(p_slug text)
returns setof public.events_public
language sql
stable
security definer
set search_path = public
as $$
  select v.* from public.events_public v
  join public.events e on e.id = v.id
  where v.slug = p_slug
    and (e.is_published
         or (e.source = 'ticketmaster' and (e.starts_at < now() or e.status = 'cancelled')))
  limit 1;
$$;
grant execute on function public.night_page(text) to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('95_past_night_page.sql', '1da0cd5eefa1e83a8d6434dd53daf9266a338056feddb64865258a4367000593');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('95_past_night_page.sql');
  end if;
end $$;
