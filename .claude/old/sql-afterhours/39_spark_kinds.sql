-- afterhours — eight more sparks (39)
--
-- The app has eleven sparks now (app/src/content/sparks.ts). The table only
-- took the first three: this widens the list. Nothing else changes; a kind
-- is just a word the app turns into a photo and a text.
--
--   sunrise · breakfast · rooftop · swim · quiz · newplace · camera · festival

alter table public.sparks drop constraint if exists sparks_kind_check;
alter table public.sparks add constraint sparks_kind_check check (kind in (
  'derby', 'grill', 'hike',
  'sunrise', 'breakfast', 'rooftop', 'swim', 'quiz', 'newplace', 'camera', 'festival'
));

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('39_spark_kinds.sql', 'b88ef1a1bd7de9f0c23bb2dfc0308ad085af09b40145bd109a347621933ecf92');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('39_spark_kinds.sql');
  end if;
end $$;
