-- afterhours — push notifications
-- Every notification has a switch in the settings (profile_settings.notify_*):
--
--   friends    friend_request · friend_accepted · match · friend_live
--   nights     night_soon (a kept night starts in 2 to 3 hours)
--              room_open · room_closing · room_message (the rooms switch)
--              reply (someone answered your beforehours comment)
--   discovery  digest (thursday evening: the weekend in your city)
--              dj_live (a DJ you follow plays within the hour)
--              wave (a friend of a friend kept a night in your city)
--   sparks     spark (someone in your waves started one) · spark_in (someone is in on yours)
--              the triggers live in 34_spark_push.sql, after the sparks exist
--
-- The path: a trigger (or the hourly job) writes one row to push_outbox,
-- unless the person turned that kind off; a unique key keeps the same thing
-- from going out twice. A trigger on push_outbox hands due rows to the Expo
-- push service through pg_net; the rest wait for the five-minute flush.
--
-- Quiet hours: between 00:00 and 09:00 on the phone, requests, accepts,
-- matches, replies and the discovery kinds wait until 09:00. Friends out
-- now, the rooms, soon-starting nights and DJ sets go at once: they belong
-- to the night. Discovery and room messages stop at ten a day per person.
--
-- The phone registers its token with push_register(); a token belongs to
-- one account at a time and carries the app language and the time zone of
-- the phone. Without pg_net (the tests) rows wait in the outbox, unsent.
-- Phones Expo reports as gone are removed by the flush (push_prune).
--
-- Safe to run again on top of an earlier version of this file: every
-- table, column, constraint and function is created or replaced in place.

do $$ begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net is not available here; push rows stay in the outbox';
end $$;

-- ------------------------------------------------------------ the switches

alter table public.profile_settings
  add column if not exists notify_requests boolean not null default true,
  add column if not exists notify_accepts  boolean not null default true,
  add column if not exists notify_matches  boolean not null default true,
  add column if not exists notify_live     boolean not null default true,
  add column if not exists notify_nights   boolean not null default true,
  add column if not exists notify_rooms    boolean not null default true,
  add column if not exists notify_replies  boolean not null default true,
  add column if not exists notify_digest   boolean not null default true,
  add column if not exists notify_djs      boolean not null default true,
  add column if not exists notify_waves    boolean not null default true,
  add column if not exists notify_sparks   boolean not null default true;

-- ------------------------------------------------------------ the phones

create table if not exists public.push_tokens (
  token       text primary key check (token ~ '^Expo(nent)?PushToken\[.+\]$'),
  user_id     uuid not null references public.profiles on delete cascade,
  platform    text not null check (platform in ('ios', 'android')),
  lang        text not null default 'en' check (lang in ('en', 'de', 'tr')),
  tz          text not null default 'Europe/Berlin',
  updated_at  timestamptz not null default now()
);
alter table public.push_tokens add column if not exists tz text not null default 'Europe/Berlin';
create index if not exists push_tokens_user_idx on public.push_tokens (user_id, updated_at desc);

alter table public.push_tokens enable row level security;
drop policy if exists push_tokens_read_own on public.push_tokens;
create policy push_tokens_read_own on public.push_tokens for select
  using (user_id = auth.uid());
revoke all on public.push_tokens from anon, authenticated;
grant select on public.push_tokens to authenticated;

