-- afterhours — the sound store
--
-- The background music leaves the app package (14 MB) and streams from a
-- public bucket: sound/<genre>/NN.m4a. Everyone reads; the files are put
-- there once with the service key (backend/tools/upload-sound.mjs).
-- Supabase only: skipped elsewhere, like the poster store.

do $$
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    raise notice 'no storage schema - sound store skipped (running locally)';
    return;
  end if;
  execute $q$
    insert into storage.buckets (id, name, public)
    values ('sound', 'sound', true)
    on conflict (id) do nothing
  $q$;
  execute $q$ drop policy if exists "sound is read by everyone" on storage.objects $q$;
  execute $q$
    create policy "sound is read by everyone" on storage.objects
      for select using (bucket_id = 'sound')
  $q$;
  execute $q$ drop policy if exists "sound admin writes" on storage.objects $q$;
  execute $q$
    create policy "sound admin writes" on storage.objects
      for insert with check (bucket_id = 'sound' and public.is_admin())
  $q$;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('21_sound.sql', 'c58aeea48ea9d4e75ffee9a89e9009c82ec28c255a35f018b7ab1c8089f610b8');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('21_sound.sql');
  end if;
end $$;
