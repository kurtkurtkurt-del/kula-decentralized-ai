-- afterhours — "I am in" reaches the friends on that night (69)
--
-- A friend answers who is coming with in (32) and nobody heard of it; a keep (a right
-- swipe) already tells the friends who kept the same night "{name} is going too"
-- (26, kind match). An answer is a louder keep: the same push, to the friends who
-- kept the night or answered in themselves, once per answerer and night. It rides on
-- the match switch (notify_matches) and the match words (58), so nothing new to set
-- or translate; the key says rsvp so it never collides with the push of the keep itself.
-- Nothing when the answerer keeps their keeps private (12: kept_visibility), as with
-- the keep itself. maybe and out say nothing. (C1, 20.10.2026)

create or replace function public.push_on_rsvp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  night record;
  them  record;
begin
  if new.answer <> 'in' or (tg_op = 'UPDATE' and old.answer = 'in') then
    return new;
  end if;
  if not public.kept_visible(new.user_id) then
    return new;
  end if;
  select e.title, e.slug into night from public.events e where e.id = new.event_id;

  for them in
    select distinct f.friend as user_id
    from public.push_edges f
    where f.who = new.user_id
      and (exists (select 1 from public.swipes w where w.user_id = f.friend and w.event_id = new.event_id and w.direction = 'right')
        or exists (select 1 from public.rsvps r where r.user_id = f.friend and r.event_id = new.event_id and r.answer = 'in'))
  loop
    perform public.push_enqueue(them.user_id, 'match',
      format('rsvp:%s:%s:%s', them.user_id, new.user_id, new.event_id),
      jsonb_build_object('name', public.push_name(new.user_id), 'title', night.title, 'url', '/night/' || night.slug));
  end loop;
  return new;
end;
$$;
revoke execute on function public.push_on_rsvp() from public, anon, authenticated;

drop trigger if exists push_rsvp on public.rsvps;
create trigger push_rsvp
  after insert or update of answer on public.rsvps
  for each row execute function public.push_on_rsvp();

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('69_rsvp_push.sql', '2979cba607450c3b34c5072b421b570596c8212155ba082c72a43ff3d8a5848d');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('69_rsvp_push.sql');
  end if;
end $$;
