-- afterhours — a changed or cancelled night tells the people on it (72)
--
-- Ticketmaster says when a night is cancelled, postponed or rescheduled
-- (dates.status.code) and the sync never read it; a person with a ticket, a keep or
-- an answer on it found out at the door (F22, 20.10.2026). Now events carries the
-- status the sync writes; a cancelled night leaves the deck (is_published = false)
-- but stays in collections and feeds; and the people on the night get one push:
-- {title} · cancelled / postponed / moved to {when}. The words are three fixed
-- phrases per language (58); the switch is notify_nights, like night_soon.
--
-- push_text() and push_wants() are those of 58 and 59 with the one kind added.

alter table public.events add column if not exists status text not null default 'onsale';
alter table public.events drop constraint if exists events_status_check;
alter table public.events add constraint events_status_check
  check (status in ('onsale', 'offsale', 'cancelled', 'postponed', 'rescheduled'));

alter table public.push_outbox drop constraint if exists push_outbox_kind_check;
alter table public.push_outbox add constraint push_outbox_kind_check check (kind in (
  'friend_request', 'friend_accepted', 'match', 'friend_live',
  'night_soon', 'room_open', 'room_closing', 'room_message', 'reply',
  'digest', 'dj_live', 'wave', 'spark', 'spark_in',
  'group_added', 'group_joined', 'group_match', 'group_round', 'group_won', 'group_plan',
  'group_message', 'group_live', 'group_ticket', 'post',
  'staff', 'post_like', 'post_comment',
  'dm', 'night_changed'));

create or replace function public.push_text(p_kind text, p_lang text, p_data jsonb)
returns table (title text, body text)
language plpgsql
immutable
as $$
declare
  pair record;
