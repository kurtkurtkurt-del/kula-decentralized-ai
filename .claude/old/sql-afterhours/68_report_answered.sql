-- afterhours — the person who reported hears the outcome (68)
--
-- A report went into the panel and the reporter never heard of it again (F16,
-- 20.10.2026). The one reported already gets a notice when something of theirs is
-- hidden or removed (53); now the reporter gets one too, the moment the staff settle
-- the report: report_removed when the thing went, report_kept when it stayed. The
-- notice says what kind of thing it was and nothing about who; the staff never
-- answer in their own words (58).
--
-- staff_report_settle() is the same as in 51, with the notices added before the
-- reports are marked handled.

alter table public.notices drop constraint if exists notices_kind_check;
alter table public.notices add constraint notices_kind_check
  check (kind in ('comment_hidden', 'post_hidden', 'removed', 'profile_cleared',
                  'role', 'dj_verified', 'dj_hidden', 'report_removed', 'report_kept'));

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
             where r.kind = p_kind and r.target = p_target and not r.handled loop
    perform public.notice(who.reporter_id,
                          case when coalesce(p_remove, false) then 'report_removed' else 'report_kept' end,
                          jsonb_build_object('what', p_kind));
  end loop;
  update public.reports set handled = true where kind = p_kind and target = p_target and not handled;
  perform public.staff_note(case when coalesce(p_remove, false) then 'remove' else 'keep' end, 'report:' || p_kind, p_target, null);
end;
$$;

revoke execute on function public.staff_report_settle(text, text, boolean) from public, anon;
grant execute on function public.staff_report_settle(text, text, boolean)  to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('68_report_answered.sql', 'd31c57dbea50047478594749cc020ad351ba62ed92f4d92900ebac9714efe953');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('68_report_answered.sql');
  end if;
end $$;
