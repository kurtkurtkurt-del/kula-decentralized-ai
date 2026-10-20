-- paste 10/24: 75 76
create or replace function public.push_wants(p_user uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select case
             when p_kind = 'friend_request'  then s.notify_requests
             when p_kind = 'friend_accepted' then s.notify_accepts
             when p_kind = 'match'           then s.notify_matches
             when p_kind = 'friend_live'     then s.notify_live
             when p_kind in ('night_soon', 'night_changed') then s.notify_nights
             when p_kind in ('room_open', 'room_closing', 'room_message') then s.notify_rooms
             when p_kind = 'reply'           then s.notify_replies
             when p_kind = 'digest'          then s.notify_digest
             when p_kind = 'dj_live'         then s.notify_djs
             when p_kind = 'wave'            then s.notify_waves
             when p_kind in ('spark', 'spark_in', 'spark_off') then s.notify_sparks
             when p_kind like 'group\_%' then s.notify_groups
             when p_kind in ('post', 'post_like', 'post_comment') then s.notify_posts
             when p_kind = 'dm'              then s.notify_dms
           end
    from public.profile_settings s where s.user_id = p_user), true);
$$;

create or replace function public.spark_cancel(p_spark uuid)
returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  s    public.sparks%rowtype;
  them record;
begin
  select * into s from public.sparks where id = p_spark and host_id = auth.uid();
  if s.id is null then
    raise exception 'not yours' using errcode = '42501';
  end if;
  for them in select i.user_id from public.spark_invites i where i.spark_id = s.id and i.answer = 'in' loop
    perform public.push_enqueue(them.user_id, 'spark_off',
      format('spark_off:%s:%s', s.id, them.user_id),
      jsonb_build_object('name', public.push_name(s.host_id), 'title', s.title, 'url', '/connect'));
  end loop;
  delete from public.sparks where id = s.id;
end;
$$;

revoke execute on function public.spark_cancel(uuid) from public, anon;

grant execute on function public.spark_cancel(uuid)  to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('75_spark_off.sql', 'fe74781c189f738a245bb740adb7e31b872f355d7b50cbec940c32acabf97960');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('75_spark_off.sql');
  end if;
end $$;

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
