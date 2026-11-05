-- kula — the night on the server (5.11.2026, backend-night)
-- The phone works a project while on charge and writes a morning report (app/src/night/report.ts).
-- Until now that report stayed on the phone; from here it reaches the server as NUMBERS ONLY:
-- how many units, how many checked and wrong, tokens, seconds, tok/s, wh. Never a prompt,
-- never an answer, never a model output. The brain's auditor ledger (audit/) also stays on
-- the phone; only its head (last hash + signature) is kept here, so v1 can collect the
-- ledgers later and verify nobody rewrote one in the meantime.
--
--   night_report(report, client_id)   the morning report as one json; a retry with the same
--                                     client id, or the same device + project + night again,
--                                     finds the first row and changes nothing (idempotent)
--   night_units_add(report, units)    optional detail: per unit tokens / ms / ok, no content
--   night_reports(limit)              your reports, newest first
--   night_mine_summary()              per project you reported on: nights this month, nights
--                                     in all, the current streak of this device (the cards)
--   project_summary(slug)             the owner of a project (projects.owner_id) or an admin:
--                                     per month nights, phones, units, accuracy, tokens, wh
--   night_leaderboard(limit)          the last 30 days by nights and units, by handle (the
--                                     nickname), only people whose kept_visibility is friends
--   ledger_head_set(device, seq, hash, sig, alg)   the device ledger's head; seq never goes back
--   ledger_head_mine()                the heads of your devices
--
-- Tables: night_reports, night_units, device_ledger_heads. RLS: a signed-in person reads and
-- writes their own rows (the functions are the normal way in; the policies make the same
-- promise if a client ever reads a table directly). Nobody reads another person's rows
-- through the tables; a project's owner reads totals through project_summary() only.
-- Views: night_project_months (per project and month), night_device_streaks (per device),
-- night_leaderboard_30d (by handle). The views are read through the functions, not granted.

-- --------------------------------------------------------------- owner
-- A project's owner reads its totals. Set by hand (or the panel); null = only an admin.
alter table public.projects add column if not exists owner_id uuid references public.profiles on delete set null;
create index if not exists projects_owner_idx on public.projects (owner_id);

-- -------------------------------------------------------------- tables
create table if not exists public.night_reports (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles on delete cascade,
  -- the passport's device id (app/src/data/passport.ts deviceId()): one install, one id
  device_id    uuid not null,
  project_id   uuid not null references public.projects on delete cascade,
  -- the date the night's window opened on (report.ts windowKey)
  night        date not null,
  client_id    uuid not null,
  units        int not null check (units between 0 and 1000000),
  checked      int not null check (checked between 0 and 1000000),
  wrong        int not null check (wrong between 0 and 1000000),
  tokens       bigint not null check (tokens between 0 and 1000000000),
  seconds      int not null check (seconds between 0 and 86400),
  segments     int not null default 1 check (segments between 1 and 1000),
  devices      int not null default 1 check (devices between 1 and 64),
  tps          numeric(9,1) not null check (tps between 0 and 100000),
  wh           numeric(9,2) not null check (wh between 0 and 10000),
  app_version  text check (app_version is null or length(app_version) <= 32),
  model        text check (model is null or length(model) <= 120),
  mode         text not null check (mode in ('real', 'sim')),
  created_at   timestamptz not null default now(),
  check (checked <= units and wrong <= checked),
  unique (user_id, client_id),
  unique (user_id, device_id, project_id, night)
);
create index if not exists night_reports_project_idx on public.night_reports (project_id, night);
create index if not exists night_reports_user_idx on public.night_reports (user_id, night desc);

-- One line per unit when the phone chooses to send detail: the unit's number in the night,
-- its tokens and milliseconds, and for a known-answer unit whether it came out right.
-- No unit id from the project, no text.
create table if not exists public.night_units (
  report_id  uuid not null references public.night_reports on delete cascade,
  idx        int not null check (idx between 0 and 1000000),
  tokens     int not null check (tokens between 0 and 1000000),
  ms         int not null check (ms between 0 and 86400000),
  ok         boolean,
  primary key (report_id, idx)
);

-- The auditor's ledger stays on the phone. Its head comes here: the sequence number, the
-- hash of the last entry and the device's signature over it. Content never.
create table if not exists public.device_ledger_heads (
  user_id     uuid not null references public.profiles on delete cascade,
  device_id   uuid not null,
  seq         bigint not null check (seq >= 0),
  head_hash   text not null check (head_hash ~ '^[0-9a-f]{64}$'),
  signature   text not null check (length(signature) between 16 and 1024),
  alg         text not null default 'ed25519' check (alg in ('ed25519', 'hmac-sha256')),
  updated_at  timestamptz not null default now(),
  primary key (user_id, device_id)
);

