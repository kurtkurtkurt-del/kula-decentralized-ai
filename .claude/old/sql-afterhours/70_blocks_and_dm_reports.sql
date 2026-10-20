-- afterhours — a block reaches every reader, and a direct message can be reported (70)
--
-- A block (50) closed the card, the search, the waves, the groups and the messages, but
-- not the two oldest readers: beforehours comments (comments_public, 06/12) and the
-- room of a night (room_list, 19). The blocked person kept reading the other, and the
-- other kept reading them (F14, 20.10.2026). hidden_by_block() is the one filter both
-- readers use now; it answers false when nobody is signed in, so the site keeps reading
-- comments signed out, and it may be called by anyone (is_blocked itself stays closed
-- to anon).
--
-- And a direct message was the one kind of writing nobody could report (F8): dm_message
-- joins the report kinds — the author is found only by someone in that thread, the
-- staff see the words, and removing it deletes the line.

-- ------------------------------------------------------------ the block filter

create or replace function public.hidden_by_block(other uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select auth.uid() is not null and other is not null and exists (
    select 1 from public.blocks b
    where (b.blocker_id = auth.uid() and b.blocked_id = other)
       or (b.blocker_id = other and b.blocked_id = auth.uid()));
$$;
revoke execute on function public.hidden_by_block(uuid) from public;
grant execute on function public.hidden_by_block(uuid) to anon, authenticated;

create or replace view public.comments_public
with (security_invoker = true) as
select
  c.id,
  c.event_id,
  c.parent_id,
  c.body,
  c.time_text,
  c.created_at,
  public.author_name(c.author_id, c.author_name) as author,
  c.author_id is not null as is_real
from public.comments c
where not c.is_hidden
  and not public.hidden_by_block(c.author_id);

create or replace function public.room_list(p_slug text)
returns table (
  id          uuid,
  body        text,
  who         text,
  mine        boolean,
  created_at  timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select r.id, r.body, lower(left(coalesce(p.display_name, p.handle, 's'), 1)), r.user_id = auth.uid(), r.created_at
  from public.room_posts r
  join public.events e on e.id = r.event_id
  left join public.profiles p on p.id = r.user_id
  where e.slug = p_slug and public.checked_in(e.id)
    and not public.hidden_by_block(r.user_id)
  order by r.created_at;
$$;

-- ------------------------------------------------------------ reporting a message

alter table public.reports drop constraint if exists reports_kind_check;
alter table public.reports add constraint reports_kind_check
  check (kind in ('comment', 'room_post', 'group_message', 'profile', 'group', 'spark', 'post_comment', 'dm_message'));

-- Who wrote it, as the reporter may know it: only someone in the thread.
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
  elsif p_kind = 'dm_message' then
    select m.user_id into a from public.dm_messages m
      join public.dm_threads t on t.id = m.thread_id
     where m.id::text = p_target and auth.uid() in (t.a, t.b) and m.user_id <> auth.uid();
  end if;
  return a;
end;
$$;

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
    when 'dm_message'    then (select user_id from public.dm_messages where id::text = p_target)
  end;
$$;
revoke all on function public.report_author_any(text, text) from public, anon, authenticated;

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
             when 'dm_message'    then (select x.body from public.dm_messages x where x.id::text = o.target)
           end,
           (select coalesce(p.handle, p.display_name) from public.profiles p where p.id = public.report_author_any(o.kind, o.target)),
           o.n, o.why, o.first_at
    from open o
    order by o.n desc, o.first_at;
end;
$$;

-- As in 68, plus the message.
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
