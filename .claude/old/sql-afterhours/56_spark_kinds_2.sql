-- afterhours — twenty more sparks (56, after 39)
--
-- The app has thirty-one sparks since 11.10.2026 (app/src/content/sparks.ts).
-- The table takes them here; nothing else changes — a kind is a word the app
-- turns into a photo and a text.
--
--   karaoke · vinyl · openair · bike · cinema · boardgames · flea · skate · cook · sauna
--   openmic · pingpong · bouldering · picnic · crawl · stars · football · tram · jazz · walk

alter table public.sparks drop constraint if exists sparks_kind_check;
alter table public.sparks add constraint sparks_kind_check check (kind in (
  'derby', 'grill', 'hike',
  'sunrise', 'breakfast', 'rooftop', 'swim', 'quiz', 'newplace', 'camera', 'festival',
  'karaoke', 'vinyl', 'openair', 'bike', 'cinema',
  'boardgames', 'flea', 'skate', 'cook', 'sauna',
  'openmic', 'pingpong', 'bouldering', 'picnic', 'crawl',
  'stars', 'football', 'tram', 'jazz', 'walk'
));

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('56_spark_kinds_2.sql', 'dd7519b93add7f83e1a2c2fb291940ec62e8fb8c85b2ad1417adeac7db5729d2');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('56_spark_kinds_2.sql');
  end if;
end $$;
