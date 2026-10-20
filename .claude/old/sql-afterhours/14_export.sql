-- afterhours — everything we hold about one person, in one call
-- The GDPR calls this the right of access (Art. 15) and the right to data
-- portability (Art. 20): a person may ask for their own data, and get it
-- in a form a machine can read. The site says so in datenschutz, so it has
-- to be true.
--
-- One function, and it only ever answers about the caller. There is no
-- argument to point it at somebody else.

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

    -- Which nights you swiped, and which way. The event is named by its
    -- slug so the file still means something away from this database.
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

    -- Both directions, by handle. Another handle belongs to that person, but
    -- the fact of the friendship is yours as much as theirs.
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
    ), '[]'::jsonb)
  )
  where auth.uid() is not null;
$$;

-- Signed out there is nobody to describe, so this is for accounts only.
grant execute on function public.export_me() to authenticated;

-- Stamp the migration log, if it is there (00_migrations.sql).
do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('14_export.sql', '6c42d037a8d8af5cf230e0832ee2cb6adde149e91c42127f2aa8ade0a997479a');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('14_export.sql');
  end if;
end $$;
