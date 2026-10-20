-- afterhours — the poster store (Supabase Storage)
-- The storage schema only exists on Supabase; in the local tests this
-- block skips itself. That is why every statement is dynamic (execute).

do $$
begin
  if not exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    raise notice 'no storage schema - poster store skipped (running locally)';
    return;
  end if;

  -- A public bucket: the posters are already on the site, nothing secret.
  execute $q$
    insert into storage.buckets (id, name, public)
    values ('posters', 'posters', true)
    on conflict (id) do nothing
  $q$;

  -- Reading is open to everyone
  execute $q$ drop policy if exists "posters okunur" on storage.objects $q$;
  execute $q$
    create policy "posters okunur" on storage.objects
      for select using (bucket_id = 'posters')
  $q$;

  -- Writing belongs to the admin alone. public.is_admin() is defined in 02_rls.sql.
  execute $q$ drop policy if exists "posters yonetici yazar" on storage.objects $q$;
  execute $q$ drop policy if exists "posters admin writes" on storage.objects $q$;
  execute $q$
    create policy "posters admin writes" on storage.objects
      for insert with check (bucket_id = 'posters' and public.is_admin())
  $q$;

  execute $q$ drop policy if exists "posters yonetici gunceller" on storage.objects $q$;
  execute $q$ drop policy if exists "posters admin updates" on storage.objects $q$;
  execute $q$
    create policy "posters admin updates" on storage.objects
      for update using (bucket_id = 'posters' and public.is_admin())
      with check (bucket_id = 'posters' and public.is_admin())
  $q$;

  execute $q$ drop policy if exists "posters yonetici siler" on storage.objects $q$;
  execute $q$ drop policy if exists "posters admin deletes" on storage.objects $q$;
  execute $q$
    create policy "posters admin deletes" on storage.objects
      for delete using (bucket_id = 'posters' and public.is_admin())
  $q$;
end
$$;

-- Stamp the migration log, if it is there. Each numbered file still runs on
-- its own (the tests load them one at a time), so this cannot insist.
do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('08_storage.sql', 'dc9cf4d0234f2ff473ff628d13258e2a8c05d14d0d690b063523cf2c600b31c9');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('08_storage.sql');
  end if;
end $$;
