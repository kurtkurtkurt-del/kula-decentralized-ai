-- afterhours — the messages of a deleted account go with it (73)
--
-- A comment on a night stays as someone (12): it is part of the night. A line in a
-- room or a group chat is not; it is the person talking, and the owner decided on
-- 20.10.2026 (F32) that it goes when the account goes. room_posts kept the line with
-- user_id null; group_messages cascaded already. delete_account() is that of 65 with
-- the room lines removed first.

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

  -- what the person said in rooms and groups leaves with them
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
