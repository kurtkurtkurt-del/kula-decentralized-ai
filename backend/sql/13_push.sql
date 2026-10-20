-- pasaport — push notifications: a fixed sentence and a name, never the words
-- The rule from the start: a push carries a sentence chosen here and a name, never a
-- message, never a project's text beyond its title ("Ayşe started a project night").
--   kinds     friend_request · friend_accepted (notify_friends)
--             call (someone in your waves started a night) · call_in (someone is in on
--             yours) (notify_calls)
--             coop_night (a coop you are in chose tonight's project) (notify_coops)
--             dm (notify_dms) · card (your card from last night is in) (notify_cards)
-- The path: a trigger writes one row to push_outbox, unless the person turned that kind
-- off; a unique key keeps the same thing from going out twice. A trigger on push_outbox
-- hands due rows to the Expo push service through pg_net; without pg_net (the tests) rows
-- wait in the outbox, unsent. Quiet hours: between 00:00 and 09:00 on the phone, everything
-- but a card waits until 09:00 (a card is the morning itself).
-- The phone registers its token with push_register(); a token belongs to one account at
-- a time and carries the app language and the time zone of the phone.

do $$ begin
  create extension if not exists pg_net;
exception when others then
  raise notice 'pg_net is not available here; push rows stay in the outbox';
end $$;

create table if not exists public.push_tokens (
  token       text primary key check (token ~ '^Expo(nent)?PushToken\[.+\]$'),
  user_id     uuid not null references public.profiles on delete cascade,
  platform    text not null check (platform in ('ios', 'android')),
  lang        text not null default 'en' check (lang in ('en', 'de', 'tr')),
  tz          text not null default 'Europe/Berlin',
  updated_at  timestamptz not null default now()
);
create index if not exists push_tokens_user_idx on public.push_tokens (user_id, updated_at desc);
create table if not exists public.push_outbox (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles on delete cascade,
  kind        text not null check (kind in ('friend_request', 'friend_accepted', 'call', 'call_in', 'coop_night', 'dm', 'card')),
  key         text not null unique,
  data        jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  send_after  timestamptz not null default now(),
  sent_at     timestamptz,
  request_id  bigint,
  tokens      text[]
);
create index if not exists push_outbox_due_idx on public.push_outbox (send_after) where sent_at is null;
alter table public.push_tokens enable row level security;
alter table public.push_outbox enable row level security;
revoke all on public.push_tokens, public.push_outbox from public, anon, authenticated;

create or replace function public.push_register(p_token text, p_platform text, p_lang text default 'en', p_tz text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  zone text := 'Europe/Berlin';
begin
  if p_tz is not null and exists (select 1 from pg_timezone_names where name = p_tz) then zone := p_tz; end if;
  insert into public.push_tokens (token, user_id, platform, lang, tz) values (p_token, me, p_platform, coalesce(p_lang, 'en'), zone)
  on conflict (token) do update set user_id = excluded.user_id, platform = excluded.platform, lang = excluded.lang, tz = excluded.tz, updated_at = now();
  return true;
end;
$$;
create or replace function public.push_unregister(p_token text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.push_tokens where token = p_token and user_id = auth.uid();
  return found;
end;
$$;
revoke execute on function public.push_register(text, text, text, text), public.push_unregister(text) from public, anon;
grant execute on function public.push_register(text, text, text, text), public.push_unregister(text) to authenticated;

create or replace function public.push_name(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(p.display_name, p.handle, 'someone') from public.profiles p where p.id = p_user;
$$;
create or replace function public.push_zone(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select k.tz from public.push_tokens k where k.user_id = p_user order by k.updated_at desc limit 1), 'Europe/Berlin');
$$;
create or replace function public.push_wants(p_user uuid, p_kind text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select case
             when p_kind in ('friend_request', 'friend_accepted') then s.notify_friends
             when p_kind in ('call', 'call_in') then s.notify_calls
             when p_kind = 'coop_night' then s.notify_coops
             when p_kind = 'dm' then s.notify_dms
             when p_kind = 'card' then s.notify_cards end
    from public.profile_settings s where s.user_id = p_user), true);
$$;
create or replace function public.push_enqueue(p_user uuid, p_kind text, p_key text, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  zone text;
  here timestamp;
  due timestamptz := now();
begin
  if p_user is null or public.is_banned(p_user) or not public.push_wants(p_user, p_kind) then return; end if;
  if p_kind <> 'card' then
    zone := public.push_zone(p_user);
    here := now() at time zone zone;
    if extract(hour from here) < 9 then due := (date_trunc('day', here) + interval '9 hours') at time zone zone; end if;
  end if;
  insert into public.push_outbox (user_id, kind, key, data, send_after) values (p_user, p_kind, p_key, p_data, due) on conflict (key) do nothing;
end;
$$;
revoke execute on function public.push_name(uuid), public.push_zone(uuid), public.push_wants(uuid, text), public.push_enqueue(uuid, text, text, jsonb) from public, anon, authenticated;

-- The words: title and body in the language of the phone; {name} and {title} are filled
-- from data, nothing else ever is.
drop function if exists public.push_text(text, text, jsonb);
create or replace function public.push_text(p_kind text, p_lang text, p_data jsonb)
returns table (title text, body text)
language plpgsql
immutable
as $$
declare
  pair record;
begin
  select x.title, x.body into title, body from (values
    ('friend_request',  'en', 'friend request',           '{name} wants to add you'),
    ('friend_request',  'de', 'freundschaftsanfrage',     '{name} möchte dich hinzufügen'),
    ('friend_request',  'tr', 'arkadaşlık isteği',        '{name} seni eklemek istiyor'),
    ('friend_accepted', 'en', 'you are friends now',      '{name} accepted your request'),
    ('friend_accepted', 'de', 'ihr seid jetzt freunde',   '{name} hat deine anfrage angenommen'),
    ('friend_accepted', 'tr', 'artık arkadaşsınız',       '{name} isteğini kabul etti'),
    ('call',            'en', 'a project night',          '{name} started a project night'),
    ('call',            'de', 'eine projektnacht',        '{name} hat eine projektnacht gestartet'),
    ('call',            'tr', 'bir proje gecesi',         '{name} bir proje gecesi başlattı'),
    ('call_in',         'en', 'someone is in',            '{name} is in on your project night'),
    ('call_in',         'de', 'jemand ist dabei',         '{name} ist bei deiner projektnacht dabei'),
    ('call_in',         'tr', 'biri katıldı',             '{name} proje gecene katıldı'),
    ('coop_night',      'en', 'tonight, together',        '{name} chose tonight''s project for {title}'),
    ('coop_night',      'de', 'heute nacht, zusammen',    '{name} hat das projekt für heute nacht gewählt: {title}'),
    ('coop_night',      'tr', 'bu gece, beraber',         '{name} bu gecenin projesini seçti: {title}'),
    ('dm',              'en', 'a message',                '{name} wrote to you'),
    ('dm',              'de', 'eine nachricht',           '{name} hat dir geschrieben'),
    ('dm',              'tr', 'bir mesaj',                '{name} sana yazdı'),
    ('card',            'en', 'your card is in',          'last night on {title}: the card is yours'),
    ('card',            'de', 'deine karte ist da',       'letzte nacht bei {title}: die karte gehört dir'),
    ('card',            'tr', 'kartın hazır',             'dün gece {title}: kart senin')
  ) as x(kind, lang, title, body) where x.kind = p_kind and x.lang = coalesce(p_lang, 'en');
  if title is null then
    select x.title, x.body into title, body from (values ('x', 'pasaport', 'open the app')) as x(k, title, body);
  end if;
  for pair in select key, value from jsonb_each_text(coalesce(p_data, '{}')) where key in ('name', 'title') loop
    title := replace(title, '{' || pair.key || '}', coalesce(pair.value, ''));
    body := replace(body, '{' || pair.key || '}', coalesce(pair.value, ''));
  end loop;
  return next;
end;
$$;

create or replace function public.push_send(p_id bigint)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  item public.push_outbox;
  messages jsonb;
  phones text[];
  request bigint;
begin
  if to_regnamespace('net') is null then return false; end if;
  select * into item from public.push_outbox where id = p_id and sent_at is null;
  if not found then return false; end if;
  select jsonb_agg(jsonb_build_object('to', k.token, 'title', x.title, 'body', x.body, 'sound', 'default', 'channelId', 'default',
                                      'data', item.data || jsonb_build_object('kind', item.kind)) order by k.token),
         array_agg(k.token order by k.token) into messages, phones
  from public.push_tokens k cross join lateral public.push_text(item.kind, k.lang, item.data) x where k.user_id = item.user_id;
  if messages is not null then
    execute 'select net.http_post(url := $1, body := $2, headers := $3)' into request
      using 'https://exp.host/' || repeat('-', 2) || '/api/v2/push/send', messages, '{"Content-Type": "application/json", "Accept": "application/json"}'::jsonb;
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
  if new.send_after <= now() then perform public.push_send(new.id); end if;
  return new;
end;
$$;
drop trigger if exists push_outbox_deliver on public.push_outbox;
create trigger push_outbox_deliver after insert on public.push_outbox for each row execute function public.push_deliver();

-- The five-minute flush (a cron job on Supabase) sends what waited for 09:00 and forgets
-- what was sent more than a week ago.
create or replace function public.push_flush()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
  r record;
begin
  for r in select id from public.push_outbox where sent_at is null and send_after <= now() order by id limit 200 loop
    if public.push_send(r.id) then n := n + 1; end if;
  end loop;
  delete from public.push_outbox where sent_at < now() - interval '7 days';
  return n;
end;
$$;
revoke execute on function public.push_send(bigint), public.push_flush() from public, anon, authenticated;

-- ------------------------------------------------------------ the triggers
create or replace function public.push_on_friendship()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' and new.status = 'pending' then
    perform public.push_enqueue(new.addressee_id, 'friend_request', format('friend_request:%s:%s', new.requester_id, new.addressee_id),
      jsonb_build_object('name', public.push_name(new.requester_id), 'url', '/friend/' || new.requester_id));
  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status = 'accepted' then
    perform public.push_enqueue(new.requester_id, 'friend_accepted', format('friend_accepted:%s:%s', new.requester_id, new.addressee_id),
      jsonb_build_object('name', public.push_name(new.addressee_id), 'url', '/friend/' || new.addressee_id));
  end if;
  return new;
end;
$$;
drop trigger if exists friendships_push on public.friendships;
create trigger friendships_push after insert or update on public.friendships for each row execute function public.push_on_friendship();

-- a call: everyone inside the wave hears the name; an answer "in": the host hears the name
create or replace function public.push_on_call()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  w record;
begin
  for w in select person from public.waves(new.host_id) where hops <= new.reach loop
    perform public.push_enqueue(w.person, 'call', format('call:%s:%s', new.id, w.person),
      jsonb_build_object('name', public.push_name(new.host_id), 'url', '/call/' || new.id));
  end loop;
  return new;
end;
$$;
drop trigger if exists calls_push on public.calls;
create trigger calls_push after insert on public.calls for each row execute function public.push_on_call();
create or replace function public.push_on_call_answer()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  h uuid;
begin
  if new.answer = 'in' and (tg_op = 'INSERT' or old.answer <> 'in') then
    select host_id into h from public.calls where id = new.call_id;
    perform public.push_enqueue(h, 'call_in', format('call_in:%s:%s', new.call_id, new.user_id),
      jsonb_build_object('name', public.push_name(new.user_id), 'url', '/call/' || new.call_id));
  end if;
  return new;
end;
$$;
drop trigger if exists call_answers_push on public.call_answers;
create trigger call_answers_push after insert or update on public.call_answers for each row execute function public.push_on_call_answer();

-- a coop chose tonight: the other members hear the name and the project's title
create or replace function public.push_on_coop_night()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
  t text;
begin
  if new.night <> public.night_of() then return new; end if;
  select title into t from public.projects where id = new.project_id;
  for m in select user_id from public.coop_members where coop_id = new.coop_id and user_id <> new.set_by loop
    perform public.push_enqueue(m.user_id, 'coop_night', format('coop_night:%s:%s:%s', new.coop_id, new.night, m.user_id),
      jsonb_build_object('name', public.push_name(new.set_by), 'title', t, 'url', '/coops/' || new.coop_id));
  end loop;
  return new;
end;
$$;
drop trigger if exists coop_nights_push on public.coop_nights;
create trigger coop_nights_push after insert or update on public.coop_nights for each row execute function public.push_on_coop_night();

-- the morning: the card is in
create or replace function public.push_on_card()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  t text;
begin
  if new.card_no is not null and old.card_no is null then
    select title into t from public.projects where id = new.project_id;
    perform public.push_enqueue(new.user_id, 'card', format('card:%s', new.id), jsonb_build_object('title', t, 'url', '/passport'));
  end if;
  return new;
end;
$$;
drop trigger if exists contributions_push on public.contributions;
create trigger contributions_push after update on public.contributions for each row execute function public.push_on_card();

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('13_push.sql', '67d27a9fc464c3712658c3582621b37d3b4b446feb36fde80cde3007b201eaa8');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('13_push.sql');
  end if;
end $$;
