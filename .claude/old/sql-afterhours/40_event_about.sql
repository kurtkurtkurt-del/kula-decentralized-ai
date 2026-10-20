-- afterhours — "who is this?": a few lines about the act on a night (40)
--
-- A night card can carry a short text about who is playing: what they are, two or
-- three sentences, two facts, and where it comes from. The texts are written ahead
-- of time (from a source such as Wikipedia, summarised; never invented) and stored
-- here per night and language. A night without a row simply has no "who is this?".
--
--   event_about        one row per night and language (en · de · tr)
--   about_for(ids, lang)   the rows for these nights, in that language
--
-- Anyone may read them (they are about public nights). Only the service role
-- writes: the texts come from the sync job or from a reviewed SQL file.

create table if not exists public.event_about (
  event_id    uuid not null references public.events on delete cascade,
  lang        text not null check (lang in ('en', 'de', 'tr')),
  name        text not null,
  kicker      text not null,
  who         text,
  facts       text[] not null default '{}',
  source_url  text not null check (source_url ~ '^https://'),
  made_at     timestamptz not null default now(),
  primary key (event_id, lang)
);

alter table public.event_about enable row level security;
revoke all on public.event_about from public, anon, authenticated;

drop function if exists public.about_for(uuid[], text);
create or replace function public.about_for(p_events uuid[], p_lang text)
returns table (event_id uuid, name text, kicker text, who text, facts text[], source_url text)
language sql
stable
security definer
set search_path = public
as $$
  select a.event_id, a.name, a.kicker, a.who, a.facts, a.source_url
  from public.event_about a
  join public.events e on e.id = a.event_id and e.is_published
  where a.event_id = any(p_events)
    and a.lang = case when p_lang in ('en', 'de', 'tr') then p_lang else 'en' end;
$$;

grant execute on function public.about_for(uuid[], text) to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('40_event_about.sql', '82ae672f8c140a23ae9f8e62042e3d06125789c1f39b675e3c4804564289ffe6');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('40_event_about.sql');
  end if;
end $$;
