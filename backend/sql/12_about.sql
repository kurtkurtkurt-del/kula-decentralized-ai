-- pasaport — about the project: who runs it, and what the model says
--   project_about     a few lines about the institution or person behind a project, per
--                     language (en · de · tr): a kicker, the text, facts, a source link
--   project_samples   three lines of what the model answers, per language: the "sample"
--                     card on the deck (not thirty seconds of sound: three lines of text)
--   about_for(ids, lang)    the texts for the projects in a deck (the language asked, else en)
--   samples_for(ids, lang)  the samples for the projects in a deck
--   staff_about_set / staff_samples_set   the panel writes them
-- Anyone may read them: they are the project's own words, nothing about a person.

create table if not exists public.project_about (
  project_id  uuid not null references public.projects on delete cascade,
  lang        text not null check (lang in ('en', 'de', 'tr')),
  kicker      text,
  who         text not null check (length(who) <= 1200),
  facts       text[] not null default '{}',
  source_url  text,
  updated_at  timestamptz not null default now(),
  primary key (project_id, lang)
);
create table if not exists public.project_samples (
  project_id  uuid not null references public.projects on delete cascade,
  lang        text not null check (lang in ('en', 'de', 'tr')),
  prompt      text not null check (length(prompt) <= 200),
  lines       text[] not null check (cardinality(lines) between 1 and 3),
  updated_at  timestamptz not null default now(),
  primary key (project_id, lang)
);
alter table public.project_about enable row level security;
alter table public.project_samples enable row level security;
revoke all on public.project_about, public.project_samples from public, anon, authenticated;

