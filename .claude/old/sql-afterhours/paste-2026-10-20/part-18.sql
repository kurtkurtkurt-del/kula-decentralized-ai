-- paste 18/24: 88
create or replace function public.check_out(p_slug text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.checkins%rowtype;
begin
  if auth.uid() is null then raise exception 'signedout'; end if;
  select c0.* into c from public.checkins c0 join public.events e on e.id = c0.event_id
   where c0.user_id = auth.uid() and e.slug = p_slug;
  if c.id is null then return false; end if;
  if c.checked_at < now() - interval '1 hour' then raise exception 'toolate'; end if;
  delete from public.push_outbox
   where sent_at is null and (key = 'room_open:' || c.id::text or key like 'live:%:' || c.id::text);
  delete from public.checkins where id = c.id;
  return true;
end;
$$;

grant execute on function public.check_out(text) to authenticated;

create or replace function public.push_on_checkin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  night  record;
  friend uuid;
begin
  select e.title, e.slug, v.name as venue
    into night
  from public.events e left join public.venues v on v.id = e.venue_id
  where e.id = new.event_id;

  perform public.push_enqueue(new.user_id, 'room_open', format('room_open:%s', new.id),
    jsonb_build_object('title', night.title, 'url', '/room/' || night.slug));

  if new.show_friends and new.live then
    for friend in select f.friend from public.push_edges f where f.who = new.user_id loop
      perform public.push_enqueue(friend, 'friend_live',
        format('live:%s:%s', friend, new.id),
        jsonb_build_object('name', public.push_name(new.user_id),
                           'title', coalesce(night.venue || ' · ', '') || night.title,
                           'url', '/night/' || night.slug));
    end loop;
  end if;
  return new;
end;
$$;

create or replace function public.friends_live()
returns table (
  friend_id     uuid,
  handle        text,
  display_name  text,
  slug          text,
  title         text,
  venue_name    text,
  checked_at    timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select c.user_id, p.handle, p.display_name, e.slug, e.title, v.name, date_trunc('hour', c.checked_at)
  from public.checkins c
  join public.profiles p on p.id = c.user_id
  join public.events e on e.id = c.event_id
  left join public.venues v on v.id = e.venue_id
  where c.show_friends and c.live
    and c.checked_at > now() - interval '8 hours'
    and public.is_friend(c.user_id)
  order by c.checked_at desc;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('88_checkin_truth.sql', 'd29cb8a9f3e17270d5f4fb130240b544df21cdf44a76ee452afae94dc84f78d9');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('88_checkin_truth.sql');
  end if;
end $$;