-- A token moves to whoever signs in on that phone; language and zone follow the app.
drop function if exists public.push_register(text, text, text);
create or replace function public.push_register(p_token text, p_platform text, p_lang text default 'en', p_tz text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  zone text := 'Europe/Berlin';
begin
  if auth.uid() is null then
    raise exception 'not signed in';
  end if;
  if p_tz is not null and exists (select 1 from pg_timezone_names where name = p_tz) then
    zone := p_tz;
  end if;
  insert into public.push_tokens (token, user_id, platform, lang, tz)
  values (p_token, auth.uid(), p_platform, coalesce(p_lang, 'en'), zone)
  on conflict (token) do update
    set user_id = excluded.user_id, platform = excluded.platform,
        lang = excluded.lang, tz = excluded.tz, updated_at = now();
  return true;
end;
$$;

-- On sign-out: this phone stops receiving notifications for this account.
create or replace function public.push_unregister(p_token text)
returns boolean
language sql
security definer
set search_path = public
as $$
  with gone as (
    delete from public.push_tokens where token = p_token and user_id = auth.uid() returning 1
  )
  select exists (select 1 from gone);
$$;

-- ------------------------------------------------------------ the outbox

create table if not exists public.push_outbox (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles on delete cascade,
  kind        text not null,
  -- one notification per thing: the same key never goes out twice
  key         text not null unique,
  data        jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  send_after  timestamptz not null default now(),
  sent_at     timestamptz
);
alter table public.push_outbox add column if not exists send_after timestamptz not null default now();
-- what was sent where: the pg_net request and the phones in message order,
-- so the answer from Expo can tell which phone no longer exists
alter table public.push_outbox add column if not exists request_id bigint;
alter table public.push_outbox add column if not exists tokens text[];
alter table public.push_outbox add column if not exists checked boolean not null default false;
alter table public.push_outbox drop constraint if exists push_outbox_kind_check;
alter table public.push_outbox add constraint push_outbox_kind_check check (kind in (
  'friend_request', 'friend_accepted', 'match', 'friend_live',
  'night_soon', 'room_open', 'room_closing', 'room_message', 'reply',
  'digest', 'dj_live', 'wave', 'spark', 'spark_in'));
create index if not exists push_outbox_user_idx on public.push_outbox (user_id, created_at desc);
create index if not exists push_outbox_due_idx on public.push_outbox (send_after) where sent_at is null;

-- Nobody reads or writes it directly; the triggers and jobs below do.
alter table public.push_outbox enable row level security;
revoke all on public.push_outbox from anon, authenticated;

-- ------------------------------------------------------------ helpers

-- The name a notification shows: the handle, else the display name.
create or replace function public.push_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select coalesce(p.handle, p.display_name) from public.profiles p where p.id = p_user), 'someone');
$$;

-- The time zone of the most recently registered phone.
create or replace function public.push_zone(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select k.tz from public.push_tokens k where k.user_id = p_user
                   order by k.updated_at desc limit 1), 'Europe/Berlin');
$$;

-- Whether the person wants this kind; a missing settings row means yes.
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
             when p_kind = 'night_soon'      then s.notify_nights
             when p_kind in ('room_open', 'room_closing', 'room_message') then s.notify_rooms
             when p_kind = 'reply'           then s.notify_replies
             when p_kind = 'digest'          then s.notify_digest
             when p_kind = 'dj_live'         then s.notify_djs
             when p_kind = 'wave'            then s.notify_waves
             when p_kind in ('spark', 'spark_in') then s.notify_sparks
           end
    from public.profile_settings s where s.user_id = p_user), true);
$$;

-- Clock time on the phone, for the words: "22:00".
create or replace function public.push_clock(p_user uuid, p_at timestamptz)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select to_char(p_at at time zone public.push_zone(p_user), 'HH24:MI');
$$;

create or replace function public.push_enqueue(p_user uuid, p_kind text, p_key text, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  zone  text;
  here  timestamp;
  due   timestamptz := now();
begin
  if not public.push_wants(p_user, p_kind) then
    return;
  end if;
  -- the daily cap for the chattier kinds
  if p_kind in ('room_message', 'digest', 'dj_live', 'wave')
     and (select count(*) from public.push_outbox o
          where o.user_id = p_user and o.created_at > now() - interval '1 day'
            and o.kind in ('room_message', 'digest', 'dj_live', 'wave')) >= 10 then
    return;
  end if;
  -- quiet hours: wait for 09:00 on the phone
  if p_kind not in ('friend_live', 'room_open', 'room_closing', 'room_message', 'night_soon', 'dj_live') then
    zone := public.push_zone(p_user);
    here := now() at time zone zone;
    if extract(hour from here) < 9 then
      due := (date_trunc('day', here) + interval '9 hours') at time zone zone;
    end if;
  end if;
  insert into public.push_outbox (user_id, kind, key, data, send_after)
  values (p_user, p_kind, p_key, p_data, due)
  on conflict (key) do nothing;
end;
$$;

-- ------------------------------------------------------------ the words

-- Title and body in the language of the phone; every {key} is filled from data.
drop function if exists public.push_text(text, text, jsonb);
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
    ('room_message',    'en', '{name} in {title}',             '{text}'),
    ('room_message',    'de', '{name} in {title}',             '{text}'),
    ('room_message',    'tr', '{title} · {name}',              '{text}'),
    ('reply',           'en', '{name} replied',                '{text}'),
    ('reply',           'de', '{name} hat geantwortet',        '{text}'),
    ('reply',           'tr', '{name} cevap verdi',            '{text}'),
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
    ('spark_in',        'tr', '{name} geliyor',                '{title}')
  ) as x(kind, lang, title, body)
  where x.kind = p_kind and x.lang = coalesce(nullif(p_lang, ''), 'en');

  for pair in select * from jsonb_each_text(coalesce(p_data, '{}')) loop
    title := replace(title, '{' || pair.key || '}', coalesce(pair.value, ''));
    body  := replace(body,  '{' || pair.key || '}', coalesce(pair.value, ''));
  end loop;
  return next;
