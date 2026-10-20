-- afterhours — a report keeps a copy (84)
--
-- A report pointed at a row and nothing else. When the row went (the author took it
-- back, the staff removed it, the account was deleted) the panel showed an empty
-- line; and the report itself left with the reporter, since it hung off their
-- profile (F12, 20.10.2026). Decided: the report takes a copy of what it is about
-- at the moment it is made - the text, the id and handle of the author, the time - and
-- outlives both the content and the reporter. Files are not copied. Removal and
-- deletion flows stay as they are.
--
--   reports.snapshot          jsonb {text, author, author_id, at}, filled by trigger
--   reports.reporter_id       may be null now (the reporter left); fk sets null
-- staff_reports (70) falls back to the copy; staff_report_settle (68) skips a
-- reporter who is gone. Both are their latest text with the one change each.

alter table public.reports add column if not exists snapshot jsonb;
alter table public.reports alter column reporter_id drop not null;
alter table public.reports drop constraint if exists reports_reporter_id_fkey;
alter table public.reports add constraint reports_reporter_id_fkey
  foreign key (reporter_id) references public.profiles (id) on delete set null;

create or replace function public.report_text(p_kind text, p_target text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case p_kind
    when 'comment'       then (select c.body from public.comments c where c.id::text = p_target)
    when 'room_post'     then (select x.body from public.room_posts x where x.id::text = p_target)
    when 'group_message' then (select x.body from public.group_messages x where x.id::text = p_target)
    when 'profile'       then (select concat_ws(' · ', p.handle, p.display_name, p.bio, p.about) from public.profiles p where p.id::text = p_target)
    when 'group'         then (select g.name from public.groups g where g.id::text = p_target)
    when 'spark'         then (select concat_ws(' · ', s.title, s.place) from public.sparks s where s.id::text = p_target)
    when 'post_comment'  then public.post_comment_body(p_target)
    when 'dm_message'    then (select x.body from public.dm_messages x where x.id::text = p_target)
  end;
$$;
revoke execute on function public.report_text(text, text) from public, anon, authenticated;

create or replace function public.report_snapshot()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  who uuid := public.report_author_any(new.kind, new.target);
begin
  if new.snapshot is null then
    new.snapshot := jsonb_build_object(
      'text', left(public.report_text(new.kind, new.target), 1000),
      'author_id', who,
      'author', (select coalesce(p.handle, p.display_name) from public.profiles p where p.id = who),
      'at', now());
  end if;
  return new;
end;
$$;
drop trigger if exists report_snapshot on public.reports;
create trigger report_snapshot before insert on public.reports
  for each row execute function public.report_snapshot();

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
      select r.kind, r.target, count(*)::int as n, array_remove(array_agg(r.reason order by r.created_at), null) as why, min(r.created_at) as first_at,
             (array_agg(r.snapshot order by r.created_at))[1] as snap
      from public.reports r where not r.handled
      group by r.kind, r.target
    )
    select o.kind, o.target,
           coalesce(case o.kind
             when 'comment'       then (select c.body from public.comments c where c.id::text = o.target)
             when 'room_post'     then (select x.body from public.room_posts x where x.id::text = o.target)
             when 'group_message' then (select x.body from public.group_messages x where x.id::text = o.target)
             when 'profile'       then (select concat_ws(' · ', p.display_name, p.bio, p.about) from public.profiles p where p.id::text = o.target)
             when 'group'         then (select g.name from public.groups g where g.id::text = o.target)
             when 'spark'         then (select concat_ws(' · ', s.title, s.place) from public.sparks s where s.id::text = o.target)
             when 'post_comment'  then public.post_comment_body(o.target)
             when 'dm_message'    then (select x.body from public.dm_messages x where x.id::text = o.target)
           end, o.snap ->> 'text'),
           coalesce((select coalesce(p.handle, p.display_name) from public.profiles p where p.id = public.report_author_any(o.kind, o.target)), o.snap ->> 'author'),
           o.n, o.why, o.first_at
    from open o
    order by o.n desc, o.first_at;
end;
$$;

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
             where r.kind = p_kind and r.target = p_target and not r.handled and r.reporter_id is not null loop
    perform public.notice(who.reporter_id,
                          case when coalesce(p_remove, false) then 'report_removed' else 'report_kept' end,
                          jsonb_build_object('what', p_kind));
  end loop;
  update public.reports set handled = true where kind = p_kind and target = p_target and not handled;
  perform public.staff_note(case when coalesce(p_remove, false) then 'remove' else 'keep' end, 'report:' || p_kind, p_target, null);
end;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('84_report_snapshot.sql', 'c54686d5ef5522460c11364078715e0b5ee8dcd170bcaabd302b6cddd79c5064');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('84_report_snapshot.sql');
  end if;
end $$;