begin
  select x.title, x.body into title, body
  from (values
    ('friend_request',  'en', 'friend request',                '{name} wants to add you'),
    ('friend_request',  'de', 'freundschaftsanfrage',          '{name} möchte dich hinzufügen'),
    ('friend_request',  'tr', 'arkadaşlık isteği',             '{name} seni eklemek istiyor'),
    ('friend_accepted', 'en', 'you are friends now',           '{name} accepted your request'),
    ('friend_accepted', 'de', 'ihr seid jetzt freunde',        '{name} hat deine anfrage angenommen'),
    ('friend_accepted', 'tr', 'artık arkadaşsınız',            '{name} isteğini kabul etti'),
    ('match',           'en', '{name} is going too',           '{title}'),
    ('match',           'de', '{name} geht auch hin',          '{title}'),
    ('match',           'tr', '{name} de gidiyor',             '{title}'),
    ('friend_live',     'en', '{name} is out now',             '{title}'),
    ('friend_live',     'de', '{name} ist gerade unterwegs',   '{title}'),
    ('friend_live',     'tr', '{name} şu an dışarıda',         '{title}'),
    ('night_soon',      'en', 'tonight · {time}',              '{title}'),
    ('night_soon',      'de', 'heute nacht · {time}',          '{title}'),
    ('night_soon',      'tr', 'bu gece · {time}',              '{title}'),
    ('room_open',       'en', 'your room is open',             '{title} · 48 hours to write'),
    ('room_open',       'de', 'dein raum ist offen',           '{title} · 48 stunden zum schreiben'),
    ('room_open',       'tr', 'odan açık',                     '{title} · 48 saat yazabilirsin'),
    ('room_closing',    'en', 'your room closes soon',         '{title} · the last two hours'),
    ('room_closing',    'de', 'dein raum schließt bald',       '{title} · die letzten zwei stunden'),
    ('room_closing',    'tr', 'odan birazdan kapanıyor',       '{title} · son iki saat'),
    ('room_message',    'en', '{name} in {title}',             'a new line in your room'),
    ('room_message',    'de', '{name} in {title}',             'eine neue zeile in deinem raum'),
    ('room_message',    'tr', '{title} · {name}',              'odanda yeni bir satır'),
    ('reply',           'en', '{name} replied',                'a new reply'),
    ('reply',           'de', '{name} hat geantwortet',        'eine neue antwort'),
    ('reply',           'tr', '{name} cevap verdi',            'yeni bir cevap'),
    ('digest',          'en', 'this weekend in {city}',        '{n} nights · {friends} kept by friends'),
    ('digest',          'de', 'dieses wochenende in {city}',   '{n} nächte · {friends} von freunden behalten'),
    ('digest',          'tr', 'bu hafta sonu {city}',          '{n} gece · {friends} tanesini arkadaşların sakladı'),
    ('dj_live',         'en', '{name} plays soon',             '{where} · {time}'),
    ('dj_live',         'de', '{name} legt bald auf',          '{where} · {time}'),
    ('dj_live',         'tr', '{name} birazdan çalıyor',       '{where} · {time}'),
    ('wave',            'en', '2nd wave',                      'a friend of {via} kept {title}'),
    ('wave',            'de', '2. welle',                      'ein freund von {via} hat {title} behalten'),
    ('wave',            'tr', '2. dalga',                      '{via} üzerinden biri {title} gecesini sakladı'),
    ('spark',           'en', '{name} is starting something',  '{title} · {when}'),
    ('spark',           'de', '{name} startet etwas',          '{title} · {when}'),
    ('spark',           'tr', '{name} bir şey başlatıyor',     '{title} · {when}'),
    ('spark_in',        'en', '{name} is in',                  '{title}'),
    ('spark_in',        'de', '{name} ist dabei',              '{title}'),
    ('spark_in',        'tr', '{name} geliyor',                '{title}'),
    ('group_added',     'en', 'you are in {group}',            '{name} added you · swipe nights together'),
    ('group_added',     'de', 'du bist in {group}',            '{name} hat dich hinzugefügt · wischt zusammen'),
    ('group_added',     'tr', '{group} grubundasın',           '{name} seni ekledi · birlikte gece seçin'),
    ('group_joined',    'en', '{group}',                       '{name} joined'),
    ('group_joined',    'de', '{group}',                       '{name} ist dazugekommen'),
    ('group_joined',    'tr', '{group}',                       '{name} gruba katıldı'),
    ('group_match',     'en', '{group} · everyone is in',      '{title}'),
    ('group_match',     'de', '{group} · alle sind dabei',     '{title}'),
    ('group_match',     'tr', '{group} · herkes var',          '{title}'),
    ('group_round',     'en', '{group} · vote',                '{name} put {title} to a vote'),
    ('group_round',     'de', '{group} · abstimmung',          '{name} lässt abstimmen: {title}'),
    ('group_round',     'tr', '{group} · oylama',              '{name} oylamaya sundu: {title}'),
    ('group_won',       'en', '{group} · the vote is in',      '{title}'),
    ('group_won',       'de', '{group} · abgestimmt',          '{title}'),
    ('group_won',       'tr', '{group} · oylama bitti',        '{title}'),
    ('group_plan',      'en', '{group} · the plan',            '{name}: {title}'),
    ('group_plan',      'de', '{group} · der plan',            '{name}: {title}'),
    ('group_plan',      'tr', '{group} · plan',                '{name}: {title}'),
    ('group_message',   'en', '{group} · {name}',              'a new message'),
    ('group_message',   'de', '{group} · {name}',              'eine neue nachricht'),
    ('group_message',   'tr', '{group} · {name}',              'yeni bir mesaj'),
    ('group_live',      'en', '{group} · live now',            '{name} wants to swipe together, now'),
    ('group_live',      'de', '{group} · gerade live',         '{name} will jetzt zusammen wischen'),
    ('group_live',      'tr', '{group} · şimdi canlı',         '{name} şimdi birlikte kaydırmak istiyor'),
    ('group_ticket',    'en', '{group} · tomorrow',            'you are in for {title} but have no ticket yet'),
    ('group_ticket',    'de', '{group} · morgen',              'du bist bei {title} dabei, hast aber noch kein ticket'),
    ('group_ticket',    'tr', '{group} · yarın',               '{title} için geliyorsun ama henüz biletin yok'),
    ('post',            'en', '{name} posted',                 'a new post'),
    ('post',            'de', '{name} hat gepostet',           'ein neuer post'),
    ('post',            'tr', '{name} paylaştı',               'yeni bir gönderi'),
    ('post_like',       'en', '{name} likes your post',        'open yours to see it'),
    ('post_like',       'de', '{name} gefällt dein post',      'in yours ansehen'),
    ('post_like',       'tr', '{name} gönderini beğendi',      'yours sekmesinde'),
    ('post_comment',    'en', '{name} commented',              'a new comment'),
    ('post_comment',    'de', '{name} hat kommentiert',        'ein neuer kommentar'),
    ('post_comment',    'tr', '{name} yorum yaptı',            'yeni bir yorum'),
    -- 59_dms.sql: a direct message; the name, never the words
    ('dm',              'en', '{name}',                        'a new message'),
    ('dm',              'de', '{name}',                        'eine neue nachricht'),
    ('dm',              'tr', '{name}',                        'yeni bir mesaj'),
    ('staff',           'en', 'the panel',                     '{n} waiting: reports, nights sent in, dj pages'),
    ('staff',           'de', 'das panel',                     '{n} warten: meldungen, eingesandte nächte, dj-seiten'),
    ('staff',           'tr', 'panel',                         '{n} iş bekliyor: şikayetler, gönderilen geceler, dj sayfaları'),
    -- 72_night_changed.sql: a night you kept, answered or hold a ticket for
    ('night_changed',   'en', '{title}',                       '{what}'),
    ('night_changed',   'de', '{title}',                       '{what}'),
    ('night_changed',   'tr', '{title}',                       '{what}')
  ) as x(kind, lang, title, body)
  where x.kind = p_kind and x.lang = coalesce(nullif(p_lang, ''), 'en');

  -- The words of a member never reach a lock screen (the decision of owner, 11.10.2026): what the
  -- triggers still pass as text is dropped here, whatever the caller.
  for pair in select * from jsonb_each_text(coalesce(p_data, '{}') - 'text') loop
    title := replace(title, '{' || pair.key || '}', coalesce(pair.value, ''));
    body  := replace(body,  '{' || pair.key || '}', coalesce(pair.value, ''));
  end loop;
  return next;
