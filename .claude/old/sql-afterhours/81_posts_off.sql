-- afterhours — posts are off (81)
--
-- The yours tab has been hidden since 12.10.2026; post/new and the past feed were
-- reachable only from there, and a like or a comment still sent a push whose link
-- opened nothing (F26, 20.10.2026). Decided: take posts down for the release rather
-- than find them a new home. The tables, the triggers and the staff view stay; the
-- app redirects its two screens (content/flags.ts POSTS_ON) and push_wants here says
-- no to every post kind, whatever the person set, so nothing leaves the outbox.
-- push_wants is that of 75 with the one line; flip the line back with the flag.

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
             when p_kind in ('post', 'post_like', 'post_comment') then false
             when p_kind = 'dm'              then s.notify_dms
           end
    from public.profile_settings s where s.user_id = p_user), true);
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('81_posts_off.sql', '7c72d645cc6875566aa55521c252c5e172b32bd7d31347588831a2ed4da19bab');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('81_posts_off.sql');
  end if;
end $$;
