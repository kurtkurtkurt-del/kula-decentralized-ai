-- paste 5/24: 70 71 72
create or replace function public.staff_report_settle(p_kind text, p_target text, p_remove boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  who record;
begin
  perform public.need_staff();
  if coalesce(p_remove, false) then
    if p_kind = 'comment' then
      update public.comments set is_hidden = true where id::text = p_target;
    elsif p_kind = 'room_post' then
      delete from public.room_posts where id::text = p_target;
    elsif p_kind = 'group_message' then
      delete from public.group_messages where id::text = p_target;
    elsif p_kind = 'dm_message' then
      delete from public.dm_messages where id::text = p_target;
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
  for who in select distinct r.reporter_id from public.reports r
             where r.kind = p_kind and r.target = p_target and not r.handled loop
    perform public.notice(who.reporter_id,
                          case when coalesce(p_remove, false) then 'report_removed' else 'report_kept' end,
                          jsonb_build_object('what', p_kind));
  end loop;
  update public.reports set handled = true where kind = p_kind and target = p_target and not handled;
  perform public.staff_note(case when coalesce(p_remove, false) then 'remove' else 'keep' end, 'report:' || p_kind, p_target, null);
end;
$$;

revoke execute on function public.staff_reports()                          from public, anon;

revoke execute on function public.staff_report_settle(text, text, boolean) from public, anon;

grant execute on function public.staff_reports()                           to authenticated;

grant execute on function public.staff_report_settle(text, text, boolean)  to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('70_blocks_and_dm_reports.sql', '674e630174dc3e2a9d58d21c9d1bfc612f9bfd8d999fc6bfeaf9a5cd98ed5bda');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('70_blocks_and_dm_reports.sql');
  end if;
end $$;

drop function if exists public.health();

create or replace function public.health()
returns table (
  events            bigint,
  published         bigint,
  missing_venue     bigint,
  unverified_date   bigint,
  past_still_up     bigint,
  comments          bigint,
  hidden_comments   bigint,
  people            bigint,
  swipes            bigint,
  friendships       bigint,
  newest_synced     timestamptz,
  outbox_stuck      bigint
)
language sql
security definer
set search_path = public
as $$
  select
    (select count(*) from public.events),
    (select count(*) from public.events where is_published),
    (select count(*) from public.events where venue_id is null),
    (select count(*) from public.events where starts_at_estimated),
    (select count(*) from public.events
      where is_published and starts_at is not null
        and not starts_at_estimated and starts_at < now()),
    (select count(*) from public.comments),
    (select count(*) from public.comments where is_hidden),
    (select count(*) from public.profiles),
    (select count(*) from public.swipes),
    (select count(*) from public.friendships where status = 'accepted'),
    (select max(created_at) from public.events where source = 'ticketmaster'),
    (select count(*) from public.push_outbox
      where sent_at is null
        and greatest(created_at, coalesce(send_after, created_at)) < now() - interval '6 hours');
$$;

grant execute on function public.health() to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('71_health_more.sql', '8454b42f5a542d7fa6e981f35678d9dd0f029d4e79f77cb64ad099e93da0e904');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('71_health_more.sql');
  end if;
end $$;

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
