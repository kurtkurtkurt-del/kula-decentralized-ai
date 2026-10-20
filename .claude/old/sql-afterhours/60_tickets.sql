-- afterhours — did you get your ticket? (60)
--
-- Ticketmaster tells nobody who bought what, so the app asks you once, when you come
-- back from the ticket page: got it / not this time. The answer is yours alone.
--
--   tickets                   one row per person and night: got · no, and when
--   ticket_mark(slug, answer) your answer (members only; a guest is refused)
--   ticket_state(slug)        your answer for a night, or null
--   tickets_mine()            the nights you have a ticket for (ids)
-- Nobody else reads it; the row goes with the account. Not in the export yet (14).

create table if not exists public.tickets (
  user_id      uuid not null references public.profiles(id) on delete cascade,
  event_id     uuid not null references public.events(id) on delete cascade,
  answer       text not null check (answer in ('got', 'no')),
  answered_at  timestamptz not null default now(),
  primary key (user_id, event_id)
);
alter table public.tickets enable row level security;
revoke all on public.tickets from public, anon, authenticated;
drop trigger if exists guard_banned on public.tickets;
create trigger guard_banned before insert or update on public.tickets for each row execute function public.guard_banned();

create or replace function public.ticket_mark(p_slug text, p_answer text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  e  uuid;
begin
  if public.is_guest() then raise exception 'sign up first'; end if;
  if p_answer not in ('got', 'no') then raise exception 'got or no'; end if;
  select id into e from public.events where slug = p_slug and is_published;
  if e is null then raise exception 'no such night'; end if;
  insert into public.tickets (user_id, event_id, answer) values (me, e, p_answer)
  on conflict (user_id, event_id) do update set answer = excluded.answer, answered_at = now();
end;
$$;
revoke execute on function public.ticket_mark(text, text) from public, anon;
grant execute on function public.ticket_mark(text, text) to authenticated;

create or replace function public.ticket_state(p_slug text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select t.answer from public.tickets t join public.events e on e.id = t.event_id
  where e.slug = p_slug and t.user_id = auth.uid();
$$;
revoke execute on function public.ticket_state(text) from public, anon;
grant execute on function public.ticket_state(text) to authenticated;

create or replace function public.tickets_mine()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select t.event_id from public.tickets t where t.user_id = auth.uid() and t.answer = 'got';
$$;
revoke execute on function public.tickets_mine() from public, anon;
grant execute on function public.tickets_mine() to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('60_tickets.sql', '54fd0d0743f10a2c958b19fb80e0f7751fcfa920dea9f7cf6b69397bb15b8d60');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('60_tickets.sql');
  end if;
end $$;
