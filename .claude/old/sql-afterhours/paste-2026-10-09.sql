-- afterhours — paste of 09.10.2026: likes and comments on posts (55) and what it touches in 45, 48, 51, 53.
-- Every part is safe to run again.

-- afterhours — posts: a photo and a few words for your friends (45)
--
-- The + on the yours tab makes a post: a photo (from the phone, into your own
-- folder of the photos bucket), a few words, and if you like the night it was
-- about. Your friends see it in their yours tab, newest first; so do you.
--
--   posts                 author, text, photo, night, hidden (by the staff)
--   post_reports          who reported what and why; the staff look at them
--   post_create(…)        an account (not a guest), at most 20 a day
--   post_delete(id)       the author, or the staff
--   posts_feed(before, n) you and your confirmed friends, a page at a time
--   post_report(id, why)  anyone who can see it; once per person
--   staff_posts_reported() / staff_post_hide(id, hidden)   the staff
--
-- A report is the store requirement for anything people write: there must be a
-- way to flag it and someone who looks.

create table if not exists public.posts (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null references public.profiles on delete cascade,
  body        text not null default '' check (length(body) <= 500),
  photo_path  text,
  event_id    uuid references public.events on delete set null,
  is_hidden   boolean not null default false,
  created_at  timestamptz not null default now(),
  constraint posts_something check (length(btrim(body)) > 0 or photo_path is not null)
);
create index if not exists posts_author_idx on public.posts (author_id, created_at desc);
create index if not exists posts_recent_idx on public.posts (created_at desc);

create table if not exists public.post_reports (
  post_id     uuid not null references public.posts on delete cascade,
  reporter_id uuid not null references public.profiles on delete cascade,
  reason      text check (reason is null or length(reason) <= 300),
  created_at  timestamptz not null default now(),
  handled     boolean not null default false,
  primary key (post_id, reporter_id)
);

alter table public.posts enable row level security;
alter table public.post_reports enable row level security;
revoke all on public.posts, public.post_reports from public, anon, authenticated;

