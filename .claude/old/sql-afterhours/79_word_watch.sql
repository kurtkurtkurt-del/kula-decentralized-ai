-- afterhours — words the staff want to see (79)
--
-- Nothing looked at what people wrote until someone reported it (F21, 20.10.2026;
-- Apple 1.2 asks for a filtering method). Decided: watch, do not refuse. A short
-- three-language list of words lives in watch_words; whenever a comment, a post, a
-- room line, a group message, a DM, a group name, a spark or a profile is written or
-- edited and holds one of them, it lands in the open reports as if its own author had
-- reported it, reason "filter: <word>". It stays visible; the staff decide in the
-- panel as with any report. The list grows and shrinks by admin calls.
--
--   watch_hit(text)                the first watched word in it, or null
--   watch_add(word) / watch_drop   admin
--   watch_list()                   staff

create table if not exists public.watch_words (
  word      text primary key check (word = lower(btrim(word)) and length(word) between 2 and 40),
  added_at  timestamptz not null default now()
);
alter table public.watch_words enable row level security;
revoke all on public.watch_words from public, anon, authenticated;

insert into public.watch_words (word) values
  ('nigger'), ('nigga'), ('faggot'), ('fag'), ('retard'), ('kike'), ('spic'), ('chink'), ('tranny'), ('whore'), ('slut'), ('cunt'), ('rape'), ('kill yourself'), ('kys'),
  ('kanake'), ('kanacke'), ('neger'), ('schwuchtel'), ('fotze'), ('hure'), ('schlampe'), ('judensau'), ('bring dich um'),
  ('orospu'), ('ibne'), ('pezevenk'), ('amcık'), ('amcik'), ('siktir'), ('sikerim'), ('göt'), ('piç'), ('pic kurusu'), ('geber'), ('kendini öldür')
on conflict do nothing;

create or replace function public.watch_hit(p_text text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select w.word from public.watch_words w
  where p_text is not null
    and lower(p_text) ~ ('(^|[^[:alnum:]])' || regexp_replace(w.word, '([.*+?^${}()|\[\]\\])', '\\\1', 'g') || '($|[^[:alnum:]])')
  order by length(w.word) desc
  limit 1;
$$;
grant execute on function public.watch_hit(text) to authenticated;

create or replace function public.watch_add(p_word text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(public.is_admin(), false) then raise exception 'admin only' using errcode = '42501'; end if;
  insert into public.watch_words (word) values (lower(btrim(p_word))) on conflict do nothing;
end;
$$;
create or replace function public.watch_drop(p_word text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not coalesce(public.is_admin(), false) then raise exception 'admin only' using errcode = '42501'; end if;
  delete from public.watch_words where word = lower(btrim(p_word));
end;
$$;
create or replace function public.watch_list()
returns setof text
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  return query select w.word from public.watch_words w order by w.word;
end;
$$;
grant execute on function public.watch_add(text), public.watch_drop(text), public.watch_list() to authenticated;

-- One trigger body for every table: args are the report kind, the author column,
-- then the text columns. A post goes to post_reports, everything else to reports.
create or replace function public.watch_ugc()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  j     jsonb := to_jsonb(new);
  body  text := '';
  i     int;
  hit   text;
  who   uuid;
begin
  for i in 2 .. tg_nargs - 1 loop
    body := body || ' ' || coalesce(j ->> tg_argv[i], '');
  end loop;
  hit := public.watch_hit(body);
  if hit is null then return new; end if;
  who := (j ->> tg_argv[1])::uuid;
  if tg_argv[0] = 'post' then
    insert into public.post_reports (post_id, reporter_id, reason) values (new.id, who, 'filter: ' || hit)
    on conflict do nothing;
  else
    insert into public.reports (reporter_id, kind, target, reason) values (who, tg_argv[0], new.id::text, 'filter: ' || hit)
    on conflict do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists watch_comments       on public.comments;
drop trigger if exists watch_post_comments  on public.post_comments;
drop trigger if exists watch_room_posts     on public.room_posts;
drop trigger if exists watch_group_messages on public.group_messages;
drop trigger if exists watch_dm_messages    on public.dm_messages;
drop trigger if exists watch_groups         on public.groups;
drop trigger if exists watch_sparks         on public.sparks;
drop trigger if exists watch_posts          on public.posts;
drop trigger if exists watch_profiles       on public.profiles;
create trigger watch_comments       after insert or update of body  on public.comments       for each row execute function public.watch_ugc('comment', 'author_id', 'body');
create trigger watch_post_comments  after insert or update of body  on public.post_comments  for each row execute function public.watch_ugc('post_comment', 'author_id', 'body');
create trigger watch_room_posts     after insert or update of body  on public.room_posts     for each row execute function public.watch_ugc('room_post', 'user_id', 'body');
create trigger watch_group_messages after insert or update of body  on public.group_messages for each row execute function public.watch_ugc('group_message', 'user_id', 'body');
create trigger watch_dm_messages    after insert or update of body  on public.dm_messages    for each row execute function public.watch_ugc('dm_message', 'user_id', 'body');
create trigger watch_groups         after insert or update of name  on public.groups         for each row execute function public.watch_ugc('group', 'created_by', 'name');
create trigger watch_sparks         after insert or update of title, place on public.sparks  for each row execute function public.watch_ugc('spark', 'host_id', 'title', 'place');
create trigger watch_posts          after insert or update of body  on public.posts          for each row execute function public.watch_ugc('post', 'author_id', 'body');
create trigger watch_profiles       after insert or update of handle, display_name, bio, about on public.profiles for each row execute function public.watch_ugc('profile', 'id', 'handle', 'display_name', 'bio', 'about');

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('79_word_watch.sql', '3a484dd375b17d135f53c7eb72bbd97bb12469d790015c60347746d280e4fec7');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('79_word_watch.sql');
  end if;
end $$;
