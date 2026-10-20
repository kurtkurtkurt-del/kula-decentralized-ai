-- afterhours — paste of 08.10.2026: 48 again (one new push kind), 50 to 54, then the clipboard repair.
-- Every part is safe to run again, so it does not matter which of them already ran.

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
  'staff'));

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
             when p_kind = 'post'            then s.notify_posts
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
  if p_kind in ('room_message', 'digest', 'dj_live', 'wave', 'post')
     and (select count(*) from public.push_outbox o
          where o.user_id = p_user and o.created_at > now() - interval '1 day'
            and o.kind in ('room_message', 'digest', 'dj_live', 'wave', 'post')) >= 10 then
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
  if to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('48_group_push.sql');
  end if;
end $$;

-- afterhours — blocking someone (50, after 07, 12, 25, 28)
--
--   blocks                 who blocked whom; a closed table, read through my_blocks()
--   block_user(other)      blocks: the friendship or a pending request between you
--                          is gone, and neither side can ask again
--   unblock_user(other)    takes it back (the friendship does not come back)
--   my_blocks()            the people you blocked, for the list in settings
--   is_blocked(other)      true when either of you blocked the other
--
-- What a block does, in both directions: the card is not shown (card_visible,
-- so profile_card, people_search and people_suggested), no friend request can
-- be sent (friend_request answers notfound, a direct insert is refused), and the
-- wave of a spark does not reach across it. Everything that is for friends only
-- (posts, photos, links, kept nights, push) closes with the friendship.
-- The blocked person is not told.

