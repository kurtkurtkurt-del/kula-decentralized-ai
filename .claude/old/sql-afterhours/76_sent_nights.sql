-- afterhours — a night sent in: the sender hears, can take it back, and the stale
-- ones leave the queue (76)
--
-- Someone sent a night in (43) and then nothing: no word when the staff let it through
-- or turned it down, no way to take it back, and a night whose date had passed sat in
-- the queue forever, counting against the five a person may have waiting (F24,
-- 20.10.2026). Three things:
--   staff_review     the same as 43, plus a notice to the sender: night_ok / night_no
--                    (with the note the staff wrote, if any)
--   event_withdraw   the sender takes a waiting night back
--   submissions_expire  a waiting night whose date has passed is turned down with the
--                    note "the date passed"; the staff queue runs it first, so it
--                    never needs a clock job, and the five-limit counts only the live ones

alter table public.notices drop constraint if exists notices_kind_check;
alter table public.notices add constraint notices_kind_check
  check (kind in ('comment_hidden', 'post_hidden', 'removed', 'profile_cleared',
                  'role', 'dj_verified', 'dj_hidden', 'report_removed', 'report_kept',
                  'night_ok', 'night_no'));

create or replace function public.staff_review(p_id uuid, p_ok boolean, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.events%rowtype;
begin
  perform public.need_staff();
  select * into e from public.events where id = p_id and review = 'pending';
  if e.id is null then raise exception 'nothing waiting with that id'; end if;
  if p_ok then
    update public.events set review = null, review_note = null, is_published = true, updated_at = now() where id = p_id;
  else
    update public.events set review = 'rejected', review_note = left(nullif(btrim(p_note), ''), 300), is_published = false, updated_at = now() where id = p_id;
  end if;
  perform public.notice(e.created_by, case when p_ok then 'night_ok' else 'night_no' end,
                        jsonb_build_object('title', e.title, 'slug', e.slug,
                                           'note', coalesce(left(nullif(btrim(p_note), ''), 300), '')));
  perform public.staff_note(case when p_ok then 'approve' else 'reject' end, 'night', e.slug, e.title);
end;
$$;

-- The sender takes a waiting night back. Only theirs, only while it waits.
create or replace function public.event_withdraw(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.events
   where id = p_id and created_by = auth.uid() and source = 'user' and review = 'pending';
  if not found then
    raise exception 'nothing of yours waiting with that id' using errcode = '42501';
  end if;
end;
$$;
revoke execute on function public.event_withdraw(uuid) from public, anon;
grant execute on function public.event_withdraw(uuid) to authenticated;

-- A waiting night whose date has passed: turned down, with a note, and the sender told.
create or replace function public.submissions_expire()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  e record;
  n int := 0;
begin
  for e in select id, created_by, title, slug from public.events
           where review = 'pending' and starts_at is not null and starts_at < now() loop
    update public.events set review = 'rejected', review_note = 'the date passed', is_published = false, updated_at = now()
     where id = e.id;
    perform public.notice(e.created_by, 'night_no', jsonb_build_object('title', e.title, 'slug', e.slug, 'note', 'the date passed'));
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function public.submissions_expire() from public, anon, authenticated;

-- The staff queue, with the stale ones cleared first. The return type is that of 43.
create or replace function public.staff_pending()
returns table (id uuid, slug text, title text, city_slug text, type_slug text, venue_name text,
               starts_at timestamptz, body text, ticket_url text, image_url text, maker text, handle text, sent_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_staff() then
    perform public.submissions_expire();
  end if;
  return query
    select e.id, e.slug, e.title, c.slug, t.slug, v.name, e.starts_at, e.body, e.ticket_url, e.image_url,
           p.display_name, p.handle, e.created_at
    from public.events e
    join public.cities c on c.id = e.city_id
    join public.event_types t on t.id = e.type_id
    left join public.venues v on v.id = e.venue_id
    left join public.profiles p on p.id = e.created_by
    where e.review = 'pending' and public.is_staff()
    order by e.created_at;
end;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('76_sent_nights.sql', '6083e440d0d3933f27cc25255c38e079b8d251c5e3994c4741ba85b8eeccb3e8');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('76_sent_nights.sql');
  end if;
end $$;