end;
$$;

-- ------------------------------------------------------------ delivery

-- One request per notification, one message per phone of the recipient.
-- pg_net sends after the transaction commits: a rolled back swipe sends nothing.
create or replace function public.push_send(p_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  item      public.push_outbox;
  messages  jsonb;
  phones    text[];
  request   bigint;
begin
  if to_regnamespace('net') is null then
    return false;
  end if;
  select * into item from public.push_outbox where id = p_id and sent_at is null;
  if not found then
    return false;
  end if;
  select jsonb_agg(jsonb_build_object(
           'to', k.token, 'title', x.title, 'body', x.body, 'sound', 'default',
           'channelId', 'default', 'data', item.data || jsonb_build_object('kind', item.kind)) order by k.token),
         array_agg(k.token order by k.token)
    into messages, phones
  from public.push_tokens k
  cross join lateral public.push_text(item.kind, k.lang, item.data) x
  where k.user_id = item.user_id;

  if messages is not null then
    -- the endpoint path contains two dashes, spelled out so no tool reads them as a comment
    execute 'select net.http_post(url := $1, body := $2, headers := $3)'
      into request
      using 'https://exp.host/' || repeat('-', 2) || '/api/v2/push/send', messages,
            '{"Content-Type": "application/json", "Accept": "application/json"}'::jsonb;
  end if;
  update public.push_outbox set sent_at = now(), request_id = request, tokens = phones where id = p_id;
  return messages is not null;
end;
$$;

create or replace function public.push_deliver()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.send_after <= now() then
    perform public.push_send(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists push_outbox_deliver on public.push_outbox;
create trigger push_outbox_deliver
  after insert on public.push_outbox
  for each row execute function public.push_deliver();

-- Reads the answers Expo gave (pg_net keeps them for a few hours) and forgets
-- phones that no longer exist: the app was removed or the token expired.
create or replace function public.push_prune()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  answer record;
  i      integer;
  gone   integer := 0;
begin
  if to_regclass('net._http_response') is null then
    return 0;
  end if;
  for answer in execute $q$
    select o.id, o.tokens, h.status_code, h.content
    from public.push_outbox o
    join net._http_response h on h.id = o.request_id
    where not o.checked and o.request_id is not null
  $q$
  loop
    begin
      if answer.status_code = 200 then
        for i in 0 .. coalesce(jsonb_array_length(answer.content::jsonb -> 'data'), 0) - 1 loop
          if (answer.content::jsonb -> 'data' -> i -> 'details' ->> 'error') = 'DeviceNotRegistered' then
            delete from public.push_tokens where token = answer.tokens[i + 1];
            gone := gone + 1;
          end if;
        end loop;
      end if;
    exception when others then
      null;  -- an answer that is not JSON tells us nothing
    end;
    update public.push_outbox set checked = true where id = answer.id;
  end loop;
  -- answers pg_net has already thrown away will never come
  update public.push_outbox set checked = true
  where not checked and sent_at < now() - interval '1 day';
  return gone;
end;
$$;

-- Sends what has come due (quiet hours over). Older than a day is dropped.
create or replace function public.push_flush()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  due  bigint;
  sent integer := 0;
begin
  if to_regnamespace('net') is null then
    return 0;
  end if;
  for due in
    select id from public.push_outbox
    where sent_at is null and send_after <= now() and send_after > now() - interval '1 day'
    order by id limit 500
  loop
    perform public.push_send(due);
    sent := sent + 1;
  end loop;
  perform public.push_prune();
  return sent;
end;
$$;

-- ------------------------------------------------------------ friends

-- Confirmed friendships in both directions: (who, friend).
create or replace view public.push_edges
with (security_invoker = true) as
  select requester_id as who, addressee_id as friend from public.friendships where status = 'accepted'
  union all
  select addressee_id, requester_id from public.friendships where status = 'accepted';
revoke all on public.push_edges from anon, authenticated;

-- A request arrives; or one is accepted. The key carries the day, so a request
-- taken back and sent again notifies again tomorrow, not ten times today.
create or replace function public.push_on_friendship()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.status = 'pending' then
    perform public.push_enqueue(new.addressee_id, 'friend_request',
      format('request:%s:%s:%s', new.requester_id, new.addressee_id, current_date),
      jsonb_build_object('name', public.push_name(new.requester_id), 'url', '/friend/' || new.requester_id));
  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'accepted' then
    perform public.push_enqueue(new.requester_id, 'friend_accepted',
      format('accepted:%s:%s', new.requester_id, new.addressee_id),
      jsonb_build_object('name', public.push_name(new.addressee_id), 'url', '/friend/' || new.addressee_id));
  end if;
  return new;
end;
$$;

drop trigger if exists push_friendship on public.friendships;
create trigger push_friendship
  after insert or update of status on public.friendships
  for each row execute function public.push_on_friendship();

-- A keep. Friends who kept the same night hear it (match). Friends of friends
-- in the city of the night hear it once a week, without the name (wave).
-- Nothing at all when the swiper keeps their keeps private (12: kept_visibility).
create or replace function public.push_on_swipe()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  night record;
  them  record;
begin
  if new.direction <> 'right' or (tg_op = 'UPDATE' and old.direction = 'right') then
    return new;
  end if;
  if not public.kept_visible(new.user_id) then
    return new;
  end if;
  select e.title, e.slug, e.city_id into night from public.events e where e.id = new.event_id;

  for them in
    select w.user_id
    from public.swipes w
    join public.push_edges f on f.who = new.user_id and f.friend = w.user_id
    where w.event_id = new.event_id and w.direction = 'right'
  loop
    perform public.push_enqueue(them.user_id, 'match',
      format('match:%s:%s:%s', them.user_id, new.user_id, new.event_id),
      jsonb_build_object('name', public.push_name(new.user_id), 'title', night.title, 'url', '/night/' || night.slug));
  end loop;

  for them in
    select distinct on (second.friend) second.friend as user_id, public.push_name(first.friend) as via
    from public.push_edges first
    join public.push_edges second on second.who = first.friend
    join public.profiles p on p.id = second.friend
    where first.who = new.user_id
      and second.friend <> new.user_id
      and p.city_id = night.city_id
      -- the friend in the middle is named: not someone who keeps their keeps closed
      and public.kept_visible(first.friend)
      and not exists (select 1 from public.push_edges d where d.who = new.user_id and d.friend = second.friend)
    order by second.friend, first.friend
  loop
    perform public.push_enqueue(them.user_id, 'wave',
      format('wave:%s:%s', them.user_id, to_char(now(), 'IYYY-IW')),
      jsonb_build_object('via', them.via, 'title', night.title, 'url', '/night/' || night.slug));
  end loop;
  return new;
end;
$$;

drop trigger if exists push_swipe on public.swipes;
create trigger push_swipe
  after insert or update of direction on public.swipes
  for each row execute function public.push_on_swipe();

-- ------------------------------------------------------------ nights and rooms

-- A check-in: your room is open; friends hear you are out (when shared).
create or replace function public.push_on_checkin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  night  record;
  friend uuid;
begin
  select e.title, e.slug, v.name as venue
    into night
  from public.events e left join public.venues v on v.id = e.venue_id
  where e.id = new.event_id;

  perform public.push_enqueue(new.user_id, 'room_open', format('room_open:%s', new.id),
    jsonb_build_object('title', night.title, 'url', '/room/' || night.slug));

  if new.show_friends then
    for friend in select f.friend from public.push_edges f where f.who = new.user_id loop
      perform public.push_enqueue(friend, 'friend_live',
        format('live:%s:%s', friend, new.id),
        jsonb_build_object('name', public.push_name(new.user_id),
                           'title', coalesce(night.venue || ' · ', '') || night.title,
                           'url', '/night/' || night.slug));
    end loop;
  end if;
  return new;
end;
$$;

-- A line in a room: everyone else checked in hears it, at most once per half hour per room.
create or replace function public.push_on_room_post()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  night record;
  them  uuid;
begin
  select e.title, e.slug into night from public.events e where e.id = new.event_id;
  for them in
    select c.user_id from public.checkins c
    where c.event_id = new.event_id and c.user_id is distinct from new.user_id
  loop
    perform public.push_enqueue(them, 'room_message',
      format('room:%s:%s:%s', them, new.event_id, floor(extract(epoch from new.created_at) / 1800)),
      jsonb_build_object('name', public.push_name(new.user_id), 'title', night.title,
                         'text', left(new.body, 80), 'url', '/room/' || night.slug));
  end loop;
  return new;
end;
$$;

-- A reply to your beforehours comment.
create or replace function public.push_on_comment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent uuid;
  night  record;
begin
  if new.parent_id is null or new.is_hidden then
    return new;
  end if;
  select c.author_id into parent from public.comments c where c.id = new.parent_id;
  if parent is null or parent is not distinct from new.author_id then
    return new;
  end if;
  select e.title, e.slug into night from public.events e where e.id = new.event_id;
  perform public.push_enqueue(parent, 'reply', format('reply:%s', new.id),
    jsonb_build_object('name', coalesce(case when new.author_id is not null then public.push_name(new.author_id) end,
                                        new.author_name, 'someone'),
                       'title', night.title, 'text', left(new.body, 80), 'url', '/night/' || night.slug));
  return new;
end;
$$;

do $$ begin
  if to_regclass('public.checkins') is not null then
    drop trigger if exists push_checkin on public.checkins;
    create trigger push_checkin
      after insert on public.checkins
      for each row execute function public.push_on_checkin();
  end if;
  if to_regclass('public.room_posts') is not null then
    drop trigger if exists push_room_post on public.room_posts;
    create trigger push_room_post
      after insert on public.room_posts
      for each row execute function public.push_on_room_post();
  end if;
end $$;

drop trigger if exists push_comment on public.comments;
create trigger push_comment
  after insert on public.comments
  for each row execute function public.push_on_comment();

-- ------------------------------------------------------------ the hourly job

-- Everything that depends on the clock. p_now exists for the tests.
create or replace function public.push_hourly(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n    integer := 0;
  them record;
begin
  -- a kept night starts in two to three hours
  for them in
    select w.user_id, e.id, e.title, e.slug, e.starts_at
    from public.swipes w join public.events e on e.id = w.event_id
    where w.direction = 'right' and e.is_published and not e.starts_at_estimated
      and e.starts_at > p_now + interval '2 hours' and e.starts_at <= p_now + interval '3 hours'
  loop
    perform public.push_enqueue(them.user_id, 'night_soon', format('soon:%s:%s', them.user_id, them.id),
      jsonb_build_object('title', them.title, 'time', public.push_clock(them.user_id, them.starts_at),
                         'url', '/night/' || them.slug));
    n := n + 1;
  end loop;

  -- a room freezes within two hours
  if to_regclass('public.checkins') is not null then
    for them in execute $q$
      select c.id, c.user_id, e.title, e.slug
      from public.checkins c join public.events e on e.id = c.event_id
      where public.room_freeze_at(c.event_id) > $1 + interval '1 hour'
        and public.room_freeze_at(c.event_id) <= $1 + interval '2 hours'
    $q$ using p_now
    loop
      perform public.push_enqueue(them.user_id, 'room_closing', format('closing:%s', them.id),
        jsonb_build_object('title', them.title, 'url', '/room/' || them.slug));
      n := n + 1;
    end loop;
  end if;

  -- a followed DJ plays within the hour
  if to_regclass('public.dj_sets') is not null then
    for them in execute $q$
      select f.user_id, s.id, s.venue, s.starts_at, d.name, d.slug
      from public.dj_follows f
      join public.dj_sets s on s.dj_id = f.dj_id
      join public.djs d on d.id = f.dj_id
      where s.starts_at > $1 and s.starts_at <= $1 + interval '1 hour'
    $q$ using p_now
    loop
      perform public.push_enqueue(them.user_id, 'dj_live', format('dj:%s:%s', them.user_id, them.id),
        jsonb_build_object('name', them.name, 'where', them.venue,
                           'time', public.push_clock(them.user_id, them.starts_at), 'url', '/dj/' || them.slug));
      n := n + 1;
    end loop;
  end if;

  -- thursday 18:00 on the phone: the weekend in your city (friday 18:00 to monday 06:00)
  for them in
    with here as (
      select distinct on (k.user_id) k.user_id, k.tz from public.push_tokens k order by k.user_id, k.updated_at desc
    ),
    due as (
      select h.user_id, p.city_id, c.name as city,
             ((p_now at time zone h.tz)::date + 1 + time '18:00') at time zone h.tz as from_at,
             ((p_now at time zone h.tz)::date + 4 + time '06:00') at time zone h.tz as to_at
      from here h
      join public.profiles p on p.id = h.user_id
      join public.cities c on c.id = p.city_id
      where extract(isodow from p_now at time zone h.tz) = 4
        and extract(hour from p_now at time zone h.tz) = 18
    )
    select d.user_id, d.city,
           (select count(*)::int from public.events e
             where e.city_id = d.city_id and e.is_published and e.starts_at >= d.from_at and e.starts_at < d.to_at) as nights,
           (select count(distinct w.event_id)::int from public.swipes w
              join public.events e on e.id = w.event_id
              join public.push_edges f on f.who = d.user_id and f.friend = w.user_id
             where w.direction = 'right' and public.kept_visible(w.user_id)
               and e.city_id = d.city_id and e.starts_at >= d.from_at and e.starts_at < d.to_at) as kept
    from due d
  loop
    if them.nights > 0 then
      perform public.push_enqueue(them.user_id, 'digest', format('digest:%s:%s', them.user_id, to_char(p_now, 'IYYY-IW')),
        jsonb_build_object('city', them.city, 'n', them.nights, 'friends', them.kept, 'url', '/flow'));
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

-- ------------------------------------------------------------ the schedule

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('afterhours-push-flush')
      where exists (select 1 from cron.job where jobname = 'afterhours-push-flush');
    perform cron.unschedule('afterhours-push-hourly')
      where exists (select 1 from cron.job where jobname = 'afterhours-push-hourly');
    perform cron.schedule('afterhours-push-flush', '*/5 * * * *', $job$ select public.push_flush(); $job$);
    perform cron.schedule('afterhours-push-hourly', '0 * * * *', $job$ select public.push_hourly(); $job$);
  end if;
end
$$;

-- ------------------------------------------------------------ grants

revoke execute on function public.push_register(text, text, text, text) from public, anon;
revoke execute on function public.push_unregister(text)                  from public, anon;
grant execute on function public.push_register(text, text, text, text)  to authenticated;
grant execute on function public.push_unregister(text)                  to authenticated;

-- Everything else is for the triggers and the jobs only.
revoke execute on function public.push_name(uuid)                        from public, anon, authenticated;
revoke execute on function public.push_zone(uuid)                        from public, anon, authenticated;
revoke execute on function public.push_wants(uuid, text)                 from public, anon, authenticated;
revoke execute on function public.push_clock(uuid, timestamptz)          from public, anon, authenticated;
revoke execute on function public.push_enqueue(uuid, text, text, jsonb)  from public, anon, authenticated;
revoke execute on function public.push_send(bigint)                      from public, anon, authenticated;
revoke execute on function public.push_flush()                           from public, anon, authenticated;
revoke execute on function public.push_prune()                           from public, anon, authenticated;
revoke execute on function public.push_hourly(timestamptz)               from public, anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('26_push.sql', '3bb69fa2d92d5a3a13e8476335a8d2b63334576a944ebf6dfc9fbcac1f64336d');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('26_push.sql');
  end if;
end $$;
