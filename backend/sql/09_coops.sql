-- pasaport — coops: friends who work a night together
-- A coop is a few people (2 to 12) who keep one project together and say "tonight we work
-- on this one". Each phone still does its own night; the coop is the shared decision and
-- the shared count in the morning.
--   coops           name, emoji, colour, who made it
--   coop_members    who is in; the maker is the owner
--   coop_invites    a code for a link or a QR: whoever has it may join (14 days, 20 uses)
--   coop_nights     one row per coop per night (a date) with the project chosen; set by any
--                   member, the last word wins
--   coop_create / coop_update / coop_add / coop_leave / coop_remove / coop_delete
--   coop_invite(id) → code · coop_peek(code) · coop_join(code)
--   coop_get(id)    the coop, its members, tonight's project, last night's numbers
--   my_coops()      yours, with tonight's project
--   coop_night_set(id, date, slug) · coop_nights(id)   the plan and the nights done
-- Members: friends of the one who adds (strangers come in by code). Each call asks first
-- whether you are in the coop.

create table if not exists public.coops (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 40),
  emoji       text not null default '✦' check (length(emoji) between 1 and 8),
  color       text not null default 'red' check (color in ('red', 'gold', 'blue', 'green', 'violet', 'paper')),
  created_by  uuid references public.profiles on delete set null,
  created_at  timestamptz not null default now()
);
create table if not exists public.coop_members (
  coop_id    uuid not null references public.coops on delete cascade,
  user_id    uuid not null references public.profiles on delete cascade,
  role       text not null default 'member' check (role in ('owner', 'member')),
  joined_at  timestamptz not null default now(),
  primary key (coop_id, user_id)
);
create index if not exists coop_members_user_idx on public.coop_members (user_id);
create table if not exists public.coop_invites (
  code        text primary key,
  coop_id     uuid not null references public.coops on delete cascade,
  created_by  uuid references public.profiles on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default now() + interval '14 days',
  uses        int not null default 0,
  max_uses    int not null default 20
);
create table if not exists public.coop_nights (
  coop_id     uuid not null references public.coops on delete cascade,
  night       date not null,
  project_id  uuid not null references public.projects on delete cascade,
  set_by      uuid references public.profiles on delete set null,
  set_at      timestamptz not null default now(),
  primary key (coop_id, night)
);
alter table public.coops enable row level security;
alter table public.coop_members enable row level security;
alter table public.coop_invites enable row level security;
alter table public.coop_nights enable row level security;
revoke all on public.coops, public.coop_members, public.coop_invites, public.coop_nights from public, anon, authenticated;

