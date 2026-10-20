-- paste 13/24: 79 80 81 82
do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('79_word_watch.sql', '3a484dd375b17d135f53c7eb72bbd97bb12469d790015c60347746d280e4fec7');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('79_word_watch.sql');
  end if;
end $$;

create or replace function public.guest_merge(p_guest uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  n  int;
begin
  if me is null or public.is_guest() then raise exception 'sign in first'; end if;
  if p_guest is null or p_guest = me then return 0; end if;
  if not exists (select 1 from auth.users u where u.id = p_guest and coalesce(u.is_anonymous, false) and u.email is null) then
    raise exception 'not a guest';
  end if;
  insert into public.swipes (user_id, event_id, direction, created_at)
  select me, s.event_id, s.direction, s.created_at from public.swipes s where s.user_id = p_guest
  on conflict (user_id, event_id) do nothing;
  get diagnostics n = row_count;
  delete from auth.users where id = p_guest;
  return n;
end;
$$;

grant execute on function public.guest_merge(uuid) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('80_guest_merge.sql', 'd053253ca69f493d9d74c7f94056bef8327b61d0a65d7ba9beaf129d90b5e3d0');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('80_guest_merge.sql');
  end if;
end $$;

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

create or replace function public.storage_drop(p_path text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_path is null or to_regclass('storage.objects') is null then return; end if;
  execute 'delete from storage.objects where bucket_id = $1 and name = $2' using 'photos', p_path;
end;
$$;

revoke execute on function public.storage_drop(text) from public, anon, authenticated;

create or replace function public.storage_drop_folder(p_uid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_uid is null or to_regclass('storage.objects') is null then return; end if;
  execute 'delete from storage.objects where bucket_id = $1 and name like $2' using 'photos', p_uid::text || '/%';
end;
$$;

revoke execute on function public.storage_drop_folder(uuid) from public, anon, authenticated;

create or replace function public.photo_gone()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  col  text := tg_argv[0];
  was  text := case when tg_op = 'INSERT' then null else to_jsonb(old) ->> col end;
  now_ text := case when tg_op = 'DELETE' then null else to_jsonb(new) ->> col end;
begin
  if tg_op = 'DELETE' then
    perform public.storage_drop(was);
    return old;
  end if;
  if was is distinct from now_ then
    perform public.storage_drop(was);
  elsif (to_jsonb(new) ->> 'is_hidden')::boolean and not coalesce((to_jsonb(old) ->> 'is_hidden')::boolean, false) then
    perform public.storage_drop(now_);
  end if;
  return new;
end;
$$;

create or replace function public.folder_gone()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.storage_drop_folder(old.id);
  return old;
end;
$$;

drop trigger if exists photo_gone_posts          on public.posts;

drop trigger if exists photo_gone_profile_photos on public.profile_photos;

drop trigger if exists photo_gone_group_photos   on public.group_photos;

drop trigger if exists photo_gone_groups         on public.groups;

drop trigger if exists folder_gone_profiles      on public.profiles;

create trigger photo_gone_posts          after delete or update of photo_path, is_hidden on public.posts          for each row execute function public.photo_gone('photo_path');

create trigger photo_gone_profile_photos after delete or update of path                  on public.profile_photos for each row execute function public.photo_gone('path');

create trigger photo_gone_group_photos   after delete or update of path                  on public.group_photos   for each row execute function public.photo_gone('path');
