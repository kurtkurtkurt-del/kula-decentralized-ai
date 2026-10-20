-- afterhours — deleting an account, the two loose ends (65)
--
-- delete_account() (12) removes the auth user and lets the cascades do the rest; the
-- full sweep in delete-account.test.mjs shows no row of any table still points at the
-- person afterwards. Two things the cascade cannot know:
--   the last admin   guard_last_admin (53) keeps the last admin from being demoted,
--                    but a deletion went round it and left nobody to run the panel
--   a group owner    group_leave (44) hands a group to the longest member; a deletion
--                    took the owner row away and left a group nobody could manage,
--                    or, when the owner was alone, an empty group
-- The same function again, with both closed. Comments are still kept as someone (12).

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

  update public.comments
     set author_id = null, author_name = 'someone'
   where author_id = me;

  delete from auth.users where id = me;
end;
$$;

grant execute on function public.delete_account() to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('65_account_delete.sql', '4b82eceeb5cf323a09884a8024f5fe06ee48435a83bfcb089160c9f3b6a3aa8e');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('65_account_delete.sql');
  end if;
end $$;
