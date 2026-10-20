-- paste 7/24: 72 73 74
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

create or replace function public.delete_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  g  uuid;
begin
  if me is null then
    raise exception 'sign in first';
  end if;

  if exists (select 1 from public.profiles where id = me and is_admin)
     and not exists (select 1 from public.profiles where is_admin and id <> me) then
    raise exception 'the last admin stays an admin';
  end if;

  for g in select group_id from public.group_members where user_id = me loop
    delete from public.group_members where group_id = g and user_id = me;
    if not exists (select 1 from public.group_members where group_id = g) then
      delete from public.groups where id = g;
    elsif not exists (select 1 from public.group_members where group_id = g and role = 'owner') then
      update public.group_members set role = 'owner'
       where group_id = g and user_id = (select user_id from public.group_members
                                          where group_id = g order by joined_at, user_id limit 1);
    end if;
  end loop;

  delete from public.room_posts where user_id = me;
  delete from public.group_messages where user_id = me;

  update public.comments
     set author_id = null, author_name = 'someone'
   where author_id = me;

  delete from auth.users where id = me;
end;
$$;

grant execute on function public.delete_account() to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('73_messages_go.sql', '8403802a781af964daf6be7c4ae1896aafcd02abee3078a7288039d4b0df63ea');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('73_messages_go.sql');
  end if;
end $$;

create table if not exists public.banned_marks (
  mark    text primary key,
  handle  text,
  at      timestamptz not null default now()
);

alter table public.banned_marks enable row level security;
