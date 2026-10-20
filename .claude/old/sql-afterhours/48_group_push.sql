-- afterhours — groups and posts say so: push notifications (48, after 26, 34, 44 to 47)
--
-- The same path as every other push (26_push.sql): a trigger writes a row to
-- push_outbox, the outbox sends it. Two new switches in the settings:
--
--   notify_groups   group_added    someone put you in a group
--                   group_joined   someone came in with the code
--                   group_match    a night everyone in the group said yes to
--                   group_round    a vote started
--                   group_won      a vote is decided
--                   group_plan     a member set the plan
--                   group_message  a line in the chat; at most one per group and
--                                  ten minutes, so a lively chat is one buzz
--                   group_live     someone opened live and nobody else is there;
--                                  at once, also in quiet hours (it is now or never),
--                                  at most once per group and half hour
--                   group_ticket   the plan is tomorrow, you said in or maybe and
--                                  have no ticket (the hourly job below)
--   notify_posts    post           a friend posted (counts against the ten a day)
--
-- Nobody hears about what they did themselves. Every trigger swallows its own
-- errors: a push that fails never stops the thing that caused it.
--
-- push_wants, push_enqueue and push_text are the ones from 26 with the new kinds
-- added; nothing else in them changes.

alter table public.profile_settings add column if not exists notify_groups boolean not null default true;
alter table public.profile_settings add column if not exists notify_posts boolean not null default true;

alter table public.push_outbox drop constraint if exists push_outbox_kind_check;
alter table public.push_outbox add constraint push_outbox_kind_check check (kind in (
  'friend_request', 'friend_accepted', 'match', 'friend_live',
  'night_soon', 'room_open', 'room_closing', 'room_message', 'reply',
  'digest', 'dj_live', 'wave', 'spark', 'spark_in',
  'group_added', 'group_joined', 'group_match', 'group_round', 'group_won', 'group_plan',
  'group_message', 'group_live', 'group_ticket', 'post',
  -- 54_upkeep.sql: the staff, when something waits in the panel
  'staff',
  -- 55_post_social.sql: someone liked or commented on your post
  'post_like', 'post_comment'));

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
             when p_kind like 'group\_%' then s.notify_groups
             when p_kind in ('post', 'post_like', 'post_comment') then s.notify_posts
           end
    from public.profile_settings s where s.user_id = p_user), true);
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
  if p_kind in ('room_message', 'digest', 'dj_live', 'wave', 'post', 'post_like')
     and (select count(*) from public.push_outbox o
          where o.user_id = p_user and o.created_at > now() - interval '1 day'
            and o.kind in ('room_message', 'digest', 'dj_live', 'wave', 'post', 'post_like')) >= 10 then
    return;
  end if;
  -- quiet hours: wait for 09:00 on the phone
  if p_kind not in ('friend_live', 'room_open', 'room_closing', 'room_message', 'night_soon', 'dj_live', 'group_live') then
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
    ('group_message',   'en', '{group} · {name}',              '{text}'),
    ('group_message',   'de', '{group} · {name}',              '{text}'),
    ('group_message',   'tr', '{group} · {name}',              '{text}'),
    ('group_live',      'en', '{group} · live now',            '{name} wants to swipe together, now'),
    ('group_live',      'de', '{group} · gerade live',         '{name} will jetzt zusammen wischen'),
    ('group_live',      'tr', '{group} · şimdi canlı',         '{name} şimdi birlikte kaydırmak istiyor'),
    ('group_ticket',    'en', '{group} · tomorrow',            'you are in for {title} but have no ticket yet'),
    ('group_ticket',    'de', '{group} · morgen',              'du bist bei {title} dabei, hast aber noch kein ticket'),
    ('group_ticket',    'tr', '{group} · yarın',               '{title} için geliyorsun ama henüz biletin yok'),
    ('post',            'en', '{name} posted',                 '{text}'),
    ('post',            'de', '{name} hat gepostet',           '{text}'),
    ('post',            'tr', '{name} paylaştı',               '{text}'),
    ('post_like',       'en', '{name} likes your post',        '{text}'),
    ('post_like',       'de', '{name} gefällt dein post',      '{text}'),
    ('post_like',       'tr', '{name} gönderini beğendi',      '{text}'),
    ('post_comment',    'en', '{name} commented',              '{text}'),
    ('post_comment',    'de', '{name} hat kommentiert',        '{text}'),
    ('post_comment',    'tr', '{name} yorum yaptı',            '{text}'),
    ('staff',           'en', 'the panel',                     '{n} waiting: reports, nights sent in, dj pages'),
    ('staff',           'de', 'das panel',                     '{n} warten: meldungen, eingesandte nächte, dj-seiten'),
    ('staff',           'tr', 'panel',                         '{n} iş bekliyor: şikayetler, gönderilen geceler, dj sayfaları')
  ) as x(kind, lang, title, body)
  where x.kind = p_kind and x.lang = coalesce(nullif(p_lang, ''), 'en');

  for pair in select * from jsonb_each_text(coalesce(p_data, '{}')) loop
    title := replace(title, '{' || pair.key || '}', coalesce(pair.value, ''));
    body  := replace(body,  '{' || pair.key || '}', coalesce(pair.value, ''));
  end loop;
  return next;