end;
$$;

create or replace function public.push_wants(p_user uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select case
             when p_kind = 'friend_request'  then s.notify_requests
             when p_kind = 'friend_accepted' then s.notify_accepts
             when p_kind = 'match'           then s.notify_matches
             when p_kind = 'friend_live'     then s.notify_live
             when p_kind in ('night_soon', 'night_changed') then s.notify_nights
             when p_kind in ('room_open', 'room_closing', 'room_message') then s.notify_rooms
             when p_kind = 'reply'           then s.notify_replies
             when p_kind = 'digest'          then s.notify_digest
             when p_kind = 'dj_live'         then s.notify_djs
             when p_kind = 'wave'            then s.notify_waves
             when p_kind in ('spark', 'spark_in') then s.notify_sparks
             when p_kind like 'group\_%' then s.notify_groups
             when p_kind in ('post', 'post_like', 'post_comment') then s.notify_posts
             when p_kind = 'dm'              then s.notify_dms
           end
    from public.profile_settings s where s.user_id = p_user), true);
$$;

-- The three phrases, in the language of the one who receives the push.
create or replace function public.night_change_words(p_what text, p_lang text, p_when text)
returns text
language sql
immutable
as $$
  select case coalesce(nullif(p_lang, ''), 'en')
    when 'de' then case p_what when 'cancelled' then 'abgesagt' when 'postponed' then 'verschoben, neues datum folgt' else 'verlegt auf ' || p_when end
    when 'tr' then case p_what when 'cancelled' then 'iptal edildi' when 'postponed' then 'ertelendi, yeni tarih bekleniyor' else p_when || ' tarihine alındı' end
    else case p_what when 'cancelled' then 'cancelled' when 'postponed' then 'postponed, new date to come' else 'moved to ' || p_when end
  end;
$$;

-- Who is on a night: kept it, answered in, or got a ticket.
create or replace function public.push_on_night_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  what text;
  them record;
begin
  if new.status in ('cancelled', 'postponed') and old.status is distinct from new.status then
    what := new.status;
  elsif new.starts_at is distinct from old.starts_at and not new.starts_at_estimated
        and old.starts_at is not null and new.starts_at is not null
        and new.starts_at > now() then
    what := 'moved';
  else
    return new;
  end if;
  for them in
    select distinct u.user_id from (
      select w.user_id from public.swipes w where w.event_id = new.id and w.direction = 'right'
      union select r.user_id from public.rsvps r where r.event_id = new.id and r.answer = 'in'
      union select t.user_id from public.tickets t where t.event_id = new.id and t.answer = 'got'
    ) u
  loop
    perform public.push_enqueue(them.user_id, 'night_changed',
      format('night_changed:%s:%s:%s:%s', them.user_id, new.id, what, to_char(new.starts_at, 'YYYY-MM-DD-HH24MI')),
      jsonb_build_object(
        'title', new.title,
        'what',  public.night_change_words(what, (select coalesce(nullif(s.locale, ''), 'en') from public.profile_settings s where s.user_id = them.user_id), public.push_when(them.user_id, new.starts_at)),
        'url',   '/night/' || new.slug));
  end loop;
  return new;
end;
$$;
revoke execute on function public.push_on_night_change() from public, anon, authenticated;

drop trigger if exists push_night_change on public.events;
create trigger push_night_change
  after update of status, starts_at on public.events
  for each row execute function public.push_on_night_change();

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('72_night_changed.sql', '2f0213a3c58fb78ba0811d26a5a5d0b47ebce9fd9ccdac4b17613e9c5821bb7a');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('72_night_changed.sql');
  end if;
end $$;