drop function if exists public.about_for(uuid[], text);
create or replace function public.about_for(p_projects uuid[], p_lang text default 'en')
returns table (project_id uuid, lang text, kicker text, who text, facts text[], source_url text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (a.project_id) a.project_id, a.lang, a.kicker, a.who, a.facts, a.source_url
  from public.project_about a
  where a.project_id = any (p_projects) and a.lang in (coalesce(p_lang, 'en'), 'en')
  order by a.project_id, (a.lang = coalesce(p_lang, 'en')) desc;
$$;
drop function if exists public.samples_for(uuid[], text);
create or replace function public.samples_for(p_projects uuid[], p_lang text default 'en')
returns table (project_id uuid, lang text, prompt text, lines text[])
language sql
stable
security definer
set search_path = public
as $$
  select distinct on (s.project_id) s.project_id, s.lang, s.prompt, s.lines
  from public.project_samples s
  where s.project_id = any (p_projects) and s.lang in (coalesce(p_lang, 'en'), 'en')
  order by s.project_id, (s.lang = coalesce(p_lang, 'en')) desc;
$$;
grant execute on function public.about_for(uuid[], text), public.samples_for(uuid[], text) to anon, authenticated;

create or replace function public.staff_about_set(p_slug text, p_lang text, p_kicker text, p_who text, p_facts text[], p_source_url text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  pid uuid;
begin
  perform public.need_admin();
  select id into pid from public.projects where slug = p_slug;
  if pid is null then raise exception 'no such project'; end if;
  insert into public.project_about (project_id, lang, kicker, who, facts, source_url) values (pid, p_lang, p_kicker, p_who, coalesce(p_facts, '{}'), p_source_url)
  on conflict (project_id, lang) do update set kicker = excluded.kicker, who = excluded.who, facts = excluded.facts, source_url = excluded.source_url, updated_at = now();
end;
$$;
create or replace function public.staff_samples_set(p_slug text, p_lang text, p_prompt text, p_lines text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  pid uuid;
begin
  perform public.need_admin();
  select id into pid from public.projects where slug = p_slug;
  if pid is null then raise exception 'no such project'; end if;
  insert into public.project_samples (project_id, lang, prompt, lines) values (pid, p_lang, p_prompt, p_lines)
  on conflict (project_id, lang) do update set prompt = excluded.prompt, lines = excluded.lines, updated_at = now();
end;
$$;
revoke execute on function public.staff_about_set(text, text, text, text, text[], text), public.staff_samples_set(text, text, text, text[]) from public, anon;
grant execute on function public.staff_about_set(text, text, text, text, text[], text), public.staff_samples_set(text, text, text, text[]) to authenticated;

-- The panel: projects are entered by hand (no sync). Save makes or changes one by slug.
create or replace function public.staff_project_save(p_slug text, p_title text, p_summary text, p_model text, p_params_b numeric,
  p_nights int, p_phones int, p_org text, p_city text, p_status text default 'open', p_image_url text default null, p_poster_no int default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  cid uuid;
  s text := btrim(regexp_replace(lower(btrim(coalesce(p_slug, ''))), '[^a-z0-9]+', '-', 'g'), '-');
begin
  perform public.need_admin();
  if s !~ '^[a-z0-9-]{3,60}$' then raise exception 'slug: letters, digits, dashes'; end if;
  if p_city is not null then
    select id into cid from public.cities where cities.slug = p_city;
    if cid is null then raise exception 'unknown city'; end if;
  end if;
  insert into public.projects (slug, title, summary, model, params_b, nights_wanted, phones_wanted, est_kwh, est_eur, org, city_id, status, image_url, poster_no)
  values (s, btrim(p_title), btrim(p_summary), p_model, p_params_b, p_nights, p_phones,
          round(p_phones * p_nights * 4 * 8.5 / 1000.0, 2), round(p_phones * p_nights * 4 * 8.5 / 1000.0 * 0.30, 2),
          btrim(p_org), cid, coalesce(p_status, 'open'), p_image_url, p_poster_no)
  on conflict (slug) do update set title = excluded.title, summary = excluded.summary, model = excluded.model, params_b = excluded.params_b,
    nights_wanted = excluded.nights_wanted, phones_wanted = excluded.phones_wanted, est_kwh = excluded.est_kwh, est_eur = excluded.est_eur,
    org = excluded.org, city_id = excluded.city_id, status = excluded.status, image_url = excluded.image_url, poster_no = excluded.poster_no;
  return s;
end;
$$;
create or replace function public.staff_project_delete(p_slug text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_admin();
  -- a project with nights keeps its cards: it is retired, not deleted
  if exists (select 1 from public.contributions k join public.projects r on r.id = k.project_id where r.slug = p_slug and k.card_no is not null) then
    update public.projects set status = 'done', is_published = false where slug = p_slug;
  else
    delete from public.projects where slug = p_slug;
  end if;
end;
$$;
drop function if exists public.staff_projects();
create or replace function public.staff_projects()
returns table (slug text, title text, model text, status text, is_published boolean, city_slug text, phones_in int, nights_done int, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_admin();
  return query
  select r.slug, r.title, r.model, r.status, r.is_published, c.slug,
         (select count(*)::int from public.joins j where j.project_id = r.id and j.direction = 'right'),
         (select count(*)::int from public.contributions k where k.project_id = r.id and k.card_no is not null), r.created_at
  from public.projects r left join public.cities c on c.id = r.city_id order by r.created_at desc;
end;
$$;
revoke execute on function public.staff_project_save(text, text, text, text, numeric, int, int, text, text, text, text, int), public.staff_project_delete(text), public.staff_projects() from public, anon;
grant execute on function public.staff_project_save(text, text, text, text, numeric, int, int, text, text, text, text, int), public.staff_project_delete(text), public.staff_projects() to authenticated;

-- the seed's words: one about and one sample per project, in English (the panel adds de · tr)
insert into public.project_about (project_id, lang, kicker, who, facts, source_url)
select r.id, 'en', v.kicker, v.who, v.facts, null from (values
  ('koy-okulu-ogretmen', 'a teachers'' association in van', 'Twelve teachers in the villages around Van who kept lessons going through the winters without a connection. They write the questions, check the answers, and carry the tablets.', array['founded 2019', '38 schools', 'runs on ten-year-old tablets']),
  ('afet-mesaj-siniflandirma', 'volunteers of a search and rescue association', 'The people who read the messages in February 2023, by hand, for days. They want the first hour back.', array['messages anonymised', 'trained offline', 'open weights after']),
  ('deprem-sonrasi-ceviri', 'translators without borders', 'A network of volunteer translators that worked the phones after the earthquake. The model is for the days when no server is up.', array['tr · ar · ku', 'runs on the phone', 'no network needed']),
  ('yerel-tarih-arsivi', 'the city archive of istanbul', 'The archive holds forty years of scanned newspapers nobody can search. The summaries become the catalogue.', array['1980 – 2020', '140 000 pages', 'summaries reviewed by archivists']),
  ('turkce-ders-asistani', 'a network of teachers', 'Teachers from state schools who write and check the lesson answers in their evenings.', array['open curriculum', 'grades 5 to 8', 'checked by teachers']),
  ('isaret-dili-altyazi', 'the federation of the hearing impaired', 'The federation collects the signed sentences; its members check the captions.', array['turkish sign language', 'camera on the phone', 'captions, not voice']),
  ('behoerdenbrief', 'an association for plain language', 'Volunteers who have rewritten letters from offices for twenty years, by hand. The letter never leaves the phone.', array['de · tr · ar · uk', 'letters anonymised', 'berlin, since 2004']),
  ('pflege-nachtassistent', 'care companions in munich', 'A group of carers and nurses who answer the phone at night for families. They want the answers on the phone, in every language.', array['guidelines of the pflegekasse', 'tr · de · en', 'munich']),
  ('stadtarchiv-ocr', 'friends of the hamburg state archive', 'Volunteers who read handwriting. The phones learn from their corrections.', array['1850 – 1950', 'registers and letters', 'corrections by volunteers']),
  ('jobcenter-dolmetscher', 'a migrant women''s network in cologne', 'Women who have interpreted at the jobcenter for each other for years. The model is for when nobody is free to come along.', array['de · tr · fa', 'spoken, on the phone', 'cologne'])
) as v(slug, kicker, who, facts) join public.projects r on r.slug = v.slug
on conflict (project_id, lang) do nothing;

insert into public.project_samples (project_id, lang, prompt, lines)
select r.id, 'en', v.prompt, v.lines from (values
  ('koy-okulu-ogretmen', 'why does the moon change shape?', array['The moon does not change; what changes is how much of its lit side we see.', 'As it goes around the earth, the sun lights it from different angles.', 'Try it: a ball, a lamp, and walk around the lamp.']),
  ('afet-mesaj-siniflandirma', '"we are on the 3rd floor, the stairs are gone, my mother cannot walk"', array['category: trapped · priority: high', 'floor: 3 · mobility: limited', 'needs: rescue team, stretcher']),
  ('deprem-sonrasi-ceviri', 'su var mı? → arabic', array['هل يوجد ماء؟', '(hal yujad maa?)', 'also: "is there water?"']),
  ('yerel-tarih-arsivi', 'summarise: kadıköy council minutes, march 1994', array['The council approved the new ferry pier and postponed the market move.', 'Three members objected to the parking plan on Bahariye.', 'Keywords: ferry, pier, market, parking.']),
  ('turkce-ders-asistani', 'özne ile yüklem arasındaki fark ne?', array['Özne işi yapandır, yüklem yapılan iştir.', '"Ali koştu": Ali özne, koştu yüklem.', 'Sen bir cümle söyle, birlikte bulalım.']),
  ('isaret-dili-altyazi', '[signed: where is the pharmacy]', array['caption: where is the pharmacy?', 'confidence: 0.91', 'reply suggestion: two streets down, on the left']),
  ('behoerdenbrief', 'brief vom jobcenter, 2 seiten, "mitwirkungspflicht"', array['Sie müssen bis zum 14. März Unterlagen schicken.', 'Welche: Kontoauszüge der letzten 3 Monate.', 'Wenn nicht: das Geld kann weniger werden.']),
  ('pflege-nachtassistent', 'annem gece uyanıyor ve evi tanımıyor, ne yapmalıyım?', array['Sakin kalın, ışığı açın, adıyla seslenin.', 'Nerede olduğunu kısa cümlelerle söyleyin.', 'Sabah hekime bildirin: bu bir uyku bozukluğu olabilir.']),
  ('stadtarchiv-ocr', '[handwritten register, 1887]', array['Carl Friedrich Lüders, Schiffszimmermann, geb. 12. Mai 1861', 'wohnhaft Steinstraße 14', 'confidence: 0.84 (surname corrected by a volunteer)']),
  ('jobcenter-dolmetscher', '"Haben Sie die Bewerbungen mitgebracht?" → turkish', array['Başvuruları getirdiniz mi?', '(spoken, 1.2 s)', 'reply: evet, işte buradalar → ja, hier sind sie'])
) as v(slug, prompt, lines) join public.projects r on r.slug = v.slug
on conflict (project_id, lang) do nothing;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('12_about.sql', 'e790b8068d4ee661f020c21eac5efda819239dd2ba44ef5947d74d00a8c0b168');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('12_about.sql');
  end if;
end $$;