create table if not exists public.blocks (
  blocker_id  uuid not null references public.profiles(id) on delete cascade,
  blocked_id  uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists blocks_blocked on public.blocks (blocked_id);

alter table public.blocks enable row level security;
revoke all on public.blocks from public, anon, authenticated;

create or replace function public.is_blocked(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.blocks b
                 where (b.blocker_id = auth.uid() and b.blocked_id = other)
                    or (b.blocker_id = other and b.blocked_id = auth.uid()));
$$;
revoke execute on function public.is_blocked(uuid) from public, anon;
grant execute on function public.is_blocked(uuid) to authenticated;

create or replace function public.block_user(p_other uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if p_other is null or p_other = auth.uid() then raise exception 'not yourself'; end if;
  if not exists (select 1 from public.profiles where id = p_other) then raise exception 'no such person'; end if;
  insert into public.blocks (blocker_id, blocked_id) values (auth.uid(), p_other)
  on conflict do nothing;
  delete from public.friendships
  where (requester_id = auth.uid() and addressee_id = p_other)
     or (addressee_id = auth.uid() and requester_id = p_other);
  return true;
end;
$$;

create or replace function public.unblock_user(p_other uuid)
returns boolean
language sql
security definer
set search_path = public
as $$
  with gone as (
    delete from public.blocks where blocker_id = auth.uid() and blocked_id = p_other returning 1
  )
  select exists (select 1 from gone);
$$;

drop function if exists public.my_blocks();
create or replace function public.my_blocks()
returns table (id uuid, handle text, display_name text, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.handle, p.display_name, b.created_at
  from public.blocks b join public.profiles p on p.id = b.blocked_id
  where b.blocker_id = auth.uid()
  order by b.created_at desc;
$$;

revoke execute on function public.block_user(uuid)   from public, anon;
revoke execute on function public.unblock_user(uuid) from public, anon;
revoke execute on function public.my_blocks()        from public, anon;
grant execute on function public.block_user(uuid)    to authenticated;
grant execute on function public.unblock_user(uuid)  to authenticated;
grant execute on function public.my_blocks()         to authenticated;

-- ------------------------------------------------------------ the card

-- As in 12, plus: nobody on either side of a block sees the card of the other.
create or replace function public.card_visible(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select other = auth.uid()
      or (not public.is_blocked(other)
          and (public.is_friend(other)
               or coalesce((select s.discoverable from public.profile_settings s
                            where s.user_id = other), true)));
$$;
revoke execute on function public.card_visible(uuid) from public, anon, authenticated;

-- ------------------------------------------------------- friend requests

-- As in 12, plus: across a block the handle does not exist.
create or replace function public.friend_request(p_handle text)
returns text
language plpgsql
as $$
declare
  target uuid;
begin
  target := public.handle_to_id(p_handle);

  if target is null or public.is_blocked(target) then
    return 'notfound';
  end if;
  if target = auth.uid() then
    return 'yourself';
  end if;

  if exists (select 1 from public.friendships
             where requester_id = target and addressee_id = auth.uid()) then
    update public.friendships set status = 'accepted'
    where requester_id = target and addressee_id = auth.uid();
    return 'accepted';
  end if;

  insert into public.friendships (requester_id, addressee_id)
  values (auth.uid(), target)
  on conflict do nothing;
  return 'sent';
end;
$$;

-- A row written straight into friendships (the column grant allows it) is
-- held to the same rule.
create or replace function public.friendships_not_blocked()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.blocks b
             where (b.blocker_id = new.requester_id and b.blocked_id = new.addressee_id)
                or (b.blocker_id = new.addressee_id and b.blocked_id = new.requester_id)) then
    raise exception 'not possible';
  end if;
  return new;
end;
$$;
drop trigger if exists friendships_not_blocked on public.friendships;
create trigger friendships_not_blocked before insert on public.friendships
  for each row execute function public.friendships_not_blocked();

-- ------------------------------------------------------------ the waves

-- As in 28, minus anyone on either side of a block with the host.
create or replace function public.spark_waves(p_me uuid)
returns table (person uuid, hops int)
language sql
stable
security definer
set search_path = public
as $$
  with recursive f as (
    select requester_id as a, addressee_id as b from public.friendships where status = 'accepted'
    union all
    select addressee_id, requester_id from public.friendships where status = 'accepted'
  ),
  walk(person, hops) as (
    select b, 1 from f where a = p_me
    union
    select f.b, w.hops + 1 from walk w join f on f.a = w.person where w.hops < 3
  )
  select w.person, min(w.hops)::int from walk w
  where w.person <> p_me
    and not exists (select 1 from public.blocks b
                    where (b.blocker_id = p_me and b.blocked_id = w.person)
                       or (b.blocker_id = w.person and b.blocked_id = p_me))
  group by w.person;
$$;
revoke execute on function public.spark_waves(uuid) from public, anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('50_blocks.sql');
  end if;
end $$;

-- afterhours — what the stores require (51, after 42 to 50)
--
--   the terms     profiles.terms_version / terms_at / adult: accept_terms(version, adult),
--                 terms_status(). The app asks once, before anything else, and again
--                 when the terms change (a higher version).
--   reports       one table for everything but posts (45 keeps its own): comments,
--                 room messages, group messages, profiles, groups, sparks.
--                 report(kind, target, reason) for anyone with an account;
--                 staff_reports() and staff_report_settle(kind, target, remove)
--                 for the staff. Removing takes the content away (a comment is hidden,
--                 a message or spark or group deleted, a profile cleared of its words,
--                 links and photo); either way the reports are settled and logged.
--   client errors what crashed in the app: log_error() from any phone, admin_errors()
--                 and admin_errors_clear() for the admin.

-- ------------------------------------------------------------ the terms

alter table public.profiles add column if not exists terms_version int;
alter table public.profiles add column if not exists terms_at timestamptz;
alter table public.profiles add column if not exists adult boolean not null default false;

create or replace function public.accept_terms(p_version int, p_adult boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if not coalesce(p_adult, false) then raise exception 'eighteen or older only'; end if;
  if p_version is null or p_version < 1 then raise exception 'which terms?'; end if;
  update public.profiles
     set terms_version = greatest(coalesce(terms_version, 0), p_version), terms_at = now(), adult = true
   where id = auth.uid();
end;
$$;

create or replace function public.terms_status()
returns table (version int, adult boolean, at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select p.terms_version, p.adult, p.terms_at from public.profiles p where p.id = auth.uid();
$$;

revoke execute on function public.accept_terms(int, boolean) from public, anon;
revoke execute on function public.terms_status()             from public, anon;
grant execute on function public.accept_terms(int, boolean)  to authenticated;
grant execute on function public.terms_status()              to authenticated;

-- ------------------------------------------------------------ reports

create table if not exists public.reports (
  id           bigserial primary key,
  reporter_id  uuid not null references public.profiles on delete cascade,
  kind         text not null check (kind in ('comment', 'room_post', 'group_message', 'profile', 'group', 'spark')),
  target       text not null check (length(target) between 1 and 64),
  reason       text check (reason is null or length(reason) <= 300),
  handled      boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (reporter_id, kind, target)
);
create index if not exists reports_open on public.reports (kind, target) where not handled;
alter table public.reports enable row level security;
revoke all on public.reports from public, anon, authenticated;

-- Who wrote it, and whether it exists for you: null when it does not.
create or replace function public.report_author(p_kind text, p_target text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  a uuid;
begin
  if p_kind = 'comment' then
    select author_id into a from public.comments where id::text = p_target;
  elsif p_kind = 'room_post' then
    select user_id into a from public.room_posts where id::text = p_target;
  elsif p_kind = 'group_message' then
    select m.user_id into a from public.group_messages m
     where m.id::text = p_target and m.kind = 'say' and public.in_group(m.group_id);
  elsif p_kind = 'profile' then
    select id into a from public.profiles where id::text = p_target or handle = lower(p_target);
  elsif p_kind = 'group' then
    select g.created_by into a from public.groups g where g.id::text = p_target;
  elsif p_kind = 'spark' then
    select host_id into a from public.sparks where id::text = p_target;
  end if;
  return a;
end;
$$;
revoke all on function public.report_author(text, text) from public, anon, authenticated;

create or replace function public.report(p_kind text, p_target text, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a uuid;
  t text := btrim(coalesce(p_target, ''));
begin
  if auth.uid() is null or public.is_guest() then raise exception 'make an account first'; end if;
  a := public.report_author(p_kind, t);
  if a is null then raise exception 'nothing to report'; end if;
  if a = auth.uid() then raise exception 'that is yours'; end if;
  -- A profile is stored by its id, whichever way it was named.
  if p_kind = 'profile' then t := a::text; end if;
  if (select count(*) from public.reports where reporter_id = auth.uid() and created_at > now() - interval '1 day') >= 30 then
    raise exception 'thirty today is enough; the staff are on it';
  end if;
  insert into public.reports (reporter_id, kind, target, reason)
  values (auth.uid(), p_kind, t, left(nullif(btrim(p_reason), ''), 300))
  on conflict (reporter_id, kind, target) do update set reason = coalesce(excluded.reason, public.reports.reason), handled = false;
end;
$$;
revoke execute on function public.report(text, text, text) from public, anon;
grant execute on function public.report(text, text, text) to authenticated;

-- The open reports, one row per thing, most reported first. preview is what the
-- staff need to decide: the words, the name, the title.
drop function if exists public.staff_reports();
create or replace function public.staff_reports()
returns table (kind text, target text, preview text, author text, reports int, reasons text[], first_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  return query
    with open as (
      select r.kind, r.target, count(*)::int as n, array_remove(array_agg(r.reason order by r.created_at), null) as why, min(r.created_at) as first_at
      from public.reports r where not r.handled
      group by r.kind, r.target
    )
    select o.kind, o.target,
           case o.kind
             when 'comment'       then (select c.body from public.comments c where c.id::text = o.target)
             when 'room_post'     then (select x.body from public.room_posts x where x.id::text = o.target)
             when 'group_message' then (select x.body from public.group_messages x where x.id::text = o.target)
             when 'profile'       then (select concat_ws(' · ', p.display_name, p.bio, p.about) from public.profiles p where p.id::text = o.target)
             when 'group'         then (select g.name from public.groups g where g.id::text = o.target)
             when 'spark'         then (select concat_ws(' · ', s.title, s.place) from public.sparks s where s.id::text = o.target)
           end,
           (select coalesce(p.handle, p.display_name) from public.profiles p where p.id = public.report_author_any(o.kind, o.target)),
           o.n, o.why, o.first_at
    from open o
    order by o.n desc, o.first_at;
end;
$$;

-- As report_author, without the "is it yours to see" test: for the staff.
create or replace function public.report_author_any(p_kind text, p_target text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select case p_kind
    when 'comment'       then (select author_id from public.comments where id::text = p_target)
    when 'room_post'     then (select user_id from public.room_posts where id::text = p_target)
    when 'group_message' then (select user_id from public.group_messages where id::text = p_target)
    when 'profile'       then (select id from public.profiles where id::text = p_target)
    when 'group'         then (select created_by from public.groups where id::text = p_target)
    when 'spark'         then (select host_id from public.sparks where id::text = p_target)
  end;
$$;
revoke all on function public.report_author_any(text, text) from public, anon, authenticated;

create or replace function public.staff_report_settle(p_kind text, p_target text, p_remove boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  if coalesce(p_remove, false) then
    if p_kind = 'comment' then
      update public.comments set is_hidden = true where id::text = p_target;
    elsif p_kind = 'room_post' then
      delete from public.room_posts where id::text = p_target;
    elsif p_kind = 'group_message' then
      delete from public.group_messages where id::text = p_target;
    elsif p_kind = 'spark' then
      delete from public.sparks where id::text = p_target;
    elsif p_kind = 'group' then
      delete from public.groups where id::text = p_target;
    elsif p_kind = 'profile' then
      update public.profiles set bio = null, about = null where id::text = p_target;
      delete from public.profile_links where user_id::text = p_target;
      delete from public.profile_photos where user_id::text = p_target;
    else
      raise exception 'which kind?';
    end if;
  end if;
  update public.reports set handled = true where kind = p_kind and target = p_target and not handled;
  perform public.staff_note(case when coalesce(p_remove, false) then 'remove' else 'keep' end, 'report:' || p_kind, p_target, null);
end;
$$;

revoke execute on function public.staff_reports()                          from public, anon;
revoke execute on function public.staff_report_settle(text, text, boolean) from public, anon;
grant execute on function public.staff_reports()                           to authenticated;
grant execute on function public.staff_report_settle(text, text, boolean)  to authenticated;

-- ------------------------------------------------------------ client errors

create table if not exists public.client_errors (
  id          bigserial primary key,
  user_id     uuid references public.profiles on delete set null,
  message     text not null,
  stack       text,
  where_      text,
  platform    text,
  version     text,
  fatal       boolean not null default false,
  at          timestamptz not null default now()
);
create index if not exists client_errors_at on public.client_errors (at desc);
alter table public.client_errors enable row level security;
revoke all on public.client_errors from public, anon, authenticated;

-- Anyone may write one (a crash can come before sign-in); short, and at most
-- a hundred an hour across everyone, so a loop cannot fill the table.
create or replace function public.log_error(p_message text, p_stack text, p_where text, p_platform text, p_version text, p_fatal boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.client_errors where at > now() - interval '1 hour') >= 100 then return; end if;
  insert into public.client_errors (user_id, message, stack, where_, platform, version, fatal)
  values (auth.uid(), left(coalesce(nullif(btrim(p_message), ''), 'unknown'), 500), left(p_stack, 4000), left(p_where, 200),
          left(p_platform, 20), left(p_version, 40), coalesce(p_fatal, false));
end;
$$;

create or replace function public.admin_errors(p_limit int default 100)
returns table (id bigint, message text, stack text, where_ text, platform text, version text, fatal boolean, at timestamptz, who text)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  return query
    select e.id, e.message, e.stack, e.where_, e.platform, e.version, e.fatal, e.at, p.handle
    from public.client_errors e left join public.profiles p on p.id = e.user_id
    order by e.at desc
    limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;

create or replace function public.admin_errors_clear()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  delete from public.client_errors;
end;
$$;

revoke execute on function public.log_error(text, text, text, text, text, boolean) from public;
grant execute on function public.log_error(text, text, text, text, text, boolean)  to anon, authenticated;
revoke execute on function public.admin_errors(int)    from public, anon;
revoke execute on function public.admin_errors_clear() from public, anon;
grant execute on function public.admin_errors(int)     to authenticated;
grant execute on function public.admin_errors_clear()  to authenticated;

-- A month of errors is enough.
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'client-errors-prune';
    perform cron.schedule('client-errors-prune', '40 4 * * *', $q$delete from public.client_errors where at < now() - interval '30 days'$q$);
  end if;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('51_safety.sql');
  end if;
end $$;

-- afterhours — closing an account (52, after 42 to 51)
--
--   profiles.banned_at / banned_reason / banned_by
--   staff_ban(user, reason)   the staff close an account: nothing more can be
--                             written from it, its card disappears for everyone,
--                             its comments and posts are hidden, its upcoming
--                             sparks are called off, and its reports are settled.
--                             Staff cannot be banned (an admin takes the role first).
--   staff_unban(user)         opens it again; hidden content stays hidden.
--   account_status()          the app asks once at start: banned or not, and why.
--   admin_people_by(q, role)  as in 49, plus banned, and banned as a role filter.
--   admin_role_counts()       as in 49, plus banned.
--
-- The block is in the database, not only in the app: a trigger on every table a
-- person writes to refuses a banned author.

alter table public.profiles add column if not exists banned_at timestamptz;
alter table public.profiles add column if not exists banned_reason text;
alter table public.profiles add column if not exists banned_by uuid references public.profiles on delete set null;

create or replace function public.is_banned(p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select p.banned_at is not null from public.profiles p where p.id = p_user), false);
$$;
revoke execute on function public.is_banned(uuid) from public, anon;
grant execute on function public.is_banned(uuid) to authenticated;

-- ------------------------------------------------------------ the guard

create or replace function public.guard_banned()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and public.is_banned(auth.uid()) then
    raise exception 'this account is closed' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['comments', 'room_posts', 'group_messages', 'posts', 'sparks', 'groups', 'group_photos',
                           'group_members', 'group_invites', 'friendships', 'profile_links', 'profile_photos',
                           'rsvps', 'reports', 'events']
  loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop trigger if exists guard_banned on public.%I', t);
    execute format('create trigger guard_banned before insert or update on public.%I for each row execute function public.guard_banned()', t);
  end loop;
end $$;

-- The profile: a closed account cannot change its own words (the staff still can,
-- and seen() still stamps the clock).
create or replace function public.guard_banned_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.id = auth.uid() and old.banned_at is not null
     and (new.handle, new.display_name, new.bio, new.about) is distinct from (old.handle, old.display_name, old.bio, old.about) then
    raise exception 'this account is closed' using errcode = '42501';
  end if;
  -- Only the staff move the ban itself.
  if (new.banned_at, new.banned_reason, new.banned_by) is distinct from (old.banned_at, old.banned_reason, old.banned_by)
     and coalesce(current_setting('afterhours.ban', true), '') <> 'on' then
    raise exception 'only the staff close an account' using errcode = '42501';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_banned_profile on public.profiles;
create trigger guard_banned_profile before update on public.profiles
  for each row execute function public.guard_banned_profile();

-- ------------------------------------------------------------ what others see

-- As in 50, plus: a closed account shows to nobody but itself.
create or replace function public.card_visible(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select other = auth.uid()
      or (not public.is_blocked(other)
          and not public.is_banned(other)
          and (public.is_friend(other)
               or coalesce((select s.discoverable from public.profile_settings s
                            where s.user_id = other), true)));
$$;
revoke execute on function public.card_visible(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ the staff

create or replace function public.staff_ban(p_user uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.profiles%rowtype;
begin
  perform public.need_staff();
  select * into p from public.profiles where id = p_user;
  if p.id is null then raise exception 'no such person'; end if;
  if p.id = auth.uid() then raise exception 'not yourself'; end if;
  if p.is_admin or p.account_type in ('admin', 'community_manager') then
    raise exception 'staff cannot be banned; take the role first';
  end if;
  perform set_config('afterhours.ban', 'on', true);
  update public.profiles
     set banned_at = coalesce(banned_at, now()), banned_reason = left(nullif(btrim(p_reason), ''), 300), banned_by = auth.uid()
   where id = p_user;
  perform set_config('afterhours.ban', '', true);
  update public.comments set is_hidden = true where author_id = p_user and not is_hidden;
  update public.posts set is_hidden = true where author_id = p_user and not is_hidden;
  delete from public.sparks where host_id = p_user and starts_at > now();
  delete from public.friendships where requester_id = p_user and status = 'pending';
  update public.reports set handled = true where not handled and public.report_author_any(kind, target) = p_user;
  perform public.staff_note('ban', 'person', p_user::text, p_reason);
end;
$$;

create or replace function public.staff_unban(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  perform set_config('afterhours.ban', 'on', true);
  update public.profiles set banned_at = null, banned_reason = null, banned_by = null where id = p_user;
  perform set_config('afterhours.ban', '', true);
  perform public.staff_note('unban', 'person', p_user::text, null);
end;
$$;

-- From the reports pile: close the account behind a reported thing, and take the thing away.
create or replace function public.staff_ban_author(p_kind text, p_target text, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a uuid := public.report_author_any(p_kind, p_target);
begin
  perform public.need_staff();
  if a is null then raise exception 'nobody to ban'; end if;
  perform public.staff_report_settle(p_kind, p_target, true);
  perform public.staff_ban(a, coalesce(nullif(btrim(p_reason), ''), 'report: ' || p_kind));
end;
$$;
revoke execute on function public.staff_ban_author(text, text, text) from public, anon;
grant execute on function public.staff_ban_author(text, text, text) to authenticated;

create or replace function public.account_status()
returns table (banned boolean, reason text, at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select p.banned_at is not null, p.banned_reason, p.banned_at from public.profiles p where p.id = auth.uid();
$$;

revoke execute on function public.staff_ban(uuid, text) from public, anon;
revoke execute on function public.staff_unban(uuid)     from public, anon;
revoke execute on function public.account_status()      from public, anon;
grant execute on function public.staff_ban(uuid, text)  to authenticated;
grant execute on function public.staff_unban(uuid)      to authenticated;
grant execute on function public.account_status()       to authenticated;

-- ------------------------------------------------------------ people in the panel

drop function if exists public.admin_people_by(text, text);
create or replace function public.admin_people_by(p_query text, p_role text)
returns table (id uuid, handle text, display_name text, role text, created_at timestamptz, nights int, groups int, banned boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  q text := lower(btrim(coalesce(p_query, '')));
begin
  perform public.need_admin();
  return query
    select p.id, p.handle, p.display_name,
           case when p.is_admin then 'admin' else p.account_type end, p.created_at,
           (select count(*)::int from public.swipes s where s.user_id = p.id and s.direction = 'right'),
           (select count(*)::int from public.group_members m where m.user_id = p.id),
           p.banned_at is not null
    from public.profiles p
    where (q = '' or lower(coalesce(p.handle, '')) like '%' || q || '%' or lower(coalesce(p.display_name, '')) like '%' || q || '%')
      and (coalesce(p_role, '') = ''
           or (p_role = 'new' and p.created_at > now() - interval '7 days')
           or (p_role = 'banned' and p.banned_at is not null)
           or (p_role = 'admin' and p.is_admin)
           or (p_role not in ('new', 'admin', 'banned') and not p.is_admin and p.account_type = p_role))
    order by (p.is_admin or p.account_type <> 'user') desc, p.created_at desc
    limit 80;
end;
$$;
revoke execute on function public.admin_people_by(text, text) from public, anon;
grant execute on function public.admin_people_by(text, text) to authenticated;

create or replace function public.admin_role_counts()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_admin();
  return json_build_object(
    'all', (select count(*) from public.profiles),
    'dj', (select count(*) from public.profiles where account_type = 'dj' and not is_admin),
    'community_manager', (select count(*) from public.profiles where account_type = 'community_manager' and not is_admin),
    'admin', (select count(*) from public.profiles where is_admin),
    'new', (select count(*) from public.profiles where created_at > now() - interval '7 days'),
    'banned', (select count(*) from public.profiles where banned_at is not null));
end;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('52_bans.sql');
  end if;
end $$;

-- afterhours — trust (53, after 42 to 52)
--
--   dj pages       a page someone makes for themselves is checked by the staff before
--                  anyone else sees it (djs.verified); renaming it asks again; going back
--                  to normal user takes it down. staff_djs_waiting(), staff_dj_verify().
--   admins         an admin makes or unmakes another admin in the panel (admin_set_admin);
--                  the last admin can never be taken away, so the panel cannot end up
--                  without one.
--   notices        the other side is told: a hidden comment or post, a removed message,
--                  spark or group, a cleared profile, a new role, a dj page let through
--                  or taken down. my_notices(), notices_seen(). Written by triggers, so
--                  every path that does it (panel, reports, bans) says so.
--   limits         a ceiling on everything a person can write in a burst: requests,
--                  comments, room and group messages, groups, sparks, invite codes.
--   groups         nobody joins or is added to a group where a block stands between
--                  them and a member.

-- ------------------------------------------------------------ notices

create table if not exists public.notices (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles on delete cascade,
  kind        text not null check (kind in ('comment_hidden', 'post_hidden', 'removed', 'profile_cleared',
                                            'role', 'dj_verified', 'dj_hidden')),
  data        jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  seen_at     timestamptz
);
create index if not exists notices_user on public.notices (user_id, created_at desc) where seen_at is null;
alter table public.notices enable row level security;
revoke all on public.notices from public, anon, authenticated;

create or replace function public.notice(p_user uuid, p_kind text, p_data jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.notices (user_id, kind, data)
  select p_user, p_kind, coalesce(p_data, '{}') where p_user is not null;
$$;
revoke all on function public.notice(uuid, text, jsonb) from public, anon, authenticated;

create or replace function public.my_notices()
returns table (id bigint, kind text, data jsonb, created_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select n.id, n.kind, n.data, n.created_at from public.notices n
  where n.user_id = auth.uid() and n.seen_at is null
  order by n.created_at desc
  limit 20;
$$;

create or replace function public.notices_seen()
returns void
language sql
security definer
set search_path = public
as $$
  update public.notices set seen_at = now() where user_id = auth.uid() and seen_at is null;
$$;

revoke execute on function public.my_notices()   from public, anon;
revoke execute on function public.notices_seen() from public, anon;
grant execute on function public.my_notices()    to authenticated;
grant execute on function public.notices_seen()  to authenticated;

-- Hidden by someone else (the staff): the author is told, with the first words.
create or replace function public.notice_hidden()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  author uuid := case when TG_TABLE_NAME = 'comments' then new.author_id else new.author_id end;
begin
  if new.is_hidden and not old.is_hidden and auth.uid() is distinct from author then
    perform public.notice(author, case when TG_TABLE_NAME = 'comments' then 'comment_hidden' else 'post_hidden' end,
                          jsonb_build_object('text', left(new.body, 80)));
  end if;
  return new;
end;
$$;
drop trigger if exists notice_hidden on public.comments;
create trigger notice_hidden after update of is_hidden on public.comments for each row execute function public.notice_hidden();
drop trigger if exists notice_hidden on public.posts;
create trigger notice_hidden after update of is_hidden on public.posts for each row execute function public.notice_hidden();

-- Deleted by the staff (not by the author, not by a cascade from a deleted night or group).
create or replace function public.notice_removed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  author uuid;
  what text;
begin
  if auth.uid() is null or not public.is_staff() then return old; end if;
  if TG_TABLE_NAME = 'room_posts' then author := old.user_id; what := left(old.body, 80);
  elsif TG_TABLE_NAME = 'group_messages' then
    if old.kind <> 'say' then return old; end if;
    author := old.user_id; what := left(old.body, 80);
  elsif TG_TABLE_NAME = 'sparks' then author := old.host_id; what := old.title;
  elsif TG_TABLE_NAME = 'groups' then author := old.created_by; what := old.name;
  end if;
  if author is not null and author <> auth.uid() then
    perform public.notice(author, 'removed', jsonb_build_object('what', TG_TABLE_NAME, 'text', what));
  end if;
  return old;
end;
$$;
do $$
declare t text;
begin
  foreach t in array array['room_posts', 'group_messages', 'sparks', 'groups'] loop
    execute format('drop trigger if exists notice_removed on public.%I', t);
    execute format('create trigger notice_removed after delete on public.%I for each row execute function public.notice_removed()', t);
  end loop;
end $$;

-- The profile: words cleared by the staff, or a new role given.
create or replace function public.notice_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or auth.uid() = new.id then return new; end if;
  if (old.bio is not null or old.about is not null) and new.bio is null and new.about is null then
    perform public.notice(new.id, 'profile_cleared', '{}');
  end if;
  if new.account_type is distinct from old.account_type or new.is_admin is distinct from old.is_admin then
    perform public.notice(new.id, 'role', jsonb_build_object('role', case when new.is_admin then 'admin' else new.account_type end));
  end if;
  return new;
end;
$$;
drop trigger if exists notice_profile on public.profiles;
create trigger notice_profile after update on public.profiles for each row execute function public.notice_profile();

-- ------------------------------------------------------------ dj pages

alter table public.djs add column if not exists verified boolean not null default true;
alter table public.djs add column if not exists verified_at timestamptz;

-- A page made or renamed by its owner waits for the staff.
create or replace function public.guard_dj_verified()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_staff() then return new; end if;
  if TG_OP = 'INSERT' then
    if new.owner_id is not null then new.verified := false; new.verified_at := null; end if;
  elsif new.verified is distinct from old.verified
        or (new.owner_id is not null and new.name is distinct from old.name) then
    new.verified := false;
    new.verified_at := null;
  end if;
  return new;
end;
$$;
drop trigger if exists guard_dj_verified on public.djs;
create trigger guard_dj_verified before insert or update on public.djs
  for each row execute function public.guard_dj_verified();

-- Readers see checked pages; the owner and the staff see theirs too.
drop policy if exists djs_read on public.djs;
create policy djs_read on public.djs for select
  using (verified or owner_id = auth.uid() or public.is_staff());
drop policy if exists dj_sets_read on public.dj_sets;
create policy dj_sets_read on public.dj_sets for select
  using (exists (select 1 from public.djs d where d.id = dj_sets.dj_id and (d.verified or d.owner_id = auth.uid() or public.is_staff())));

-- Back to normal user: the page goes down with the role.
create or replace function public.dj_role_gone()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.account_type = 'dj' and new.account_type <> 'dj' then
    update public.djs set verified = false, verified_at = null where owner_id = new.id and verified;
  end if;
  return new;
end;
$$;
drop trigger if exists dj_role_gone on public.profiles;
create trigger dj_role_gone after update of account_type on public.profiles
  for each row execute function public.dj_role_gone();

create or replace function public.staff_djs_waiting()
returns table (id uuid, slug text, name text, genre text, bio text, photo_url text, owner text, owner_role text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  return query
    select d.id, d.slug, d.name, d.genre, d.bio, d.photo_url, coalesce(p.handle, p.display_name), p.account_type, d.created_at
    from public.djs d join public.profiles p on p.id = d.owner_id
    where not d.verified and p.account_type = 'dj'
    order by d.created_at;
end;
$$;

create or replace function public.staff_dj_verify(p_dj uuid, p_ok boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.djs%rowtype;
begin
  perform public.need_staff();
  select * into d from public.djs where id = p_dj;
  if d.id is null then raise exception 'no such dj'; end if;
  update public.djs set verified = coalesce(p_ok, false), verified_at = case when p_ok then now() end where id = p_dj;
  perform public.notice(d.owner_id, case when p_ok then 'dj_verified' else 'dj_hidden' end, jsonb_build_object('name', d.name));
  perform public.staff_note(case when p_ok then 'verify' else 'turn down' end, 'dj', p_dj::text, d.name);
end;
$$;

revoke execute on function public.staff_djs_waiting()              from public, anon;
revoke execute on function public.staff_dj_verify(uuid, boolean)   from public, anon;
grant execute on function public.staff_djs_waiting()               to authenticated;
grant execute on function public.staff_dj_verify(uuid, boolean)    to authenticated;

-- ------------------------------------------------------------ admins

-- ok · self (not on yourself) · last (the last admin stays) · none
create or replace function public.admin_set_admin(p_user uuid, p_on boolean)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  who public.profiles%rowtype;
begin
  perform public.need_admin();
  select * into who from public.profiles where id = p_user;
  if who.id is null then return 'none'; end if;
  if who.id = auth.uid() then return 'self'; end if;
  if who.banned_at is not null then return 'banned'; end if;
  if not coalesce(p_on, false) and (select count(*) from public.profiles where is_admin) <= 1 then return 'last'; end if;
  perform set_config('afterhours.account_type', 'on', true);
  update public.profiles
     set is_admin = coalesce(p_on, false),
         account_type = case when p_on then 'admin' when account_type = 'admin' then 'user' else account_type end
   where id = p_user;
  perform set_config('afterhours.account_type', '', true);
  perform public.staff_note(case when p_on then 'make admin' else 'unmake admin' end, 'person', p_user::text, coalesce(who.handle, who.display_name));
  return 'ok';
end;
$$;
revoke execute on function public.admin_set_admin(uuid, boolean) from public, anon;
grant execute on function public.admin_set_admin(uuid, boolean) to authenticated;

-- Whatever path it takes, the last admin is never taken away.
create or replace function public.guard_last_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.is_admin and not new.is_admin
     and not exists (select 1 from public.profiles where is_admin and id <> old.id) then
    raise exception 'the last admin stays an admin';
  end if;
  return new;
end;
$$;
drop trigger if exists guard_last_admin on public.profiles;
create trigger guard_last_admin before update of is_admin on public.profiles
  for each row execute function public.guard_last_admin();

-- ------------------------------------------------------------ limits

-- TG_ARGV: the column holding the author, the window, the most in it.
create or replace function public.guard_rate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  col  text := TG_ARGV[0];
  win  interval := TG_ARGV[1]::interval;
  most int := TG_ARGV[2]::int;
  who  uuid;
  n    int;
begin
  if auth.uid() is null or public.is_staff() then return new; end if;
  execute format('select ($1).%I', col) using new into who;
  if who is distinct from auth.uid() then return new; end if;
  execute format('select count(*) from public.%I where %I = $1 and created_at > now() - $2', TG_TABLE_NAME, col)
    using who, win into n;
  if n >= most then
    raise exception 'slow down: too many in a short time' using errcode = '54000';
  end if;
  return new;
end;
$$;

do $$
declare
  r record;
begin
  for r in select * from (values
    ('friendships',    'requester_id', '1 day',  '40'),
    ('comments',       'author_id',    '1 hour', '30'),
    ('room_posts',     'user_id',      '1 hour', '60'),
    ('group_messages', 'user_id',      '1 hour', '120'),
    ('groups',         'created_by',   '1 day',  '10'),
    ('sparks',         'host_id',      '1 day',  '10'),
    ('group_invites',  'created_by',   '1 day',  '20')
  ) v(tbl, col, win, most)
  loop
    if to_regclass('public.' || r.tbl) is null then continue; end if;
    if not exists (select 1 from information_schema.columns
                   where table_schema = 'public' and table_name = r.tbl and column_name in (r.col))
       or not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = r.tbl and column_name = 'created_at') then
      continue;
    end if;
    execute format('drop trigger if exists guard_rate on public.%I', r.tbl);
    execute format('create trigger guard_rate before insert on public.%I for each row execute function public.guard_rate(%L, %L, %L)',
                   r.tbl, r.col, r.win, r.most);
  end loop;
end $$;

-- ------------------------------------------------------------ groups and blocks

create or replace function public.guard_group_blocks()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.group_members m join public.blocks b
               on (b.blocker_id = m.user_id and b.blocked_id = new.user_id)
               or (b.blocker_id = new.user_id and b.blocked_id = m.user_id)
             where m.group_id = new.group_id) then
    raise exception 'not possible in this group' using errcode = '42501';
  end if;
  return new;
end;
$$;
do $$ begin
  if to_regclass('public.blocks') is not null then
    drop trigger if exists guard_group_blocks on public.group_members;
    create trigger guard_group_blocks before insert on public.group_members
      for each row execute function public.guard_group_blocks();
  end if;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('53_trust.sql');
  end if;
end $$;

-- afterhours — upkeep (54, after 48 and 51 to 53)
--
--   guests        a guest account nobody has opened for 30 days is deleted, every night
--                 (guests_prune). Their comments stay, signed "someone", as on delete.
--   staff alerts  when something starts waiting in the panel (a report, a reported post,
--                 a night sent in, a dj page), every admin and community manager gets a
--                 push (kind staff, in 48) with how many things wait; at most one an hour
--                 each, so the 24-hour promise in the terms can be kept.
--   staff_waiting()  the same count, for the panel and the push.

-- ------------------------------------------------------------ guests

create or replace function public.guests_prune(p_days int default 30)
returns int
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  gone int := 0;
begin
  -- Supabase marks guests in auth.users.is_anonymous; without that column there is nothing to do.
  if not exists (select 1 from information_schema.columns
                 where table_schema = 'auth' and table_name = 'users' and column_name = 'is_anonymous') then
    return 0;
  end if;
  create temp table if not exists _guests_gone (id uuid) on commit drop;
  truncate _guests_gone;
  execute format($q$
    insert into _guests_gone
    select u.id from auth.users u left join public.profiles p on p.id = u.id
    where u.is_anonymous
      and greatest(u.created_at, coalesce(u.last_sign_in_at, u.created_at), coalesce(p.last_seen_at, u.created_at)) < now() - interval '%s days'
  $q$, greatest(coalesce(p_days, 30), 7));
  update public.comments set author_id = null, author_name = 'someone'
   where author_id in (select id from _guests_gone);
  delete from auth.users where id in (select id from _guests_gone);
  get diagnostics gone = row_count;
  return gone;
end;
$$;
revoke all on function public.guests_prune(int) from public, anon, authenticated;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'afterhours-guests-prune';
    perform cron.schedule('afterhours-guests-prune', '50 4 * * *', $q$select public.guests_prune(30)$q$);
  end if;
end $$;

-- ------------------------------------------------------------ what waits for the staff

create or replace function public.staff_waiting_count()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select (select count(distinct (kind, target))::int from public.reports where not handled)
       + coalesce((select count(distinct post_id)::int from public.post_reports where not handled), 0)
       + (select count(*)::int from public.events where review = 'pending')
       + (select count(*)::int from public.djs d join public.profiles p on p.id = d.owner_id where not d.verified and p.account_type = 'dj');
$$;
revoke all on function public.staff_waiting_count() from public, anon, authenticated;

create or replace function public.staff_waiting()
returns int
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  return public.staff_waiting_count();
end;
$$;
revoke execute on function public.staff_waiting() from public, anon;
grant execute on function public.staff_waiting() to authenticated;

-- One push an hour at most per staff member, saying how many things wait.
create or replace function public.staff_ping()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
  n int;
begin
  if to_regprocedure('public.push_enqueue(uuid, text, text, jsonb)') is null then return; end if;
  n := public.staff_waiting_count();
  if n = 0 then return; end if;
  for s in select id from public.profiles where (is_admin or account_type = 'community_manager') and banned_at is null loop
    perform public.push_enqueue(s.id, 'staff', 'staff:' || s.id || ':' || to_char(date_trunc('hour', now()), 'YYYYMMDDHH24'),
                                jsonb_build_object('n', n::text, 'url', '/panel'));
  end loop;
end;
$$;
revoke all on function public.staff_ping() from public, anon, authenticated;

create or replace function public.staff_alert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.staff_ping();
  return null;
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['reports', 'post_reports', 'djs'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop trigger if exists staff_alert on public.%I', t);
    execute format('create trigger staff_alert after insert on public.%I for each statement execute function public.staff_alert()', t);
  end loop;
end $$;

-- Nights sent in: only those that arrive waiting.
create or replace function public.staff_alert_night()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.review = 'pending' then
    perform public.staff_ping();
  end if;
  return null;
end;
$$;
drop trigger if exists staff_alert on public.events;
create trigger staff_alert after insert on public.events
  for each row execute function public.staff_alert_night();

do $$ begin
  if to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('54_upkeep.sql');
  end if;
end $$;

-- afterhours - ONE-SHOT: repair text that was broken on its way through the clipboard
--
-- pbcopy without a UTF-8 locale read the files as Mac Roman, so every non-ASCII
-- letter that reached the SQL editor arrived as two or three wrong ones
-- (one Turkish letter became two odd ones, an emoji four). Where text came in that way (the test
-- groups, their chat, the fake people), this turns it back: each character is
-- read as the Mac Roman byte it stood for, and the bytes as UTF-8. Text that does
-- not decode that way (real German or Turkish words) is left exactly as it is.
--
-- This file is plain ASCII on purpose, so the clipboard cannot break it too.
-- Safe to run twice: repaired text no longer decodes and stays as it is.

create or replace function pg_temp.unmangle(t text)
returns text
language plpgsql
immutable
as $$
declare
  mac int[] := array[196,197,199,201,209,214,220,225,224,226,228,227,229,231,233,232,234,235,237,236,238,239,241,243,242,244,246,245,250,249,251,252,8224,176,162,163,167,8226,182,223,174,169,8482,180,168,8800,198,216,8734,177,8804,8805,165,181,8706,8721,8719,960,8747,170,186,937,230,248,191,161,172,8730,402,8776,8710,171,187,8230,160,192,195,213,338,339,8211,8212,8220,8221,8216,8217,247,9674,255,376,8260,8364,8249,8250,64257,64258,8225,183,8218,8222,8240,194,202,193,203,200,205,206,207,204,211,212,63743,210,218,219,217,305,710,732,175,728,729,730,184,733,731,711];
  b bytea := ''::bytea;
  c int;
  i int;
  k int;
begin
  if t is null or t ~ '^[[:ascii:]]*$' then return t; end if;
  for i in 1 .. length(t) loop
    c := ascii(substr(t, i, 1));
    if c < 128 then
      b := b || set_byte('\x00'::bytea, 0, c);
    else
      k := array_position(mac, c);
      if k is null then return t; end if;
      b := b || set_byte('\x00'::bytea, 0, 127 + k);
    end if;
  end loop;
  return convert_from(b, 'UTF8');
exception when others then
  return t;
end;
$$;

do $$
declare
  r record;
  n int;
  total int := 0;
begin
  for r in select * from (values
    ('group_messages', 'body'), ('groups', 'name'), ('groups', 'emoji'),
    ('profiles', 'display_name'), ('profiles', 'bio'), ('profiles', 'about'),
    ('posts', 'body'), ('sparks', 'title'), ('sparks', 'place'),
    ('room_posts', 'body'), ('comments', 'body'), ('comments', 'author_name')
  ) v(tbl, col)
  loop
    if to_regclass('public.' || r.tbl) is null then continue; end if;
    execute format('update public.%I set %I = pg_temp.unmangle(%I) where %I is distinct from pg_temp.unmangle(%I)',
                   r.tbl, r.col, r.col, r.col, r.col);
    get diagnostics n = row_count;
    if n > 0 then raise notice '%.%: % repaired', r.tbl, r.col, n; end if;
    total := total + n;
  end loop;
  raise notice 'repaired % values in all', total;
end $$;

