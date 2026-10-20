-- pasaport — ten projects, hand-entered (no sync; the panel adds more)
-- Türkiye and Germany. Each one: a small model a phone can carry at night, a number
-- of nights, a number of phones, the energy it will take. The numbers are estimates:
-- 4 W per phone per night-hour (the simulated worker uses the same figure), 8.5 h a
-- night, 0.30 € per kWh. Idempotent: a second paste changes nothing (on conflict).

insert into public.cities (slug, name, country, lat, lng, sort_order) values
  ('istanbul', 'istanbul', 'tr', 41.0082, 28.9784, 1),
  ('ankara',   'ankara',   'tr', 39.9334, 32.8597, 2),
  ('izmir',    'izmir',    'tr', 38.4237, 27.1428, 3),
  ('hatay',    'hatay',    'tr', 36.2023, 36.1603, 4),
  ('van',      'van',      'tr', 38.4891, 43.4089, 5),
  ('munchen',  'münchen',  'de', 48.1351, 11.5820, 6),
  ('berlin',   'berlin',   'de', 52.5200, 13.4050, 7),
  ('hamburg',  'hamburg',  'de', 53.5511,  9.9937, 8),
  ('koln',     'köln',     'de', 50.9375,  6.9603, 9),
  ('leipzig',  'leipzig',  'de', 51.3397, 12.3731, 10)
on conflict (slug) do nothing;

insert into public.projects (slug, title, summary, model, params_b, nights_wanted, phones_wanted, est_kwh, est_eur, org, city_id, poster_no)
select v.slug, v.title, v.summary, v.model, v.params_b, v.nights, v.phones,
       round(v.phones * v.nights * 4 * 8.5 / 1000.0, 2),
       round(v.phones * v.nights * 4 * 8.5 / 1000.0 * 0.30, 2),
       v.org, c.id, v.poster
from (values
  ('koy-okulu-ogretmen', 'offline teacher for village schools',
   'A Turkish lesson assistant that runs with no internet, for primary schools in villages without a steady connection. Phones at night distil a 3B model into one small enough for a ten-year-old tablet.',
   '3B Q4', 3.0, 12, 400, 'köy okulları derneği', 'van', 1),
  ('afet-mesaj-siniflandirma', 'disaster message sorting',
   'Reads the flood of messages after an earthquake and sorts them: trapped, injured, needs water, safe. Trained on the messages of February 2023, anonymised, so the next time the first hour is not lost.',
   '1B Q4', 1.0, 8, 800, 'akut gönüllüleri', 'hatay', 2),
  ('deprem-sonrasi-ceviri', 'after the earthquake: translation',
   'Turkish ↔ Arabic ↔ Kurdish for rescue teams and families in the first days, when no server is up. A 4B model made to fit on the phones that are already in the ruins.',
   '4B Q4', 4.0, 10, 600, 'sınır tanımayan çevirmenler', 'hatay', 3),
  ('yerel-tarih-arsivi', 'local history archive summaries',
   'Summarises forty years of scanned town newspapers and council minutes into readable entries for the municipal archive. Istanbul first, then the towns that send their boxes.',
   '7B Q4', 7.0, 20, 300, 'istanbul kent arşivi', 'istanbul', 4),
  ('turkce-ders-asistani', 'turkish lesson assistant',
   'Answers a pupil''s question about the lesson in plain Turkish and asks one back, for the evenings when nobody at home can help. Built on the open curriculum, checked by teachers.',
   '3B Q4', 3.0, 14, 500, 'öğretmen ağı', 'ankara', 5),
  ('isaret-dili-altyazi', 'sign language captions',
   'Turns Turkish sign language on a phone camera into captions for the hearing side of a conversation. The night work is the hard part: aligning thousands of signed sentences.',
   '3B Q4', 3.0, 16, 350, 'işitme engelliler federasyonu', 'izmir', 6),
  ('behoerdenbrief', 'behördenbriefe, einfach',
   'Rewrites a letter from a German office into plain language, in German, Turkish, Arabic or Ukrainian, on the phone, without the letter leaving it. The phones at night tune the model on anonymised letters.',
   '3B Q4', 3.0, 10, 450, 'verein für einfache sprache e.v.', 'berlin', 7),
  ('pflege-nachtassistent', 'night assistant for carers',
   'For people who look after a parent at home: what to do at three in the morning, in their own language, with the guidelines of the Pflegekasse behind it. Trained on the open care handbooks.',
   '4B Q4', 4.0, 12, 400, 'pflegebegleiter münchen', 'munchen', 8),
  ('stadtarchiv-ocr', 'city archive, handwriting to text',
   'Reads the handwritten registers of the Hamburg city archive, 1850 to 1950, into searchable text. Volunteers correct, phones at night learn from the corrections.',
   '1B Q4', 1.0, 24, 700, 'staatsarchiv freunde hamburg', 'hamburg', 9),
  ('jobcenter-dolmetscher', 'interpreter for the jobcenter',
   'A spoken interpreter for appointments at the Jobcenter, German ↔ Turkish ↔ Farsi, that runs on the phone of the person being interviewed. The night work aligns the vocabulary of forms and offices.',
   '7B Q4', 7.0, 18, 300, 'migrantinnen netzwerk köln', 'koln', 10)
) as v(slug, title, summary, model, params_b, nights, phones, org, city, poster)
left join public.cities c on c.slug = v.city
on conflict (slug) do nothing;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('03_seed_projects.sql', 'b179bc9d98a1867d59599ec96603c39078ad4f7d9e3c1a2901097c6a48c0406f');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('03_seed_projects.sql');
  end if;
end $$;
