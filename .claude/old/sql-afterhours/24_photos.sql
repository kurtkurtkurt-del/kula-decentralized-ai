-- afterhours — the photograph on a profile
--
-- One photograph per person, shown at the top of their account and, to
-- their CONFIRMED friends, wherever the app draws that friend. Nobody
-- else: not a stranger who knows the handle, not someone whose request
-- is still waiting.
--
-- The picture itself lives in the storage bucket "photos", at
-- <user id>/<number>.jpg. What this table keeps is only that path. It is
-- a table of its own and not a column on profiles, because profiles can
-- be read by anyone LINKED to you — a pending request included — and a
-- face is owed to fewer people than a handle is.
--
-- The bucket is public in the storage sense: a file is served to whoever
-- holds its address, without a token, so an <Image> can simply load it.
-- The address is the secret; it is handed out by the rule below and by
-- nothing else, and it changes every time the photograph does.

create table if not exists public.profile_photos (
  user_id     uuid primary key references public.profiles (id) on delete cascade,
  path        text not null,
  updated_at  timestamptz not null default now(),
  constraint profile_photos_path_shape
    check (path ~ '^[0-9a-f-]{36}/[0-9]{1,16}[.]jpg$'),
  constraint profile_photos_path_own
    check (split_part(path, '/', 1) = user_id::text)
);

alter table public.profile_photos enable row level security;

-- confirmed friends, either direction (the same question 19 asks; asked
-- here again so this file does not depend on the check-ins being there)
create or replace function public.photo_friend(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and ((f.requester_id = auth.uid() and f.addressee_id = other)
        or (f.addressee_id = auth.uid() and f.requester_id = other))
  );
$$;
revoke execute on function public.photo_friend(uuid) from public, anon;
grant execute on function public.photo_friend(uuid) to authenticated;

drop policy if exists profile_photos_read on public.profile_photos;
create policy profile_photos_read on public.profile_photos for select
  using (user_id = auth.uid() or public.photo_friend(user_id));

-- Reading only. Writing goes through photo_set(), which knows whose row
-- it is; there is no insert, update or delete grant to get around it.
revoke all on public.profile_photos from anon, authenticated;
grant select on public.profile_photos to authenticated;

-- ------------------------------------------------------------ photo_set

-- Called after the file has been uploaded. null takes the photograph
-- away. Returns the path that was there BEFORE, so the app can remove
-- the old file from the bucket (the database cannot: storage rows are
-- not ours to delete).
drop function if exists public.photo_set(text);
create or replace function public.photo_set(p_path text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  was text;
begin
  if auth.uid() is null then
    raise exception 'signedout';
  end if;
  -- a guest has no friends to show a face to, and no account to keep it
  if coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'is_anonymous')::boolean, false) then
    raise exception 'guest';
  end if;

  select path into was from public.profile_photos where user_id = auth.uid();

  if p_path is null or btrim(p_path) = '' then
    delete from public.profile_photos where user_id = auth.uid();
    return was;
  end if;

  if split_part(p_path, '/', 1) <> auth.uid()::text then
    raise exception 'notyours';
  end if;

  insert into public.profile_photos (user_id, path)
  values (auth.uid(), p_path)
  on conflict (user_id) do update set path = excluded.path, updated_at = now();

  return was;
end;
$$;
revoke execute on function public.photo_set(text) from public, anon;
grant execute on function public.photo_set(text) to authenticated;

-- --------------------------------------------------------------- bucket

-- Supabase only: skipped elsewhere, like the poster and the sound store.
-- 3 MB and jpeg only; the app sends about 200 KB (1080 px wide).
do $$
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    raise notice 'no storage schema - photo store skipped (running locally)';
    return;
  end if;
  execute $q$
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('photos', 'photos', true, 3145728, array['image/jpeg'])
    on conflict (id) do update
      set public = true, file_size_limit = 3145728, allowed_mime_types = array['image/jpeg']
  $q$;

  -- No select policy on purpose: a public bucket serves a file by its
  -- address without one, and without one nobody can LIST the bucket.
  execute $q$ drop policy if exists "photos owner writes" on storage.objects $q$;
  execute $q$
    create policy "photos owner writes" on storage.objects
      for insert to authenticated
      with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text)
  $q$;
  execute $q$ drop policy if exists "photos owner removes" on storage.objects $q$;
  execute $q$
    create policy "photos owner removes" on storage.objects
      for delete to authenticated
      using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text)
  $q$;
  -- removing through the storage API reads the row first
  execute $q$ drop policy if exists "photos owner sees own" on storage.objects $q$;
  execute $q$
    create policy "photos owner sees own" on storage.objects
      for select to authenticated
      using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text)
  $q$;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('24_photos.sql', '47f14362b094dfdfe7f59a054aedb705d0b2bc4fd310b131bcb7afa8986d0ce1');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('24_photos.sql');
  end if;
end $$;
