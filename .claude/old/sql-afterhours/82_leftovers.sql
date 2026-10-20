-- afterhours — a file goes with its row (82)
--
-- The photos bucket is public in the storage sense: whoever holds the address sees
-- the file. Removing a post, a group photo, a cover or a face only ever deleted the
-- row (and the app tried to remove the file from the phone, when it was online and
-- had not crashed); a photo the staff hid stayed served; a deleted account and a
-- pruned guest left their folder behind (F39, 20.10.2026). Decided: the file goes
-- with the row, and a hidden post loses its photo at once. The text stays as the
-- record. Done in the database so that no client is trusted to clean up.
--
--   storage_drop(path)        one object of the photos bucket, service level
--   storage_drop_folder(uid)  everything under a person
-- The triggers below fire on delete, on a replaced path and on hiding. Outside
-- Supabase (the tests) storage.objects may not exist; then there is nothing to drop.

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

-- One trigger body: the argument names the path column.
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
create trigger photo_gone_groups         after delete or update of cover_path            on public.groups         for each row execute function public.photo_gone('cover_path');
create trigger folder_gone_profiles      after delete                                    on public.profiles       for each row execute function public.folder_gone();

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('82_leftovers.sql', 'fd331d73d48eca15b020a2173b0828c697fd674a6e72ab30ea4759e2cc933dbf');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('82_leftovers.sql');
  end if;
end $$;
