-- afterhours — what the chosen designs need to read (49, after 42 to 48)
--
--   group_peek(code)      now also says who is in (first names) and the plan, so
--                         the join screen can show faces and what the group is up to
--   group_wall(group)     every photo of every night of the group, newest night
--                         first, for the photo wall on "our nights"
--   admin_people_by(q, role)  people filtered by role, with how many nights each
--                         kept and how many groups each is in, and the counts per
--                         role for the filter chips

drop function if exists public.group_peek(text);
create or replace function public.group_peek(p_code text)
returns table (id uuid, name text, emoji text, color text, cover_path text, members int, mine boolean, open boolean,
               names text[], owner text, plan_title text)
language sql
stable
security definer
set search_path = public
as $$
  select g.id, g.name, g.emoji, g.color, g.cover_path,
         (select count(*)::int from public.group_members m where m.group_id = g.id),
         public.in_group(g.id),
         i.expires_at > now() and i.uses < i.max_uses,
         array(select coalesce(p.display_name, p.handle) from public.group_members m join public.profiles p on p.id = m.user_id
               where m.group_id = g.id order by m.joined_at limit 6),
         (select coalesce(p.display_name, p.handle) from public.profiles p where p.id = i.created_by),
         (select e.title from public.events e where e.id = g.plan_event_id and e.is_published)
  from public.group_invites i join public.groups g on g.id = i.group_id
  where i.code = upper(btrim(p_code));
$$;

create or replace function public.group_wall(p_group uuid)
returns table (id uuid, path text, event_id uuid, event_title text, starts_at timestamptz, name text, mine boolean, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_member(p_group);
  return query
    select ph.id, ph.path, e.id, e.title, e.starts_at, coalesce(p.display_name, p.handle), ph.user_id = auth.uid(), ph.created_at
    from public.group_photos ph
    join public.events e on e.id = ph.event_id
    left join public.profiles p on p.id = ph.user_id
    where ph.group_id = p_group
    order by e.starts_at desc nulls last, ph.created_at
    limit 300;
end;
$$;

-- 52 adds a column; a second run of the setup meets that shape first.
drop function if exists public.admin_people_by(text, text);
create or replace function public.admin_people_by(p_query text, p_role text)
returns table (id uuid, handle text, display_name text, role text, created_at timestamptz, nights int, groups int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  q text := lower(btrim(coalesce(p_query, '')));
begin
  perform public.need_admin();
  return query
    select p.id, p.handle, p.display_name,
           case when p.is_admin then 'admin' else p.account_type end, p.created_at,
           (select count(*)::int from public.swipes s where s.user_id = p.id and s.direction = 'right'),
           (select count(*)::int from public.group_members m where m.user_id = p.id)
    from public.profiles p
    where (q = '' or lower(coalesce(p.handle, '')) like '%' || q || '%' or lower(coalesce(p.display_name, '')) like '%' || q || '%')
      and (coalesce(p_role, '') = ''
           or (p_role = 'new' and p.created_at > now() - interval '7 days')
           or (p_role = 'admin' and p.is_admin)
           or (p_role not in ('new', 'admin') and not p.is_admin and p.account_type = p_role))
    order by (p.is_admin or p.account_type <> 'user') desc, p.created_at desc
    limit 80;
end;
$$;

create or replace function public.admin_role_counts()
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_admin();
  return json_build_object(
    'all', (select count(*) from public.profiles),
    'dj', (select count(*) from public.profiles where account_type = 'dj' and not is_admin),
    'community_manager', (select count(*) from public.profiles where account_type = 'community_manager' and not is_admin),
    'admin', (select count(*) from public.profiles where is_admin),
    'new', (select count(*) from public.profiles where created_at > now() - interval '7 days'));
end;
$$;

do $$
declare f text;
begin
  foreach f in array array['group_peek(text)', 'group_wall(uuid)', 'admin_people_by(text, text)', 'admin_role_counts()'] loop
    execute 'revoke all on function public.' || f || ' from public, anon';
    execute 'grant execute on function public.' || f || ' to authenticated';
  end loop;
end $$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('49_design_reads.sql', '3d2a0a2e99252a337af815b80935c615c29d73beef1ed57297eeb9c93f791103');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('49_design_reads.sql');
  end if;
end $$;