-- ----------------------------------------------------------------- rls
alter table public.night_reports enable row level security;
alter table public.night_units enable row level security;
alter table public.device_ledger_heads enable row level security;
revoke all on public.night_reports, public.night_units, public.device_ledger_heads from public, anon;
grant select, insert on public.night_reports, public.night_units to authenticated;
grant select, insert, update on public.device_ledger_heads to authenticated;

drop policy if exists night_reports_own_read on public.night_reports;
create policy night_reports_own_read on public.night_reports for select to authenticated using (user_id = auth.uid());
drop policy if exists night_reports_own_write on public.night_reports;
create policy night_reports_own_write on public.night_reports for insert to authenticated with check (user_id = auth.uid());
drop policy if exists night_units_own_read on public.night_units;
create policy night_units_own_read on public.night_units for select to authenticated
  using (exists (select 1 from public.night_reports r where r.id = report_id and r.user_id = auth.uid()));
drop policy if exists night_units_own_write on public.night_units;
create policy night_units_own_write on public.night_units for insert to authenticated
  with check (exists (select 1 from public.night_reports r where r.id = report_id and r.user_id = auth.uid()));
drop policy if exists ledger_heads_own_read on public.device_ledger_heads;
create policy ledger_heads_own_read on public.device_ledger_heads for select to authenticated using (user_id = auth.uid());
drop policy if exists ledger_heads_own_write on public.device_ledger_heads;
create policy ledger_heads_own_write on public.device_ledger_heads for insert to authenticated with check (user_id = auth.uid());
drop policy if exists ledger_heads_own_update on public.device_ledger_heads;
create policy ledger_heads_own_update on public.device_ledger_heads for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- --------------------------------------------------------------- views
-- Read through the functions below; not granted to anon or authenticated.
create or replace view public.night_project_months as
  select r.project_id, date_trunc('month', r.night)::date as month,
         count(*)::int as nights, count(distinct r.device_id)::int as phones, count(distinct r.user_id)::int as people,
         sum(r.units)::bigint as units, sum(r.checked)::bigint as checked, sum(r.wrong)::bigint as wrong,
         sum(r.tokens)::bigint as tokens, sum(r.seconds)::bigint as seconds, round(sum(r.wh), 2) as wh,
         count(*) filter (where r.mode = 'real')::int as real_nights
  from public.night_reports r
  group by r.project_id, 2;

-- A device's streak: consecutive nights (any project) ending on its last night.
create or replace view public.night_device_streaks as
  with nights as (
    select distinct user_id, device_id, night from public.night_reports),
  runs as (
    select user_id, device_id, night,
           night - (row_number() over (partition by user_id, device_id order by night))::int as grp
    from nights),
  grouped as (
    select user_id, device_id, min(night) as first_night, max(night) as last_night, count(*)::int as streak
    from runs group by user_id, device_id, grp)
  select distinct on (user_id, device_id) user_id, device_id, streak, first_night, last_night
  from grouped order by user_id, device_id, last_night desc;

create or replace view public.night_leaderboard_30d as
  select p.id as user_id, p.handle,
         count(distinct r.night)::int as nights, sum(r.units)::bigint as units, sum(r.tokens)::bigint as tokens
  from public.night_reports r
  join public.profiles p on p.id = r.user_id
  left join public.profile_settings s on s.user_id = p.id
  where r.night > current_date - 30 and p.handle is not null
    and coalesce(s.kept_visibility, 'friends') = 'friends'
    and not exists (select 1 from public.bans b where b.user_id = p.id)
  group by p.id, p.handle;

revoke all on public.night_project_months, public.night_device_streaks, public.night_leaderboard_30d from public, anon, authenticated;

