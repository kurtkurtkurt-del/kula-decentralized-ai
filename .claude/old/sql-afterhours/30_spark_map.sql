-- afterhours — sparks on the map
-- A spark now has a spot: where the host was when they created it (the app
-- sends its position). The map shows the sparks you are allowed to see as
-- their own kind of mark, and a tap opens the spark like a night.
--
--   spark_create(…, reach, lat, lng)   27/28 create plus the spot
--   sparks_near(lat, lng, km)          the sparks around a point that you can see
--   spark_get(spark)                   one spark, for its page
--
-- Who can see a spark: its host, the people ticked by name (27), and everyone
-- inside its wave (28). A spot is often a home, so it is blurred for people who
-- are not the host or a confirmed friend of the host: rounded to two decimals,
-- about a kilometre.

alter table public.sparks add column if not exists lat double precision;
alter table public.sparks add column if not exists lng double precision;
alter table public.sparks drop constraint if exists sparks_spot;
alter table public.sparks add constraint sparks_spot check (
  (lat is null and lng is null)
  or (lat between -90 and 90 and lng between -180 and 180)
);
create index if not exists sparks_spot_idx on public.sparks (lat, lng) where lat is not null;

-- --------------------------------------------------------------- create

drop function if exists public.spark_create(text, text, timestamptz, text, int, double precision, double precision);
create or replace function public.spark_create(
  p_kind      text,
  p_title     text,
  p_starts_at timestamptz,
  p_place     text,
  p_reach     int,
  p_lat       double precision,
  p_lng       double precision
)
returns uuid
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  new_id uuid;
begin
  new_id := public.spark_create(p_kind, p_title, p_starts_at, p_place, p_reach);
  if p_lat is not null and p_lng is not null then
    update public.sparks set lat = p_lat, lng = p_lng where id = new_id;
  end if;
  return new_id;
end;
$$;

-- ----------------------------------------------------------------- read

-- Every spark you can see that has not ended, with your answer and the spot
-- (blurred unless you are the host or a friend of the host).
create or replace function public.spark_rows()
returns table (
  id          uuid,
  kind        text,
  title       text,
  starts_at   timestamptz,
  place       text,
  host_handle text,
  host_name   text,
  going       int,
  wave        int,
  mine        boolean,
  my_answer   text,
  lat         double precision,
  lng         double precision
)
language sql
stable
security definer
set search_path = public
as $$
  with near as (select person, hops from public.spark_waves(auth.uid()))
  select s.id, s.kind, s.title, s.starts_at, s.place, p.handle, p.display_name,
         (select count(*)::int from public.spark_invites g where g.spark_id = s.id and g.answer = 'in'),
         n.hops,
         s.host_id = auth.uid(),
         i.answer,
         case when s.host_id = auth.uid() or n.hops = 1 then s.lat else round(s.lat::numeric, 2)::double precision end,
         case when s.host_id = auth.uid() or n.hops = 1 then s.lng else round(s.lng::numeric, 2)::double precision end
  from public.sparks s
  join public.profiles p on p.id = s.host_id
  left join near n on n.person = s.host_id
  left join public.spark_invites i on i.spark_id = s.id and i.user_id = auth.uid()
  where auth.uid() is not null
    and s.starts_at > now() - interval '6 hours'
    and (s.host_id = auth.uid()
         or i.user_id is not null
         or (s.reach is not null and n.hops <= s.reach));
$$;
revoke execute on function public.spark_rows() from public, anon, authenticated;

drop function if exists public.sparks_near(double precision, double precision, double precision);
create or replace function public.sparks_near(p_lat double precision, p_lng double precision, p_km double precision default 3)
returns table (
  id          uuid,
  kind        text,
  title       text,
  starts_at   timestamptz,
  place       text,
  host_handle text,
  host_name   text,
  going       int,
  wave        int,
  mine        boolean,
  my_answer   text,
  lat         double precision,
  lng         double precision,
  distance_km double precision
)
language sql
stable
security definer
set search_path = public
as $$
  select * from (
    select r.*,
           2 * 6371.0 * asin(sqrt(
             power(sin(radians(r.lat - p_lat) / 2), 2)
             + cos(radians(p_lat)) * cos(radians(r.lat))
             * power(sin(radians(r.lng - p_lng) / 2), 2))) as distance_km
    from public.spark_rows() r
    where r.lat is not null
  ) x
  where x.distance_km <= least(greatest(coalesce(p_km, 3), 0.1), 60)
  order by x.distance_km
  limit 100;
$$;

drop function if exists public.spark_get(uuid);
create or replace function public.spark_get(p_spark uuid)
returns table (
  id          uuid,
  kind        text,
  title       text,
  starts_at   timestamptz,
  place       text,
  host_handle text,
  host_name   text,
  going       int,
  wave        int,
  mine        boolean,
  my_answer   text,
  lat         double precision,
  lng         double precision
)
language sql
stable
security definer
set search_path = public
as $$
  select * from public.spark_rows() r where r.id = p_spark;
$$;

revoke execute on function public.spark_create(text, text, timestamptz, text, int, double precision, double precision) from public, anon;
revoke execute on function public.sparks_near(double precision, double precision, double precision)                   from public, anon;
revoke execute on function public.spark_get(uuid)                                                                      from public, anon;
grant execute on function public.spark_create(text, text, timestamptz, text, int, double precision, double precision)  to authenticated;
grant execute on function public.sparks_near(double precision, double precision, double precision)                    to authenticated;
grant execute on function public.spark_get(uuid)                                                                       to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('30_spark_map.sql', 'bd78b55bbfa774153349f89e8f3918e726f53e1b223c17d24b9d93387f42e601');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('30_spark_map.sql');
  end if;
end $$;
