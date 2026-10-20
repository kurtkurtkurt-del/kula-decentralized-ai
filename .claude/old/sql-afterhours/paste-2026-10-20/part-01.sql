-- paste 1/24: 64 65 66
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

grant execute on function public.export_me() to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('64_export_more.sql', '75d37ddd068f002d692f299f8840fb3b69b703a57eae0d056f84cec6144a4bd4');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('64_export_more.sql');
  end if;
end $$;

create or replace function public.delete_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  g  uuid;
begin
  if me is null then
    raise exception 'sign in first';
  end if;

  if exists (select 1 from public.profiles where id = me and is_admin)
     and not exists (select 1 from public.profiles where is_admin and id <> me) then
    raise exception 'the last admin stays an admin';
  end if;

  for g in select group_id from public.group_members where user_id = me loop
    delete from public.group_members where group_id = g and user_id = me;
    if not exists (select 1 from public.group_members where group_id = g) then
      delete from public.groups where id = g;
    elsif not exists (select 1 from public.group_members where group_id = g and role = 'owner') then
      update public.group_members set role = 'owner'
       where group_id = g and user_id = (select user_id from public.group_members
                                          where group_id = g order by joined_at, user_id limit 1);
    end if;
  end loop;

  update public.comments
     set author_id = null, author_name = 'someone'
   where author_id = me;

  delete from auth.users where id = me;
end;
$$;

grant execute on function public.delete_account() to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('65_account_delete.sql', '4b82eceeb5cf323a09884a8024f5fe06ee48435a83bfcb089160c9f3b6a3aa8e');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('65_account_delete.sql');
  end if;
end $$;

drop function if exists public.events_prune_untouched(int);
