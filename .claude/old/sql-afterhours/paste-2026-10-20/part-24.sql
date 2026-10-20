-- paste 24/24: previews-berlin
insert into public.event_previews (event_id, track, artist, preview_url, link, source)
select e.id, v.track, v.artist, v.url, v.link, 'apple'
from (values
  ('don-toliver-nitrous-octane-world-tour-leg-2-242ba9f2', 'Lose My Mind (feat. Doja Cat)', 'Don Toliver', 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview211/v4/dc/8a/52/dc8a52e0-2c48-6ee0-c8f0-7b7188924f83/mzaf_10698934003919409505.plus.aac.p.m4a', 'https://music.apple.com/de/album/lose-my-mind-feat-doja-cat/1810796698?i=1810796700&uo=4')
) as v(slug, track, artist, url, link)
join public.events e on e.slug = v.slug
on conflict (event_id) do update
  set track = excluded.track, artist = excluded.artist, preview_url = excluded.preview_url, link = excluded.link, source = excluded.source, made_at = now();
