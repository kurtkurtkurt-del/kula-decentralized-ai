-- afterhours — who has read what, kept by the server (90)
--
-- What a person had seen of a conversation lived on the phone alone: a second
-- phone, a reinstall or the web showed every line as new (F28, 20.10.2026). The
-- thread now carries, for each side, the last line that side has seen; dm_seen
-- moves it, dm_list counts the lines after it that are not mine. The phone keeps
-- its own mark too and uses the one on the server when it is there. dm_list is that of 59
-- with the one column, so it is dropped and made again with its grant.

alter table public.dm_threads add column if not exists seen_a bigint not null default 0;
alter table public.dm_threads add column if not exists seen_b bigint not null default 0;

create or replace function public.dm_seen(p_thread uuid, p_id bigint)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'sign in first'; end if;
  update public.dm_threads
     set seen_a = case when a = me then greatest(seen_a, p_id) else seen_a end,
         seen_b = case when b = me then greatest(seen_b, p_id) else seen_b end
   where id = p_thread and me in (a, b);
end;
$$;
grant execute on function public.dm_seen(uuid, bigint) to authenticated;

drop function if exists public.dm_list();
create or replace function public.dm_list()
returns table (id uuid, other_id uuid, handle text, name text, last_body text, last_mine boolean, last_id bigint, last_at timestamptz, unread int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  select t.id, o.id, o.handle, coalesce(o.display_name, o.handle),
         l.body, l.user_id = me, l.id, t.last_at,
         (select count(*)::int from public.dm_messages u
           where u.thread_id = t.id and u.user_id <> me
             and u.id > case when t.a = me then t.seen_a else t.seen_b end)
  from public.dm_threads t
  join public.profiles o on o.id = case when t.a = me then t.b else t.a end
  left join lateral (select m.id, m.body, m.user_id from public.dm_messages m where m.thread_id = t.id order by m.id desc limit 1) l on true
  where me in (t.a, t.b)
    and public.reachable(me, o.id)
  order by t.last_at desc;
end;
$$;
grant execute on function public.dm_list() to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('90_dm_seen.sql', 'ffd942a2cb07ce815b8c3df126b045187574293773a33b312af376f731811fe5');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('90_dm_seen.sql');
  end if;
end $$;
