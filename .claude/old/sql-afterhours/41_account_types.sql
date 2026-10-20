-- afterhours — account types: normal user, dj, community manager, admin (41)
--
-- Every profile carries a type, chosen in the settings of the app. Changing it takes
-- a code, and the code is the name of the type as the list shows it ("dj", "admin" …),
-- so for now it is a label, not a lock. Nothing reads it yet: no type may do
-- anything another cannot.
--
-- This "admin" is NOT profiles.is_admin. is_admin is the real one (02_rls.sql)
-- and stays where it was; no code here touches it.
--
--   profiles.account_type        user · dj · community_manager · admin
--   set_account_type(type, code) changes your own type when the code is right;
--                                returns ok · code · typeaa

alter table public.profiles add column if not exists account_type text not null default 'user';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_account_type_check') then
    alter table public.profiles add constraint profiles_account_type_check
      check (account_type in ('user', 'dj', 'community_manager', 'admin'));
  end if;
end $$;

-- A plain profile update may not change the type: only set_account_type may,
-- and it says so with a flag that lives for its own transaction only.
create or replace function public.guard_account_type()
returns trigger
language plpgsql
as $$
begin
  if new.account_type is distinct from old.account_type
     and auth.uid() is not null
     and coalesce(current_setting('afterhours.account_type', true), '') <> 'on' then
    raise exception 'account_type changes only through set_account_type';
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_account_type on public.profiles;
create trigger profiles_guard_account_type
  before update on public.profiles
  for each row execute function public.guard_account_type();

create or replace function public.set_account_type(p_type text, p_code text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  name text := case p_type
    when 'user' then 'normal user'
    when 'dj' then 'dj'
    when 'community_manager' then 'community manager'
    when 'admin' then 'admin'
  end;
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if name is null then return 'type'; end if;
  if lower(btrim(coalesce(p_code, ''))) <> name then return 'code'; end if;
  perform set_config('afterhours.account_type', 'on', true);
  update public.profiles set account_type = p_type where id = auth.uid();
  perform set_config('afterhours.account_type', '', true);
  return 'ok';
end;
$$;

revoke all on function public.set_account_type(text, text) from public, anon;
grant execute on function public.set_account_type(text, text) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('41_account_types.sql', '48a29b4f27e4bfbc0f234c9d3ac0438a6818eccdbfb0b31d64e62931a1532c36');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('41_account_types.sql');
  end if;
end $$;
