-- paste 16/24: 85 86
create table if not exists public.appeals (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles on delete cascade,
  body        text not null check (length(btrim(body)) between 20 and 600),
  created_at  timestamptz not null default now(),
  settled_at  timestamptz,
  outcome     text check (outcome is null or outcome in ('unban', 'keep')),
  settled_by  uuid references public.profiles on delete set null
);

create index if not exists appeals_open on public.appeals (created_at) where settled_at is null;

alter table public.appeals enable row level security;

revoke all on public.appeals from public, anon, authenticated;

alter table public.notices drop constraint if exists notices_kind_check;

alter table public.notices add constraint notices_kind_check
  check (kind in ('comment_hidden', 'post_hidden', 'removed', 'profile_cleared',
                  'role', 'dj_verified', 'dj_hidden', 'report_removed', 'report_kept',
                  'night_ok', 'night_no', 'appeal_ok', 'appeal_no'));

create or replace function public.appeal(p_body text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then raise exception 'sign in first'; end if;
  if not public.is_banned() then raise exception 'the account is open'; end if;
  if exists (select 1 from public.appeals a where a.user_id = auth.uid() and a.settled_at is null) then
    raise exception 'already sent';
  end if;
  insert into public.appeals (user_id, body) values (auth.uid(), btrim(p_body));
end;
$$;

grant execute on function public.appeal(text) to authenticated;

create or replace function public.my_appeal()
returns table (sent_at timestamptz, outcome text, settled_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select a.created_at, a.outcome, a.settled_at from public.appeals a
  where a.user_id = auth.uid() order by a.created_at desc limit 1;
$$;

grant execute on function public.my_appeal() to authenticated;

create or replace function public.staff_appeals()
returns table (id bigint, user_id uuid, handle text, reason text, banned_at timestamptz, body text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_staff();
  return query
    select a.id, a.user_id, coalesce(p.handle, p.display_name), p.banned_reason, p.banned_at, a.body, a.created_at
    from public.appeals a join public.profiles p on p.id = a.user_id
    where a.settled_at is null
    order by a.created_at;
end;
$$;

grant execute on function public.staff_appeals() to authenticated;

create or replace function public.staff_appeal_settle(p_id bigint, p_unban boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.appeals%rowtype;
begin
  perform public.need_staff();
  select * into a from public.appeals where id = p_id and settled_at is null;
  if a.id is null then raise exception 'no such appeal'; end if;
  update public.appeals set settled_at = now(), outcome = case when coalesce(p_unban, false) then 'unban' else 'keep' end, settled_by = auth.uid()
   where id = p_id;
  if coalesce(p_unban, false) then
    perform public.staff_unban(a.user_id);
  end if;
  perform public.notice(a.user_id, case when coalesce(p_unban, false) then 'appeal_ok' else 'appeal_no' end, '{}'::jsonb);
  perform public.staff_note(case when coalesce(p_unban, false) then 'appeal-unban' else 'appeal-keep' end, 'person', a.user_id::text, null);
end;
$$;

grant execute on function public.staff_appeal_settle(bigint, boolean) to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('85_appeals.sql', '1c7ec869e98f4f8cff38ddc21df11bcf30cf7e7909633f92a856377cd3d6ae17');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('85_appeals.sql');
  end if;
end $$;

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
