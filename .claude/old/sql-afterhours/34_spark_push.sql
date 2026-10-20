-- afterhours — sparks say so: a push when one reaches you, and when someone is in
-- The kinds, their words and the switch (notify_sparks) are in 26_push.sql; this
-- file only adds the triggers, because the sparks themselves come later (27, 28).
--
--   spark      a spark reaches you: you were ticked by name (27), or you are
--              inside the wave it was started for (28). Opens its page.
--   spark_in   someone answered "in" to a spark you started.
--
-- Each goes out once per spark and person (the outbox key), follows the
-- switch, and waits for 09:00 in quiet hours like a friend request does.
-- A wave can be large: the 2nd and 3rd wave count against the same ten a day
-- as the other discovery kinds; the 1st wave (your friends) always goes.

-- Pasted on its own (without 26 again) it must still work: the switch and the
-- two kinds are made sure of here too, and a push that fails never stops the
-- spark or the answer that caused it.
alter table public.profile_settings add column if not exists notify_sparks boolean not null default true;
alter table public.push_outbox drop constraint if exists push_outbox_kind_check;
alter table public.push_outbox add constraint push_outbox_kind_check check (kind in (
  'friend_request', 'friend_accepted', 'match', 'friend_live',
  'night_soon', 'room_open', 'room_closing', 'room_message', 'reply',
  'digest', 'dj_live', 'wave', 'spark', 'spark_in'));

-- "fri 22:00", in the zone of the phone of the person.
create or replace function public.push_when(p_user uuid, p_at timestamptz)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select lower(to_char(p_at at time zone public.push_zone(p_user), 'Dy HH24:MI'));
$$;

create or replace function public.push_spark_to(p_user uuid, p_spark public.sparks, p_wave int)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_user = p_spark.host_id then
    return;
  end if;
  if coalesce(p_wave, 1) > 1
     and (select count(*) from public.push_outbox o
          where o.user_id = p_user and o.created_at > now() - interval '1 day'
            and o.kind in ('room_message', 'digest', 'dj_live', 'wave', 'spark')) >= 10 then
    return;
  end if;
  perform public.push_enqueue(p_user, 'spark',
    format('spark:%s:%s', p_spark.id, p_user),
    jsonb_build_object(
      'name',  public.push_name(p_spark.host_id),
      'title', p_spark.title,
      'when',  public.push_when(p_user, p_spark.starts_at),
      'url',   format('/spark/%s?invite=%s', p_spark.kind, p_spark.id)));
end;
$$;
revoke execute on function public.push_spark_to(uuid, public.sparks, int) from public, anon, authenticated;

-- A spark for a wave: everyone inside it, at the moment it is started.
create or replace function public.push_on_spark()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  w record;
begin
  if new.reach is null then
    return new;   -- the old way: the invite rows say who (below)
  end if;
  for w in select person, hops from public.spark_waves(new.host_id) where hops <= new.reach loop
    perform public.push_spark_to(w.person, new, w.hops);
  end loop;
  return new;
exception when others then
  raise warning 'spark push skipped: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists push_spark on public.sparks;
create trigger push_spark
  after insert on public.sparks
  for each row execute function public.push_on_spark();

-- An invite row: ticked by name (27) → "spark". An answer turning to "in" → the
-- host hears it. Rows written by someone in a wave answering are not new
-- invites: they arrive already answered.
create or replace function public.push_on_spark_invite()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s public.sparks;
begin
  select * into s from public.sparks where id = new.spark_id;
  if not found then
    return new;
  end if;
  if tg_op = 'INSERT' and new.answer = 'waiting' then
    perform public.push_spark_to(new.user_id, s, 1);
  end if;
  if new.answer = 'in' and (tg_op = 'INSERT' or old.answer is distinct from 'in') then
    perform public.push_enqueue(s.host_id, 'spark_in',
      format('spark_in:%s:%s', s.id, new.user_id),
      jsonb_build_object(
        'name',  public.push_name(new.user_id),
        'title', s.title,
        'url',   '/account'));
  end if;
  return new;
exception when others then
  raise warning 'spark push skipped: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists push_spark_invite on public.spark_invites;
create trigger push_spark_invite
  after insert or update of answer on public.spark_invites
  for each row execute function public.push_on_spark_invite();

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('34_spark_push.sql', 'f56eac9a17c399e886530487d5bc7b7351bb107f7cce550591559202a2bbdc65');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('34_spark_push.sql');
  end if;
end $$;
