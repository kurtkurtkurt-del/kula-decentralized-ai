-- afterhours — the file on a person, and who may open a closed account (86)
--
-- The staff saw a person as one row: a name, a role, a badge. What they had been
-- reported for, how often, what was said, whether they had been closed before and
-- what they wrote in objection lived in five tables nobody could read together
-- (F18, 20.10.2026). And a community manager could open an account an admin had
-- closed. Decided: one file per person, and a tier.
--
--   staff_person(user)   jsonb: who, reports about them (with the copies of 84),
--                        reports they made, objections (85), the staff log on them
--   staff_unban(user)    as 52, but a ban given by an admin is lifted by an admin only;
--                        staff_appeal_settle (85) goes through it and inherits the rule

create or replace function public.staff_unban(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  by_admin boolean;
begin
  perform public.need_staff();
  select coalesce(b.is_admin or b.account_type = 'admin', false) into by_admin
    from public.profiles p left join public.profiles b on b.id = p.banned_by
   where p.id = p_user;
  if coalesce(by_admin, false) and not coalesce(public.is_admin(), false) then
    raise exception 'an admin closed this account; only an admin opens it' using errcode = '42501';
  end if;
  perform set_config('afterhours.ban', 'on', true);
  update public.profiles set banned_at = null, banned_reason = null, banned_by = null where id = p_user;
  perform set_config('afterhours.ban', '', true);
  perform public.staff_note('unban', 'person', p_user::text, null);
end;
$$;

create or replace function public.staff_person(p_user uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  out jsonb;
begin
  perform public.need_staff();
  select jsonb_build_object(
    'who', (select jsonb_build_object('id', p.id, 'handle', p.handle, 'name', p.display_name, 'role',
                     case when p.is_admin then 'admin' else p.account_type end, 'created_at', p.created_at,
                     'banned_at', p.banned_at, 'banned_reason', p.banned_reason,
                     'banned_by', (select coalesce(b.handle, b.display_name) from public.profiles b where b.id = p.banned_by),
                     'banned_by_admin', (select coalesce(b.is_admin or b.account_type = 'admin', false) from public.profiles b where b.id = p.banned_by))
            from public.profiles p where p.id = p_user),
    'reports_about', coalesce((select jsonb_agg(jsonb_build_object('kind', r.kind, 'target', r.target, 'text', r.snapshot ->> 'text',
                                 'reason', r.reason, 'handled', r.handled, 'at', r.created_at) order by r.created_at desc)
            from public.reports r where (r.snapshot ->> 'author_id') = p_user::text), '[]'::jsonb),
    'reports_made', coalesce((select jsonb_agg(jsonb_build_object('kind', r.kind, 'reason', r.reason, 'handled', r.handled, 'at', r.created_at) order by r.created_at desc)
            from public.reports r where r.reporter_id = p_user), '[]'::jsonb),
    'appeals', coalesce((select jsonb_agg(jsonb_build_object('body', a.body, 'outcome', a.outcome, 'at', a.created_at, 'settled_at', a.settled_at) order by a.created_at desc)
            from public.appeals a where a.user_id = p_user), '[]'::jsonb),
    'log', coalesce((select jsonb_agg(jsonb_build_object('action', l.action, 'note', l.note, 'at', l.at,
                                 'by', (select coalesce(x.handle, x.display_name) from public.profiles x where x.id = l.actor_id)) order by l.at desc)
            from public.staff_log l where l.target = 'person' and l.target_id = p_user::text), '[]'::jsonb)
  ) into out;
  return out;
end;
$$;
grant execute on function public.staff_person(uuid) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('86_person_file.sql', 'c4ec3d2800b5dc808a1b3a53e9fa2a380fdea01912c699317cd69b9aa1ed7649');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('86_person_file.sql');
  end if;
end $$;
