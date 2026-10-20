-- afterhours — the export, whole (89)
--
-- export_me() (14, 64) handed back profile, settings, swipes, comments, friends,
-- feedback, messages and tickets and nothing else, while the privacy notice promises
-- everything (F3, 20.10.2026). The function is that of 64 with every later table a
-- person writes to: check-ins (with the position of 88), room lines, rsvps, posts and
-- their likes and comments, groups (membership, own messages and photos), sparks and
-- answers, profile links and photo, who they blocked, reports they made, objections,
-- every notification switch, the DJ page they own, the nights they sent in.
-- Lines of other people are never in it; only what this person wrote.

create or replace function public.export_me()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'taken_at', now(),
    'about', 'Everything afterhours holds about you. Your account email lives'
             || ' with the sign-in provider, not in this database.',

    'profile', (
      select to_jsonb(x) from (
        select p.handle, p.display_name, p.bio, c.slug as city,
               p.created_at as joined, p.onboarded_at, p.last_seen_at
        from public.profiles p
        left join public.cities c on c.id = p.city_id
        where p.id = auth.uid()
      ) x),

    'settings', (
      select to_jsonb(x) from (
        select s.kept_visibility, s.discoverable, s.notify_email, s.locale
        from public.profile_settings s where s.user_id = auth.uid()
      ) x),

    'swipes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event', e.slug, 'title', e.title,
               'direction', w.direction, 'at', w.created_at)
             order by w.created_at)
      from public.swipes w
      join public.events e on e.id = w.event_id
      where w.user_id = auth.uid()
    ), '[]'::jsonb),

    'comments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event', e.slug, 'body', c.body,
               'reply_to', c.parent_id, 'at', c.created_at)
             order by c.created_at)
      from public.comments c
      join public.events e on e.id = c.event_id
      where c.author_id = auth.uid()
    ), '[]'::jsonb),

    'friendships', coalesce((
      select jsonb_agg(jsonb_build_object(
               'handle', p.handle, 'status', f.status,
               'direction', case when f.requester_id = auth.uid()
                                 then 'outgoing' else 'incoming' end,
               'at', f.created_at)
             order by f.created_at)
      from public.friendships f
      join public.profiles p
        on p.id = case when f.requester_id = auth.uid()
                       then f.addressee_id else f.requester_id end
      where f.requester_id = auth.uid() or f.addressee_id = auth.uid()
    ), '[]'::jsonb),

    'feedback', coalesce((
      select jsonb_agg(jsonb_build_object(
               'kind', g.kind, 'body', g.body, 'at', g.created_at)
             order by g.created_at)
      from public.feedback g where g.author_id = auth.uid()
    ), '[]'::jsonb),

    -- The lines you wrote, named by the friend they went to.
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
               'to', p.handle, 'body', m.body, 'at', m.created_at)
             order by m.id)
      from public.dm_messages m
      join public.dm_threads t on t.id = m.thread_id
      left join public.profiles p
        on p.id = case when t.a = auth.uid() then t.b else t.a end
      where m.user_id = auth.uid()
    ), '[]'::jsonb),

    'checkins', coalesce((
      select jsonb_agg(jsonb_build_object('event', e.slug, 'title', e.title, 'card_no', k.card_no,
               'at', k.checked_at, 'lat', k.lat, 'lng', k.lng, 'shown_to_friends', k.show_friends) order by k.checked_at)
      from public.checkins k join public.events e on e.id = k.event_id where k.user_id = auth.uid()), '[]'::jsonb),
    'room_lines', coalesce((
      select jsonb_agg(jsonb_build_object('event', e.slug, 'body', r.body, 'at', r.created_at) order by r.created_at)
      from public.room_posts r join public.events e on e.id = r.event_id where r.user_id = auth.uid()), '[]'::jsonb),
    'rsvps', coalesce((
      select jsonb_agg(jsonb_build_object('event', e.slug, 'answer', v.answer, 'at', v.updated_at) order by v.updated_at)
      from public.rsvps v join public.events e on e.id = v.event_id where v.user_id = auth.uid()), '[]'::jsonb),
    'posts', coalesce((
      select jsonb_agg(jsonb_build_object('body', p.body, 'photo', p.photo_path, 'event', e.slug, 'hidden', p.is_hidden, 'at', p.created_at) order by p.created_at)
      from public.posts p left join public.events e on e.id = p.event_id where p.author_id = auth.uid()), '[]'::jsonb),
    'post_likes', coalesce((
      select jsonb_agg(jsonb_build_object('post', l.post_id, 'at', l.created_at) order by l.created_at)
      from public.post_likes l where l.user_id = auth.uid()), '[]'::jsonb),
    'post_comments', coalesce((
      select jsonb_agg(jsonb_build_object('post', c.post_id, 'body', c.body, 'at', c.created_at) order by c.created_at)
      from public.post_comments c where c.author_id = auth.uid()), '[]'::jsonb),
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object('name', g.name, 'emoji', g.emoji, 'role', m.role, 'joined', m.joined_at,
               'messages', (select coalesce(jsonb_agg(jsonb_build_object('body', x.body, 'kind', x.kind, 'at', x.created_at) order by x.created_at), '[]'::jsonb)
                            from public.group_messages x where x.group_id = g.id and x.user_id = auth.uid()),
               'photos', (select coalesce(jsonb_agg(x.path order by x.created_at), '[]'::jsonb)
                          from public.group_photos x where x.group_id = g.id and x.user_id = auth.uid())) order by m.joined_at)
      from public.group_members m join public.groups g on g.id = m.group_id where m.user_id = auth.uid()), '[]'::jsonb),
    'sparks', coalesce((
      select jsonb_agg(jsonb_build_object('kind', s.kind, 'title', s.title, 'place', s.place, 'starts_at', s.starts_at, 'at', s.created_at) order by s.created_at)
      from public.sparks s where s.host_id = auth.uid()), '[]'::jsonb),
    'spark_answers', coalesce((
      select jsonb_agg(jsonb_build_object('spark', s.title, 'answer', i.answer, 'at', i.answered_at) order by i.answered_at)
      from public.spark_invites i join public.sparks s on s.id = i.spark_id where i.user_id = auth.uid()), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object('kind', l.kind, 'value', l.value) order by l.kind)
      from public.profile_links l where l.user_id = auth.uid()), '[]'::jsonb),
    'photo', (select f.path from public.profile_photos f where f.user_id = auth.uid()),
    'blocked', coalesce((
      select jsonb_agg(jsonb_build_object('handle', p.handle, 'at', b.created_at) order by b.created_at)
      from public.blocks b join public.profiles p on p.id = b.blocked_id where b.blocker_id = auth.uid()), '[]'::jsonb),
    'reports_made', coalesce((
      select jsonb_agg(jsonb_build_object('kind', r.kind, 'reason', r.reason, 'handled', r.handled, 'at', r.created_at) order by r.created_at)
      from public.reports r where r.reporter_id = auth.uid()), '[]'::jsonb),
    'appeals', coalesce((
      select jsonb_agg(jsonb_build_object('body', a.body, 'outcome', a.outcome, 'at', a.created_at) order by a.created_at)
      from public.appeals a where a.user_id = auth.uid()), '[]'::jsonb),
    'notifications', (
      select to_jsonb(x) from (
        select s.notify_requests, s.notify_accepts, s.notify_matches, s.notify_live, s.notify_nights, s.notify_rooms,
               s.notify_replies, s.notify_digest, s.notify_djs, s.notify_waves, s.notify_sparks, s.notify_groups, s.notify_posts, s.notify_dms
        from public.profile_settings s where s.user_id = auth.uid()) x),
    'dj_page', (
      select to_jsonb(x) from (select d.slug, d.name, d.genre, d.bio, d.verified from public.djs d where d.owner_id = auth.uid()) x),
    'nights_sent', coalesce((
      select jsonb_agg(jsonb_build_object('title', e.title, 'starts_at', e.starts_at, 'published', e.is_published, 'at', e.created_at) order by e.created_at)
      from public.events e where e.created_by = auth.uid()), '[]'::jsonb),

    'tickets', coalesce((
      select jsonb_agg(jsonb_build_object(
               'event', e.slug, 'title', e.title,
               'answer', k.answer, 'at', k.answered_at)
             order by k.answered_at)
      from public.tickets k
      join public.events e on e.id = k.event_id
      where k.user_id = auth.uid()
    ), '[]'::jsonb)
  )
  where auth.uid() is not null;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('89_export_all.sql', '7b31143e846e9a6f8410a1175e128cdacca2128dd437e2119333721d6c5127fb');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('89_export_all.sql');
  end if;
end $$;