end;
$$;


-- ------------------------------------------------------------ helpers

-- Everyone in the group but p_skip, with the words every group push carries.
create or replace function public.push_group(p_group uuid, p_skip uuid, p_kind text, p_key text, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
  g public.groups%rowtype;
begin
  select * into g from public.groups where id = p_group;
  if g.id is null then return; end if;
  for m in select user_id from public.group_members where group_id = p_group and user_id is distinct from p_skip loop
    perform public.push_enqueue(m.user_id, p_kind, replace(p_key, '{user}', m.user_id::text),
      jsonb_build_object('group', g.emoji || ' ' || g.name, 'url', '/groups/' || g.id) || coalesce(p_data, '{}'));
  end loop;
end;
$$;
revoke execute on function public.push_group(uuid, uuid, text, text, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------ members

-- Added by someone else: the new one hears it. Came in with a code (they added
-- themselves): the others hear it. The maker of a new group hears nothing.
create or replace function public.push_on_group_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  g public.groups%rowtype;
begin
  select * into g from public.groups where id = new.group_id;
  if new.role = 'owner' then return new; end if;
  if auth.uid() is distinct from new.user_id then
    perform public.push_enqueue(new.user_id, 'group_added', format('group_added:%s:%s', g.id, new.user_id),
      jsonb_build_object('group', g.emoji || ' ' || g.name, 'name', public.push_name(coalesce(auth.uid(), g.created_by)), 'url', '/groups/' || g.id));
  else
    perform public.push_group(g.id, new.user_id, 'group_joined', format('group_joined:%s:%s:{user}', g.id, new.user_id),
      jsonb_build_object('name', public.push_name(new.user_id)));
  end if;
  return new;
exception when others then
  raise warning 'group push skipped: %', sqlerrm;
  return new;
end;
$$;
drop trigger if exists push_group_member on public.group_members;
create trigger push_group_member after insert on public.group_members
  for each row execute function public.push_on_group_member();

-- ------------------------------------------------------------ a match

-- The last yes, the one that makes it everyone: all members hear it, once per night.
create or replace function public.push_on_group_swipe()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  n int;
  y int;
begin
  if new.direction <> 'right' then return new; end if;
  select count(*) into n from public.group_members where group_id = new.group_id;
  if n < 2 then return new; end if;
  select count(*) into y from public.group_swipes s
    join public.group_members m on m.group_id = s.group_id and m.user_id = s.user_id
    where s.group_id = new.group_id and s.event_id = new.event_id and s.direction = 'right';
  if y = n then
    perform public.push_group(new.group_id, null, 'group_match', format('group_match:%s:%s:{user}', new.group_id, new.event_id),
      jsonb_build_object('title', (select title from public.events where id = new.event_id)));
  end if;
  return new;
exception when others then
  raise warning 'group push skipped: %', sqlerrm;
  return new;
end;
$$;
drop trigger if exists push_group_swipe on public.group_swipes;
create trigger push_group_swipe after insert or update of direction on public.group_swipes
  for each row execute function public.push_on_group_swipe();

-- ------------------------------------------------------------ the thread

-- The chat carries the moments too (46): a plan, a vote, a result, a line.
create or replace function public.push_on_group_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.kind = 'say' then
    -- one buzz per group, person and ten minutes
    perform public.push_group(new.group_id, new.user_id, 'group_message',
      format('group_message:%s:{user}:%s', new.group_id, floor(extract(epoch from new.created_at) / 600)),
      jsonb_build_object('name', public.push_name(new.user_id), 'text', left(new.body, 120), 'url', '/groups/chat?id=' || new.group_id));
  elsif new.kind = 'plan' then
    perform public.push_group(new.group_id, new.user_id, 'group_plan', format('group_plan:%s:%s:{user}', new.group_id, new.id),
      jsonb_build_object('name', public.push_name(new.user_id), 'title', new.body));
  elsif new.kind = 'round' then
    perform public.push_group(new.group_id, new.user_id, 'group_round', format('group_round:%s:%s:{user}', new.group_id, new.id),
      jsonb_build_object('name', public.push_name(new.user_id), 'title', new.body));
  elsif new.kind = 'won' then
    perform public.push_group(new.group_id, null, 'group_won', format('group_won:%s:%s:{user}', new.group_id, new.id),
      jsonb_build_object('title', new.body));
  end if;
  return new;
exception when others then
  raise warning 'group push skipped: %', sqlerrm;
  return new;
end;
$$;
drop trigger if exists push_group_message on public.group_messages;
create trigger push_group_message after insert on public.group_messages
  for each row execute function public.push_on_group_message();

-- ------------------------------------------------------------ live

-- Someone opens live and nobody else is there: the others are called.
create or replace function public.push_on_group_live()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.group_live l where l.group_id = new.group_id and l.user_id <> new.user_id
             and l.seen_at > now() - interval '40 seconds') then
    return new;
  end if;
  perform public.push_group(new.group_id, new.user_id, 'group_live',
    format('group_live:%s:{user}:%s', new.group_id, floor(extract(epoch from now()) / 1800)),
    jsonb_build_object('name', public.push_name(new.user_id)));
  return new;
exception when others then
  raise warning 'group push skipped: %', sqlerrm;
  return new;
end;
$$;
drop trigger if exists push_group_live on public.group_live;
create trigger push_group_live after insert on public.group_live
  for each row execute function public.push_on_group_live();


-- ------------------------------------------------------------ posts

create or replace function public.push_on_post()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  f record;
begin
  for f in
    select case when requester_id = new.author_id then addressee_id else requester_id end as friend
    from public.friendships
    where status = 'accepted' and (requester_id = new.author_id or addressee_id = new.author_id)
  loop
    perform public.push_enqueue(f.friend, 'post', format('post:%s:%s', new.id, f.friend),
      jsonb_build_object('name', public.push_name(new.author_id),
                         'text', coalesce(nullif(left(new.body, 120), ''), '📷'),
                         'url', '/yours'));
  end loop;
  return new;
exception when others then
  raise warning 'post push skipped: %', sqlerrm;
  return new;
end;
$$;
drop trigger if exists push_post on public.posts;
create trigger push_post after insert on public.posts
  for each row execute function public.push_on_post();

-- ------------------------------------------------------------ tickets

-- Hourly: a plan that starts in 20 to 28 hours, members who said in or maybe and
-- have no ticket, when the night has a ticket link. Once per plan and person.
create or replace function public.group_push_hourly()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  n int := 0;
begin
  for r in
    select g.id as group_id, g.emoji, g.name, e.id as event_id, e.title, a.user_id
    from public.groups g
    join public.events e on e.id = g.plan_event_id and e.ticket_url is not null
    join public.group_members m on m.group_id = g.id
    join public.rsvps a on a.user_id = m.user_id and a.event_id = e.id and a.answer in ('in', 'maybe')
    where e.starts_at between now() + interval '20 hours' and now() + interval '28 hours'
      and not exists (select 1 from public.group_tickets t where t.group_id = g.id and t.event_id = e.id and t.user_id = m.user_id)
  loop
    perform public.push_enqueue(r.user_id, 'group_ticket', format('group_ticket:%s:%s:%s', r.group_id, r.event_id, r.user_id),
      jsonb_build_object('group', r.emoji || ' ' || r.name, 'title', r.title, 'url', '/groups/' || r.group_id));
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke execute on function public.group_push_hourly() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('afterhours-group-hourly')
      where exists (select 1 from cron.job where jobname = 'afterhours-group-hourly');
    perform cron.schedule('afterhours-group-hourly', '15 * * * *', $job$ select public.group_push_hourly(); $job$);
  end if;
end
$$;

revoke execute on function public.push_wants(uuid, text) from public, anon, authenticated;
revoke execute on function public.push_enqueue(uuid, text, text, jsonb) from public, anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('48_group_push.sql', 'a004216cd5f5813dd3b963040bbb977722b44aa59a099d56da3014b53bfa7cab');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('48_group_push.sql');
  end if;
end $$;
