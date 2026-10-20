-- fix 92: re-stamps 92 with its new text. The one-time move is skipped (92 already ran); no start time changes.
alter table public.cities add column if not exists tz text not null default 'Europe/Berlin';
update public.cities set tz = case country_slug
    when 'de' then 'Europe/Berlin'
    when 'at' then 'Europe/Vienna'
    when 'ch' then 'Europe/Zurich'
    when 'nl' then 'Europe/Amsterdam'
    when 'be' then 'Europe/Brussels'
    when 'fr' then 'Europe/Paris'
    when 'es' then 'Europe/Madrid'
    when 'it' then 'Europe/Rome'
    when 'pl' then 'Europe/Warsaw'
    when 'cz' then 'Europe/Prague'
    when 'hu' then 'Europe/Budapest'
    when 'dk' then 'Europe/Copenhagen'
    when 'se' then 'Europe/Stockholm'
    when 'no' then 'Europe/Oslo'
    when 'fi' then 'Europe/Helsinki'
    when 'gr' then 'Europe/Athens'
    when 'tr' then 'Europe/Istanbul'
    when 'gb' then 'Europe/London'
    when 'ie' then 'Europe/Dublin'
    when 'pt' then 'Europe/Lisbon'
    when 'ae' then 'Asia/Dubai'
    when 'hk' then 'Asia/Hong_Kong'
    when 'sg' then 'Asia/Singapore'
    when 'jp' then 'Asia/Tokyo'
    when 'kr' then 'Asia/Seoul'
    when 'tw' then 'Asia/Taipei'
    when 'id' then 'Asia/Jakarta'
    when 'au' then 'Australia/Sydney'
    when 'nz' then 'Pacific/Auckland'
    when 'fj' then 'Pacific/Fiji'
    when 'ke' then 'Africa/Nairobi'
    when 'ma' then 'Africa/Casablanca'
    when 'ng' then 'Africa/Lagos'
    else 'Europe/Berlin' end;

alter table public.events add column if not exists tz text;

do $$ begin
  if not exists (select 1 from public.migrations where name = '92_timezones.sql') then
    update public.events e
       set starts_at = ((e.starts_at at time zone 'UTC') at time zone c.tz)
      from public.cities c
     where c.id = e.city_id and e.source = 'ticketmaster' and e.starts_at is not null and e.tz is null
       and substring(e.date_text from '([0-9]{2}:[0-9]{2})') is not null
       and to_char(e.starts_at at time zone 'UTC', 'HH24:MI') = substring(e.date_text from '([0-9]{2}:[0-9]{2})')
       and to_char(e.starts_at at time zone c.tz, 'HH24:MI') <> substring(e.date_text from '([0-9]{2}:[0-9]{2})');
    update public.events e set tz = c.tz
      from public.cities c
     where c.id = e.city_id and e.source = 'ticketmaster' and e.tz is null;
  end if;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('92_timezones.sql', 'bb1f5f9b344cce65c9f9b6c0f4a0680a7d768a0160d4116bc1aa66b611e3d676');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('92_timezones.sql');
  end if;
end $$;