create or replace function public.can_see_post(p_author uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_author = auth.uid() or public.is_friend(p_author);
$$;
revoke all on function public.can_see_post(uuid) from public, anon;

create or replace function public.post_create(p_body text, p_photo text, p_event uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  r uuid;
begin
  perform public.need_account();
  if length(coalesce(p_body, '')) > 500 then raise exception 'at most 500 characters'; end if;
  if length(btrim(coalesce(p_body, ''))) = 0 and p_photo is null then raise exception 'a photo or a few words'; end if;
  if p_photo is not null and p_photo not like auth.uid()::text || '/%' then raise exception 'not your file'; end if;
  if p_event is not null and not exists (select 1 from public.events where id = p_event) then raise exception 'no such night'; end if;
  if (select count(*) from public.posts where author_id = auth.uid() and created_at > now() - interval '1 day') >= 20 then
    raise exception 'twenty today is enough; more tomorrow';
  end if;
  insert into public.posts (author_id, body, photo_path, event_id)
  values (auth.uid(), btrim(coalesce(p_body, '')), p_photo, p_event)
  returning id into r;
  return r;
end;
$$;

-- Returns the photo path, so the app can remove the file.
create or replace function public.post_delete(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.posts%rowtype;
begin
  select * into p from public.posts where id = p_id;
  if p.id is null then return null; end if;
  if p.author_id <> auth.uid() and not public.is_staff() then raise exception 'not your post' using errcode = '42501'; end if;
  delete from public.posts where id = p_id;
  if p.author_id <> auth.uid() then perform public.staff_note('delete', 'post', p_id::text, left(p.body, 80)); end if;
  return p.photo_path;
end;
$$;

-- 55 adds columns; a second run of the setup meets that shape first.
drop function if exists public.posts_feed(timestamptz, int);
create or replace function public.posts_feed(p_before timestamptz default null, p_limit int default 20)
returns table (id uuid, author_id uuid, handle text, name text, body text, photo_path text,
               event_slug text, event_title text, created_at timestamptz, mine boolean)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.author_id, pr.handle, pr.display_name, p.body, p.photo_path, e.slug, e.title, p.created_at,
         p.author_id = auth.uid()
  from public.posts p
  join public.profiles pr on pr.id = p.author_id
  left join public.events e on e.id = p.event_id
  where auth.uid() is not null
    and not p.is_hidden
    and public.can_see_post(p.author_id)
    and (p_before is null or p.created_at < p_before)
  order by p.created_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;

create or replace function public.post_report(p_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a uuid;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select author_id into a from public.posts where id = p_id;
  if a is null or not public.can_see_post(a) then raise exception 'no such post'; end if;
  if a = auth.uid() then raise exception 'your own post: delete it instead'; end if;
  insert into public.post_reports (post_id, reporter_id, reason)
  values (p_id, auth.uid(), left(nullif(btrim(p_reason), ''), 300))
  on conflict (post_id, reporter_id) do nothing;
end;
$$;

create or replace function public.staff_posts_reported()
returns table (id uuid, body text, photo_path text, author text, reports int, reasons text[], is_hidden boolean, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  return query
    select p.id, p.body, p.photo_path, coalesce(pr.handle, pr.display_name), count(r.*)::int,
           array_remove(array_agg(r.reason), null), p.is_hidden, p.created_at
    from public.post_reports r
    join public.posts p on p.id = r.post_id
    join public.profiles pr on pr.id = p.author_id
    where not r.handled
    group by p.id, pr.handle, pr.display_name
    order by count(r.*) desc, max(r.created_at) desc;
end;
$$;

-- Hiding settles the reports; showing again (a wrong report) settles them too.
create or replace function public.staff_post_hide(p_id uuid, p_hidden boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  update public.posts set is_hidden = coalesce(p_hidden, true) where id = p_id;
  update public.post_reports set handled = true where post_id = p_id;
  perform public.staff_note(case when coalesce(p_hidden, true) then 'hide' else 'show' end, 'post', p_id::text, null);
end;
$$;

-- The panel counts what waits.
create or replace function public.admin_overview()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  return json_build_object(
    'people', (select count(*) from public.profiles),
    'people_week', (select count(*) from public.profiles where created_at > now() - interval '7 days'),
    'managers', (select count(*) from public.profiles where account_type = 'community_manager'),
    'djs', (select count(*) from public.profiles where account_type = 'dj'),
    'nights_ahead', (select count(*) from public.events where is_published and starts_at > now()),
    'nights_staff', (select count(*) from public.events where source = 'staff'),
    'venues', (select count(*) from public.venues),
    'comments_week', (select count(*) from public.comments where created_at > now() - interval '7 days'),
    'pending', (select count(*) from public.events where review = 'pending'),
    'reported', (select count(distinct post_id) from public.post_reports where not handled),
    'feedback_open', case when public.is_admin() then (select count(*) from public.feedback where not handled) end
  );
end;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'post_create(text, text, uuid)', 'post_delete(uuid)', 'posts_feed(timestamptz, int)',
    'post_report(uuid, text)', 'staff_posts_reported()', 'staff_post_hide(uuid, boolean)', 'admin_overview()'
  ] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('45_posts.sql');
  end if;
end $$;

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
  if to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('48_group_push.sql');
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
  kind         text not null check (kind in ('comment', 'room_post', 'group_message', 'profile', 'group', 'spark', 'post_comment')),
  target       text not null check (length(target) between 1 and 64),
  reason       text check (reason is null or length(reason) <= 300),
  handled      boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (reporter_id, kind, target)
);
create index if not exists reports_open on public.reports (kind, target) where not handled;
alter table public.reports enable row level security;
revoke all on public.reports from public, anon, authenticated;

-- Comments on posts live in 55; until it ran these answer null.
create or replace function public.post_comment_body(p_id text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare r text;
begin
  if to_regclass('public.post_comments') is null then return null; end if;
  execute 'select body from public.post_comments where id::text = $1' into r using p_id;
  return r;
end;
$$;
create or replace function public.post_comment_author(p_id text)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare r uuid;
begin
  if to_regclass('public.post_comments') is null then return null; end if;
  execute 'select author_id from public.post_comments where id::text = $1' into r using p_id;
  return r;
end;
$$;
revoke all on function public.post_comment_body(text) from public, anon, authenticated;
revoke all on function public.post_comment_author(text) from public, anon, authenticated;

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
  elsif p_kind = 'post_comment' and to_regclass('public.post_comments') is not null then
    execute 'select c.author_id from public.post_comments c join public.posts p on p.id = c.post_id
             where c.id::text = $1 and public.can_see_post(p.author_id)' into a using p_target;
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
             when 'post_comment'  then public.post_comment_body(o.target)
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
    when 'post_comment'  then public.post_comment_author(p_target)
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
    elsif p_kind = 'post_comment' then
      execute 'update public.post_comments set is_hidden = true where id::text = $1' using p_target;
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
  author uuid := new.author_id;
begin
  if new.is_hidden and not old.is_hidden and auth.uid() is distinct from author then
    perform public.notice(author, case when TG_TABLE_NAME in ('comments', 'post_comments') then 'comment_hidden' else 'post_hidden' end,
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

-- afterhours — likes and comments on posts (55, after 45, 48, 51 to 53)
--
--   post_likes            one per person and post
--   post_comments         up to 300 characters; hidden by the staff, deleted by their
--                         author or the author of the post
--   post_like(id, on)     a double tap or the heart; anyone who can see the post
--   post_likers(id)       who liked it, newest first (blocked people left out)
--   post_comment_add(id, body) / post_comment_delete(id) / post_comments_of(id)
--   posts_feed(…)         as in 45, plus likes, liked (by you), comments and the
--                         first two comments, so the card needs one read
--
-- Whoever sees the post (its author and their confirmed friends) may like and
-- comment. The author is told by push (post_like, post_comment in 48). Reports
-- (51), bans (52), notices and limits (53) cover comments too.

create table if not exists public.post_likes (
  post_id     uuid not null references public.posts on delete cascade,
  user_id     uuid not null references public.profiles on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (post_id, user_id)
);
create index if not exists post_likes_user on public.post_likes (user_id);

create table if not exists public.post_comments (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references public.posts on delete cascade,
  author_id   uuid not null references public.profiles on delete cascade,
  body        text not null check (length(btrim(body)) between 1 and 300),
  is_hidden   boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists post_comments_post on public.post_comments (post_id, created_at);

alter table public.post_likes enable row level security;
alter table public.post_comments enable row level security;
revoke all on public.post_likes, public.post_comments from public, anon, authenticated;

-- Reports may name a comment on a post (the table in 51 predates it).
alter table public.reports drop constraint if exists reports_kind_check;
alter table public.reports add constraint reports_kind_check
  check (kind in ('comment', 'room_post', 'group_message', 'profile', 'group', 'spark', 'post_comment'));

create or replace function public.need_post(p_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  a uuid;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  select author_id into a from public.posts where id = p_id and not is_hidden;
  if a is null or not public.can_see_post(a) then raise exception 'no such post'; end if;
  return a;
end;
$$;
revoke all on function public.need_post(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------ likes

create or replace function public.post_like(p_id uuid, p_on boolean)
returns int
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_post(p_id);
  if coalesce(p_on, true) then
    insert into public.post_likes (post_id, user_id) values (p_id, auth.uid()) on conflict do nothing;
  else
    delete from public.post_likes where post_id = p_id and user_id = auth.uid();
  end if;
  return (select count(*)::int from public.post_likes where post_id = p_id);
end;
$$;

create or replace function public.post_likers(p_id uuid)
returns table (id uuid, handle text, name text, mine boolean, at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_post(p_id);
  return query
    select p.id, p.handle, p.display_name, p.id = auth.uid(), l.created_at
    from public.post_likes l join public.profiles p on p.id = l.user_id
    where l.post_id = p_id and (p.id = auth.uid() or (not public.is_blocked(p.id) and p.banned_at is null))
    order by l.created_at desc
    limit 200;
end;
$$;

-- ------------------------------------------------------------ comments

create or replace function public.post_comment_add(p_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  r uuid;
begin
  perform public.need_account();
  perform public.need_post(p_id);
  if length(btrim(coalesce(p_body, ''))) = 0 then raise exception 'a few words'; end if;
  if length(p_body) > 300 then raise exception 'at most 300 characters'; end if;
  insert into public.post_comments (post_id, author_id, body) values (p_id, auth.uid(), btrim(p_body)) returning id into r;
  return r;
end;
$$;

-- Your own comment, or any comment under your post.
create or replace function public.post_comment_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  c record;
begin
  select pc.author_id, p.author_id as owner into c
  from public.post_comments pc join public.posts p on p.id = pc.post_id where pc.id = p_id;
  if c is null then return; end if;
  if auth.uid() is distinct from c.author_id and auth.uid() is distinct from c.owner and not public.is_staff() then
    raise exception 'not yours' using errcode = '42501';
  end if;
  delete from public.post_comments where id = p_id;
end;
$$;

create or replace function public.post_comments_of(p_id uuid)
returns table (id uuid, author_id uuid, handle text, name text, body text, created_at timestamptz, mine boolean, can_delete boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  owner uuid;
begin
  owner := public.need_post(p_id);
  return query
    select c.id, c.author_id, p.handle, p.display_name, c.body, c.created_at,
           c.author_id = auth.uid(), c.author_id = auth.uid() or owner = auth.uid()
    from public.post_comments c join public.profiles p on p.id = c.author_id
    where c.post_id = p_id and not c.is_hidden
      and (c.author_id = auth.uid() or (not public.is_blocked(c.author_id) and p.banned_at is null))
    order by c.created_at
    limit 300;
end;
$$;

revoke execute on function public.post_like(uuid, boolean)       from public, anon;
revoke execute on function public.post_likers(uuid)              from public, anon;
revoke execute on function public.post_comment_add(uuid, text)   from public, anon;
revoke execute on function public.post_comment_delete(uuid)      from public, anon;
revoke execute on function public.post_comments_of(uuid)         from public, anon;
grant execute on function public.post_like(uuid, boolean)        to authenticated;
grant execute on function public.post_likers(uuid)               to authenticated;
grant execute on function public.post_comment_add(uuid, text)    to authenticated;
grant execute on function public.post_comment_delete(uuid)       to authenticated;
grant execute on function public.post_comments_of(uuid)          to authenticated;

-- ------------------------------------------------------------ the feed

drop function if exists public.posts_feed(timestamptz, int);
create or replace function public.posts_feed(p_before timestamptz default null, p_limit int default 20)
returns table (id uuid, author_id uuid, handle text, name text, body text, photo_path text,
               event_slug text, event_title text, created_at timestamptz, mine boolean,
               likes int, liked boolean, comments int, first_comments jsonb)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.author_id, pr.handle, pr.display_name, p.body, p.photo_path, e.slug, e.title, p.created_at,
         p.author_id = auth.uid(),
         (select count(*)::int from public.post_likes l where l.post_id = p.id),
         exists (select 1 from public.post_likes l where l.post_id = p.id and l.user_id = auth.uid()),
         (select count(*)::int from public.post_comments c where c.post_id = p.id and not c.is_hidden),
         coalesce((select jsonb_agg(jsonb_build_object('who', coalesce(x.handle, x.display_name), 'text', x.body) order by x.created_at)
                   from (select c.body, c.created_at, q.handle, q.display_name
                         from public.post_comments c join public.profiles q on q.id = c.author_id
                         where c.post_id = p.id and not c.is_hidden
                           and (c.author_id = auth.uid() or (not public.is_blocked(c.author_id) and q.banned_at is null))
                         order by c.created_at limit 2) x), '[]'::jsonb)
  from public.posts p
  join public.profiles pr on pr.id = p.author_id
  left join public.events e on e.id = p.event_id
  where auth.uid() is not null
    and not p.is_hidden
    and public.can_see_post(p.author_id)
    and (p_before is null or p.created_at < p_before)
  order by p.created_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;
revoke execute on function public.posts_feed(timestamptz, int) from public, anon;
grant execute on function public.posts_feed(timestamptz, int) to authenticated;

-- ------------------------------------------------------------ guards, notices, push

do $$
declare t text;
begin
  foreach t in array array['post_likes', 'post_comments'] loop
    if to_regprocedure('public.guard_banned()') is not null then
      execute format('drop trigger if exists guard_banned on public.%I', t);
      execute format('create trigger guard_banned before insert or update on public.%I for each row execute function public.guard_banned()', t);
    end if;
  end loop;
  if to_regprocedure('public.guard_rate()') is not null then
    drop trigger if exists guard_rate on public.post_comments;
    create trigger guard_rate before insert on public.post_comments
      for each row execute function public.guard_rate('author_id', '1 hour', '60');
  end if;
  if to_regprocedure('public.notice_hidden()') is not null then
    drop trigger if exists notice_hidden on public.post_comments;
    create trigger notice_hidden after update of is_hidden on public.post_comments
      for each row execute function public.notice_hidden();
  end if;
end $$;

create or replace function public.push_post_social()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  p public.posts%rowtype;
  -- the two tables name the person differently; read it by name
  who uuid := coalesce(to_jsonb(new) ->> 'user_id', to_jsonb(new) ->> 'author_id')::uuid;
begin
  if to_regprocedure('public.push_enqueue(uuid, text, text, jsonb)') is null then return null; end if;
  select * into p from public.posts where id = new.post_id;
  if p.author_id is null or p.author_id = who then return null; end if;
  if TG_TABLE_NAME = 'post_likes' then
    perform public.push_enqueue(p.author_id, 'post_like', format('post_like:%s:%s', p.id, who),
      jsonb_build_object('name', public.push_name(who), 'text', left(coalesce(nullif(p.body, ''), '📷'), 80), 'url', '/yours'));
  else
    perform public.push_enqueue(p.author_id, 'post_comment', format('post_comment:%s', to_jsonb(new) ->> 'id'),
      jsonb_build_object('name', public.push_name(who), 'text', left(to_jsonb(new) ->> 'body', 80), 'url', '/yours'));
  end if;
  return null;
end;
$$;
do $$ begin
  if to_regprocedure('public.push_name(uuid)') is not null then
    drop trigger if exists push_post_social on public.post_likes;
    create trigger push_post_social after insert on public.post_likes for each row execute function public.push_post_social();
    drop trigger if exists push_post_social on public.post_comments;
    create trigger push_post_social after insert on public.post_comments for each row execute function public.push_post_social();
  end if;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('55_post_social.sql');
  end if;
end $$;