create or replace function public.in_coop(p_coop uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.coop_members where coop_id = p_coop and user_id = auth.uid());
$$;
create or replace function public.need_coop(p_coop uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  if not public.in_coop(p_coop) then raise exception 'not in this coop' using errcode = '42501'; end if;
  return me;
end;
$$;
revoke execute on function public.in_coop(uuid), public.need_coop(uuid) from public, anon, authenticated;

create or replace function public.coop_check(p_name text, p_emoji text, p_color text)
returns void
language plpgsql
stable
as $$
begin
  if length(btrim(coalesce(p_name, ''))) not between 1 and 40 then raise exception 'name: 1 to 40 characters'; end if;
  if length(coalesce(p_emoji, '✦')) not between 1 and 8 then raise exception 'one emoji'; end if;
  if coalesce(p_color, 'red') not in ('red', 'gold', 'blue', 'green', 'violet', 'paper') then raise exception 'unknown colour'; end if;
end;
$$;

create or replace function public.coop_create(p_name text, p_emoji text, p_color text, p_members uuid[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  g uuid;
  m uuid;
  others uuid[] := array(select x from unnest(coalesce(p_members, '{}')) with ordinality as u(x, i) where x <> me group by x order by min(i));
begin
  perform public.coop_check(p_name, p_emoji, p_color);
  if cardinality(others) > 11 then raise exception 'at most 12 in a coop'; end if;
  if (select count(*) from public.coop_members where user_id = me) >= 30 then raise exception 'at most 30 coops'; end if;
  foreach m in array others loop
    if not public.are_friends(me, m) or not public.reachable(me, m) then raise exception 'only friends can be added; send the others a link'; end if;
  end loop;
  insert into public.coops (name, emoji, color, created_by) values (btrim(p_name), coalesce(p_emoji, '✦'), coalesce(p_color, 'red'), me) returning id into g;
  insert into public.coop_members (coop_id, user_id, role) values (g, me, 'owner');
  insert into public.coop_members (coop_id, user_id, joined_at)
  select g, x, now() + make_interval(secs => i / 1e6) from unnest(others) with ordinality as u(x, i);
  return g;
end;
$$;

create or replace function public.coop_update(p_id uuid, p_name text, p_emoji text, p_color text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.need_coop(p_id);
  perform public.coop_check(p_name, p_emoji, p_color);
  update public.coops set name = btrim(p_name), emoji = coalesce(p_emoji, '✦'), color = coalesce(p_color, 'red') where id = p_id;
end;
$$;

create or replace function public.coop_add(p_id uuid, p_users uuid[])
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.need_coop(p_id);
  m uuid;
  n int := 0;
begin
  foreach m in array coalesce(p_users, '{}') loop
    if exists (select 1 from public.coop_members where coop_id = p_id and user_id = m) then continue; end if;
    if not public.are_friends(me, m) or not public.reachable(me, m) then raise exception 'only friends can be added; send the others a link'; end if;
    if (select count(*) from public.coop_members where coop_id = p_id) >= 12 then raise exception 'at most 12 in a coop'; end if;
    insert into public.coop_members (coop_id, user_id) values (p_id, m);
    n := n + 1;
  end loop;
  return n;
end;
$$;

create or replace function public.coop_leave(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.need_coop(p_id);
  was text;
begin
  select role into was from public.coop_members where coop_id = p_id and user_id = me;
  delete from public.coop_members where coop_id = p_id and user_id = me;
  if not exists (select 1 from public.coop_members where coop_id = p_id) then
    delete from public.coops where id = p_id;
  elsif was = 'owner' then
    update public.coop_members set role = 'owner' where coop_id = p_id
      and user_id = (select user_id from public.coop_members where coop_id = p_id order by joined_at, user_id limit 1);
  end if;
end;
$$;

create or replace function public.coop_remove(p_id uuid, p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.need_coop(p_id);
begin
  if p_user = me then perform public.coop_leave(p_id); return; end if;
  if not exists (select 1 from public.coop_members where coop_id = p_id and user_id = me and role = 'owner') then
    raise exception 'only the owner' using errcode = '42501';
  end if;
  delete from public.coop_members where coop_id = p_id and user_id = p_user;
end;
$$;

create or replace function public.coop_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.need_coop(p_id);
begin
  if not exists (select 1 from public.coop_members where coop_id = p_id and user_id = me and role = 'owner') then
    raise exception 'only the owner' using errcode = '42501';
  end if;
  delete from public.coops where id = p_id;
end;
$$;

create or replace function public.coop_invite(p_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.need_coop(p_id);
  c text;
begin
  select code into c from public.coop_invites where coop_id = p_id and expires_at > now() + interval '1 day' and uses < max_uses
  order by created_at desc limit 1;
  if c is not null then return c; end if;
  loop
    c := array_to_string(array(select substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 1 + floor(random() * 32)::int, 1) from generate_series(1, 8)), '');
    exit when not exists (select 1 from public.coop_invites where code = c);
  end loop;
  insert into public.coop_invites (code, coop_id, created_by) values (c, p_id, me);
  return c;
end;
$$;

drop function if exists public.coop_peek(text);
create or replace function public.coop_peek(p_code text)
returns table (id uuid, name text, emoji text, color text, members int, mine boolean, open boolean)
language sql
stable
security definer
set search_path = public
as $$
  select g.id, g.name, g.emoji, g.color,
         (select count(*)::int from public.coop_members m where m.coop_id = g.id),
         public.in_coop(g.id), i.expires_at > now() and i.uses < i.max_uses
  from public.coop_invites i join public.coops g on g.id = i.coop_id
  where i.code = upper(btrim(p_code)) and public.assert_member() is not null;
$$;

create or replace function public.coop_join(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  i public.coop_invites%rowtype;
begin
  select * into i from public.coop_invites where code = upper(btrim(p_code));
  if i.code is null then raise exception 'no coop with that code'; end if;
  if public.in_coop(i.coop_id) then return i.coop_id; end if;
  if i.expires_at <= now() or i.uses >= i.max_uses then raise exception 'that code is used up; ask for a new one'; end if;
  if (select count(*) from public.coop_members where coop_id = i.coop_id) >= 12 then raise exception 'the coop is full (12)'; end if;
  if (select count(*) from public.coop_members where user_id = me) >= 30 then raise exception 'at most 30 coops'; end if;
  insert into public.coop_members (coop_id, user_id) values (i.coop_id, me);
  update public.coop_invites set uses = uses + 1 where code = i.code;
  return i.coop_id;
end;
$$;

-- Tonight: the date a night belongs to is the evening it starts (before 12:00 counts as
-- the night before), so a plan set at 02:00 still means "tonight".
create or replace function public.night_of(p_at timestamptz default now())
returns date
language sql
stable
as $$
  select (p_at - interval '12 hours')::date;
$$;

create or replace function public.coop_night_set(p_id uuid, p_night date, p_slug text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.need_coop(p_id);
  pid uuid;
begin
  if p_night < public.night_of() then raise exception 'that night has passed'; end if;
  select id into pid from public.projects where slug = p_slug and is_published and status = 'open';
  if pid is null then raise exception 'no such project'; end if;
  insert into public.coop_nights (coop_id, night, project_id, set_by) values (p_id, p_night, pid, me)
  on conflict (coop_id, night) do update set project_id = excluded.project_id, set_by = me, set_at = now();
end;
$$;

-- The plan and the nights done: per night the project, who set it, and the coop's numbers
-- that night (contributions of its members on that project, that date).
drop function if exists public.coop_nights(uuid);
create or replace function public.coop_nights(p_id uuid)
returns table (night date, slug text, title text, model text, set_by text, phones int, tokens bigint, kwh numeric, credits numeric)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.need_coop(p_id);
  return query
  select n.night, r.slug, r.title, r.model, coalesce(p.handle, p.display_name),
         (select count(*)::int from public.contributions k join public.coop_members m on m.user_id = k.user_id and m.coop_id = p_id
           where k.project_id = n.project_id and k.card_no is not null and public.night_of(k.started_at) = n.night),
         coalesce((select sum(k.tokens) from public.contributions k join public.coop_members m on m.user_id = k.user_id and m.coop_id = p_id
           where k.project_id = n.project_id and k.card_no is not null and public.night_of(k.started_at) = n.night), 0)::bigint,
         coalesce((select sum(k.kwh) from public.contributions k join public.coop_members m on m.user_id = k.user_id and m.coop_id = p_id
           where k.project_id = n.project_id and k.card_no is not null and public.night_of(k.started_at) = n.night), 0),
         coalesce((select sum(k.credits) from public.contributions k join public.coop_members m on m.user_id = k.user_id and m.coop_id = p_id
           where k.project_id = n.project_id and k.card_no is not null and public.night_of(k.started_at) = n.night), 0)
  from public.coop_nights n join public.projects r on r.id = n.project_id left join public.profiles p on p.id = n.set_by
  where n.coop_id = p_id order by n.night desc;
end;
$$;

create or replace function public.coop_get(p_id uuid)
returns json
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.need_coop(p_id);
begin
  return (
    select json_build_object(
      'id', g.id, 'name', g.name, 'emoji', g.emoji, 'color', g.color, 'me', me,
      'members', (select json_agg(json_build_object('id', p.id, 'handle', p.handle, 'name', p.display_name, 'role', m.role,
                                                    'live', exists (select 1 from public.contributions k where k.user_id = p.id and k.ended_at is null)) order by m.joined_at)
                  from public.coop_members m join public.profiles p on p.id = m.user_id where m.coop_id = g.id),
      'tonight', (select json_build_object('slug', r.slug, 'title', r.title, 'model', r.model)
                  from public.coop_nights n join public.projects r on r.id = n.project_id where n.coop_id = g.id and n.night = public.night_of()),
      'nights', (select count(*)::int from public.coop_nights n where n.coop_id = g.id and n.night < public.night_of()))
    from public.coops g where g.id = p_id);
end;
$$;

drop function if exists public.my_coops();
create or replace function public.my_coops()
returns table (id uuid, name text, emoji text, color text, members int, role text, tonight_slug text, tonight_title text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
  select g.id, g.name, g.emoji, g.color, (select count(*)::int from public.coop_members x where x.coop_id = g.id), m.role, r.slug, r.title
  from public.coop_members m join public.coops g on g.id = m.coop_id
  left join public.coop_nights n on n.coop_id = g.id and n.night = public.night_of()
  left join public.projects r on r.id = n.project_id
  where m.user_id = me order by g.created_at desc;
end;
$$;

revoke execute on function public.coop_create(text, text, text, uuid[]), public.coop_update(uuid, text, text, text), public.coop_add(uuid, uuid[]),
  public.coop_leave(uuid), public.coop_remove(uuid, uuid), public.coop_delete(uuid), public.coop_invite(uuid), public.coop_peek(text), public.coop_join(text),
  public.coop_night_set(uuid, date, text), public.coop_nights(uuid), public.coop_get(uuid), public.my_coops() from public, anon;
grant execute on function public.coop_create(text, text, text, uuid[]), public.coop_update(uuid, text, text, text), public.coop_add(uuid, uuid[]),
  public.coop_leave(uuid), public.coop_remove(uuid, uuid), public.coop_delete(uuid), public.coop_invite(uuid), public.coop_peek(text), public.coop_join(text),
  public.coop_night_set(uuid, date, text), public.coop_nights(uuid), public.coop_get(uuid), public.my_coops() to authenticated;
grant execute on function public.night_of(timestamptz) to anon, authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('09_coops.sql', 'a848845a985d9dd41c6969653cc020d5ab97647b1697c48bd82613159631c269');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('09_coops.sql');
  end if;
end $$;
