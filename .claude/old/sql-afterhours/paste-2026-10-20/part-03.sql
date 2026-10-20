-- paste 3/24: 68 69 70
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

create or replace function public.push_on_rsvp()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  night record;
  them  record;
begin
  if new.answer <> 'in' or (tg_op = 'UPDATE' and old.answer = 'in') then
    return new;
  end if;
  if not public.kept_visible(new.user_id) then
    return new;
  end if;
  select e.title, e.slug into night from public.events e where e.id = new.event_id;

  for them in
    select distinct f.friend as user_id
    from public.push_edges f
    where f.who = new.user_id
      and (exists (select 1 from public.swipes w where w.user_id = f.friend and w.event_id = new.event_id and w.direction = 'right')
        or exists (select 1 from public.rsvps r where r.user_id = f.friend and r.event_id = new.event_id and r.answer = 'in'))
  loop
    perform public.push_enqueue(them.user_id, 'match',
      format('rsvp:%s:%s:%s', them.user_id, new.user_id, new.event_id),
      jsonb_build_object('name', public.push_name(new.user_id), 'title', night.title, 'url', '/night/' || night.slug));
  end loop;
  return new;
end;
$$;

revoke execute on function public.push_on_rsvp() from public, anon, authenticated;

drop trigger if exists push_rsvp on public.rsvps;

create trigger push_rsvp
  after insert or update of answer on public.rsvps
  for each row execute function public.push_on_rsvp();

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('69_rsvp_push.sql', '2979cba607450c3b34c5072b421b570596c8212155ba082c72a43ff3d8a5848d');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('69_rsvp_push.sql');
  end if;
end $$;

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

alter table public.reports drop constraint if exists reports_kind_check;

alter table public.reports add constraint reports_kind_check
  check (kind in ('comment', 'room_post', 'group_message', 'profile', 'group', 'spark', 'post_comment', 'dm_message'));
