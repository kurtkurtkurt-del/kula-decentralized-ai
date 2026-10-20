-- afterhours — who is coming: your answer to a night, seen by your friends
-- "who is coming?" on yours asks in · maybe · out. Until now the answer stayed on
-- the phone; here it is stored, and your confirmed friends see it next to your
-- face (and you see theirs).
--
--   rsvp_set(event, answer)   in · maybe · out; null or empty takes it back
--   rsvp_for(events[])        the answers of you and your friends for these nights
--
-- The table is closed (RLS on, no policies, no grants). Answers are for
-- friends only: nobody else can read them, not even who answered at all.

create table if not exists public.rsvps (
  user_id     uuid not null references public.profiles on delete cascade,
  event_id    uuid not null references public.events on delete cascade,
  answer      text not null check (answer in ('in', 'maybe', 'out')),
  updated_at  timestamptz not null default now(),
  primary key (user_id, event_id)
);
create index if not exists rsvps_event_idx on public.rsvps (event_id);
alter table public.rsvps enable row level security;
revoke all on public.rsvps from public, anon, authenticated;

drop function if exists public.rsvp_set(uuid, text);
create or replace function public.rsvp_set(p_event uuid, p_answer text)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if coalesce(p_answer, '') = '' then
    delete from public.rsvps where user_id = auth.uid() and event_id = p_event;
    return;
  end if;
  if p_answer not in ('in', 'maybe', 'out') then
    raise exception 'answer is in, maybe or out' using errcode = '22023';
  end if;
  if not exists (select 1 from public.events where id = p_event) then
    raise exception 'no such night' using errcode = '22023';
  end if;
  insert into public.rsvps (user_id, event_id, answer) values (auth.uid(), p_event, p_answer)
  on conflict (user_id, event_id) do update set answer = excluded.answer, updated_at = now();
end;
$$;

-- name: handle, else the display name (the same key friends_kept uses).
drop function if exists public.rsvp_for(uuid[]);
create or replace function public.rsvp_for(p_events uuid[])
returns table (event_id uuid, user_id uuid, name text, answer text, mine boolean)
language sql
stable
security definer
set search_path = public
as $$
  select r.event_id, r.user_id, lower(coalesce(p.handle, p.display_name, 'someone')), r.answer, r.user_id = auth.uid()
  from public.rsvps r
  join public.profiles p on p.id = r.user_id
  where auth.uid() is not null
    and r.event_id = any (coalesce(p_events, '{}'))
    and (r.user_id = auth.uid() or public.is_friend(r.user_id))
  order by r.event_id, (r.answer = 'in') desc, (r.answer = 'maybe') desc, r.updated_at desc;
$$;

revoke execute on function public.rsvp_set(uuid, text) from public, anon;
revoke execute on function public.rsvp_for(uuid[])    from public, anon;
grant execute on function public.rsvp_set(uuid, text) to authenticated;
grant execute on function public.rsvp_for(uuid[])     to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('32_rsvp.sql', 'fc4b2a54d1022c7c69ee67d70656026c078cf9cc2dfcc8b280a371ad5dd133e1');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('32_rsvp.sql');
  end if;
end $$;