-- ----------------------------------------------------------- functions
-- The report as the phone keeps it (NightReport): id "2026-11-05", slug, device_id, units,
-- checked, wrong, tokens, seconds, segments, tps, wh, model, real, app_version, devices[].
-- Only numbers and names of things are read out of it; the json itself is not stored.
create or replace function public.night_report(p_report jsonb, p_client_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  found_id uuid;
  proj uuid;
  dev uuid;
  v_night date;
  v_units int; v_checked int; v_wrong int; v_tokens bigint; v_seconds int; v_segments int; v_devices int;
  v_tps numeric; v_wh numeric; v_mode text;
begin
  if p_client_id is null then raise exception 'client id missing' using errcode = '22023'; end if;
  select id into found_id from public.night_reports where user_id = me and client_id = p_client_id;
  if found_id is not null then return found_id; end if;
  if p_report is null or jsonb_typeof(p_report) <> 'object' then raise exception 'not a report' using errcode = '22023'; end if;
  if length(p_report::text) > 16384 then raise exception 'report too large' using errcode = '22023'; end if;

  select p.id into proj from public.projects p where p.slug = p_report ->> 'slug';
  if proj is null then raise exception 'noproject' using errcode = '22023'; end if;
  begin
    dev := (p_report ->> 'device_id')::uuid;
  exception when others then dev := null; end;
  if dev is null then raise exception 'device id missing' using errcode = '22023'; end if;
  begin
    v_night := (p_report ->> 'id')::date;
  exception when others then v_night := null; end;
  if v_night is null or v_night < current_date - 7 or v_night > current_date + 1 then raise exception 'night out of range' using errcode = '22023'; end if;

  v_units := coalesce((p_report ->> 'units')::int, 0);
  v_checked := coalesce((p_report ->> 'checked')::int, 0);
  v_wrong := coalesce((p_report ->> 'wrong')::int, 0);
  v_tokens := coalesce((p_report ->> 'tokens')::bigint, 0);
  v_seconds := coalesce((p_report ->> 'seconds')::int, 0);
  v_segments := greatest(coalesce((p_report ->> 'segments')::int, 1), 1);
  v_devices := greatest(coalesce(jsonb_array_length(case when jsonb_typeof(p_report -> 'devices') = 'array' then p_report -> 'devices' else '[]'::jsonb end), 1), 1);
  v_tps := coalesce((p_report ->> 'tps')::numeric, case when v_seconds > 0 then round(v_tokens::numeric / v_seconds, 1) else 0 end);
  v_wh := coalesce((p_report ->> 'wh')::numeric, 0);
  v_mode := case when coalesce(p_report ->> 'real', 'false') = 'true' then 'real' else 'sim' end;
  if v_units < 0 or v_checked < 0 or v_wrong < 0 or v_tokens < 0 or v_seconds < 0 or v_tps < 0 or v_wh < 0
     or v_checked > v_units or v_wrong > v_checked then raise exception 'counts do not add up' using errcode = '22023'; end if;
  if v_seconds > 86400 or v_units > 1000000 or v_tokens > 1000000000 or v_tps > 100000 or v_wh > 10000 then
    raise exception 'out of bounds' using errcode = '22023'; end if;
  -- a night of 0 seconds cannot have made tokens; tok/s must fit the seconds (a little slack)
  if v_seconds = 0 and v_tokens > 0 then raise exception 'counts do not add up' using errcode = '22023'; end if;
  if v_seconds > 0 and v_tps > (v_tokens::numeric / v_seconds) * 1.5 + 1 then raise exception 'counts do not add up' using errcode = '22023'; end if;

  -- the same device, project and night again (a second install id, a lost outbox): the first row stands
  select id into found_id from public.night_reports where user_id = me and device_id = dev and project_id = proj and night = v_night;
  if found_id is not null then return found_id; end if;

  insert into public.night_reports (user_id, device_id, project_id, night, client_id, units, checked, wrong, tokens, seconds, segments, devices, tps, wh, app_version, model, mode)
  values (me, dev, proj, v_night, p_client_id, v_units, v_checked, v_wrong, v_tokens, v_seconds, least(v_segments, 1000), least(v_devices, 64), v_tps, v_wh,
          left(p_report ->> 'app_version', 32), left(p_report ->> 'model', 120), v_mode)
  returning id into found_id;
  return found_id;
end;
$$;

-- Detail for a report of yours: [{idx, tokens, ms, ok}] (at most 2000 a call). Lines already
-- there stay as they are, so a retry adds nothing twice.
create or replace function public.night_units_add(p_report_id uuid, p_units jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  n int;
begin
  if not exists (select 1 from public.night_reports r where r.id = p_report_id and r.user_id = me) then
    raise exception 'nonight' using errcode = '22023'; end if;
  if p_units is null or jsonb_typeof(p_units) <> 'array' then raise exception 'not units' using errcode = '22023'; end if;
  if jsonb_array_length(p_units) > 2000 then raise exception 'too many units' using errcode = '22023'; end if;
  insert into public.night_units (report_id, idx, tokens, ms, ok)
  select p_report_id, (u ->> 'idx')::int, coalesce((u ->> 'tokens')::int, 0), coalesce((u ->> 'ms')::int, 0),
         case when u ? 'ok' and jsonb_typeof(u -> 'ok') = 'boolean' then (u ->> 'ok')::boolean else null end
  from jsonb_array_elements(p_units) u
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.night_reports(p_limit int default 30)
returns table (id uuid, device_id uuid, slug text, title text, night date, units int, checked int, wrong int, tokens bigint,
               seconds int, segments int, devices int, tps numeric, wh numeric, model text, mode text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
    select r.id, r.device_id, p.slug, p.title, r.night, r.units, r.checked, r.wrong, r.tokens, r.seconds, r.segments, r.devices,
           r.tps, r.wh, r.model, r.mode, r.created_at
    from public.night_reports r join public.projects p on p.id = r.project_id
    where r.user_id = me order by r.night desc, r.created_at desc
    limit least(greatest(coalesce(p_limit, 30), 1), 200);
end;
$$;

-- Per project: nights this month and in all; plus the streak of the asking device (p_device_id,
-- null = the longest among your devices). "this project, this month: X nights".
create or replace function public.night_mine_summary(p_device_id uuid default null)
returns table (slug text, title text, nights_month int, nights_total int, units_month bigint, wh_month numeric, last_night date, streak int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query
    select p.slug, p.title,
           count(distinct r.night) filter (where r.night >= date_trunc('month', current_date)::date)::int,
           count(distinct r.night)::int,
           coalesce(sum(r.units) filter (where r.night >= date_trunc('month', current_date)::date), 0)::bigint,
           coalesce(round(sum(r.wh) filter (where r.night >= date_trunc('month', current_date)::date), 2), 0),
           max(r.night),
           coalesce((select max(s.streak) from public.night_device_streaks s
                      where s.user_id = me and (p_device_id is null or s.device_id = p_device_id)
                        and s.last_night >= current_date - 1), 0)::int
    from public.night_reports r join public.projects p on p.id = r.project_id
    where r.user_id = me
    group by p.id, p.slug, p.title
    order by max(r.night) desc;
end;
$$;

-- The owner's view of a project, or an admin's: per month, counts only.
create or replace function public.project_summary(p_slug text)
returns table (month date, nights int, phones int, people int, units bigint, checked bigint, wrong bigint, tokens bigint, seconds bigint, wh numeric, real_nights int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  proj uuid;
begin
  select p.id into proj from public.projects p where p.slug = p_slug and (p.owner_id = me or public.is_admin());
  if proj is null then raise exception 'not the owner' using errcode = '42501'; end if;
  return query
    select m.month, m.nights, m.phones, m.people, m.units, m.checked, m.wrong, m.tokens, m.seconds, m.wh, m.real_nights
    from public.night_project_months m where m.project_id = proj order by m.month desc;
end;
$$;

-- The last 30 days by handle; anyone signed in may look. Only people who show their kept
-- projects (kept_visibility = friends) appear; private stays private.
create or replace function public.night_leaderboard(p_limit int default 20)
returns table (handle text, nights int, units bigint, tokens bigint, me boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  who uuid := public.assert_member();
begin
  return query
    select l.handle, l.nights, l.units, l.tokens, l.user_id = who
    from public.night_leaderboard_30d l
    order by l.nights desc, l.units desc, l.handle
    limit least(greatest(coalesce(p_limit, 20), 1), 100);
end;
$$;

-- The ledger head: seq must move forward (equal with the same hash is a retry and fine).
create or replace function public.ledger_head_set(p_device_id uuid, p_seq bigint, p_hash text, p_signature text, p_alg text default 'ed25519')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  have record;
begin
  if p_device_id is null then raise exception 'device id missing' using errcode = '22023'; end if;
  select seq, head_hash into have from public.device_ledger_heads where user_id = me and device_id = p_device_id;
  if have.seq is not null then
    if p_seq < have.seq or (p_seq = have.seq and p_hash <> have.head_hash) then
      raise exception 'ledger head goes back' using errcode = '22023'; end if;
  end if;
  insert into public.device_ledger_heads (user_id, device_id, seq, head_hash, signature, alg)
  values (me, p_device_id, p_seq, p_hash, p_signature, coalesce(p_alg, 'ed25519'))
  on conflict (user_id, device_id) do update set seq = excluded.seq, head_hash = excluded.head_hash,
    signature = excluded.signature, alg = excluded.alg, updated_at = now();
end;
$$;

create or replace function public.ledger_head_mine()
returns table (device_id uuid, seq bigint, head_hash text, alg text, updated_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query select h.device_id, h.seq, h.head_hash, h.alg, h.updated_at from public.device_ledger_heads h where h.user_id = me order by h.updated_at desc;
end;
$$;

revoke execute on function public.night_report(jsonb, uuid), public.night_units_add(uuid, jsonb), public.night_reports(int),
  public.night_mine_summary(uuid), public.project_summary(text), public.night_leaderboard(int),
  public.ledger_head_set(uuid, bigint, text, text, text), public.ledger_head_mine() from public, anon;
grant execute on function public.night_report(jsonb, uuid), public.night_units_add(uuid, jsonb), public.night_reports(int),
  public.night_mine_summary(uuid), public.project_summary(text), public.night_leaderboard(int),
  public.ledger_head_set(uuid, bigint, text, text, text), public.ledger_head_mine() to authenticated;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('18_night.sql', 'fcfc131f06f3653cfce7ebfaa0e25b5a72362cb2029b3bc92a11837d5268d600');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('18_night.sql');
  end if;
end $$;
