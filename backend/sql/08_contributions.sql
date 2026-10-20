-- pasaport — the night: check-in, the card, the credits
--   contribution_start(slug, client_id, at)        the phone is on charge and starts the
--                                                  night on a kept project; returns the id.
--                                                  A retry with the same client_id returns
--                                                  the first. One open night per person.
--   contribution_end(id, tokens, seconds, kwh, at) the morning: the numbers, the card number,
--                                                  the credit line. Ending twice changes nothing.
--   contribution_open()                            the night still running, if any
--   my_cards()                                     your cards, newest first, with the project
--   person_cards(handle)                           a friend's cards
--   credits_mine()                                 the ledger and the total
--   friends_live()                                 which friends are in a night right now
-- The credit: tokens / 1000 × params_b / 7. 4 W is the assumption the phone also uses;
-- the server trusts the phone's kwh and seconds but caps tokens at est_tps × seconds × 1.5
-- when there is a passport to compare with, so a wrong clock cannot mint credits.

create or replace function public.contribution_start(p_slug text, p_client_id uuid, p_at timestamptz default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  pid uuid;
  cid uuid;
  at timestamptz := least(coalesce(p_at, now()), now());
begin
  select id into cid from public.contributions where user_id = me and client_id = p_client_id;
  if cid is not null then return cid; end if;
  select r.id into pid from public.projects r where r.slug = p_slug and r.is_published and r.status = 'open';
  if pid is null then raise exception 'noproject' using errcode = '22023'; end if;
  if not exists (select 1 from public.joins j where j.user_id = me and j.project_id = pid and j.direction = 'right') then
    raise exception 'notkept' using errcode = '22023';
  end if;
  if at < now() - interval '12 hours' then at := now(); end if;
  -- a night left open is closed with what it had (the phone died, the app was killed)
  update public.contributions set ended_at = started_at where user_id = me and ended_at is null;
  insert into public.contributions (user_id, project_id, client_id, started_at) values (me, pid, p_client_id, at) returning id into cid;
  return cid;
end;
$$;

create or replace function public.contribution_end(p_id uuid, p_tokens bigint, p_seconds int, p_kwh numeric, p_at timestamptz default null)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  k public.contributions%rowtype;
  tps numeric;
  cap bigint;
  w numeric;
  amount numeric;
  at timestamptz := least(coalesce(p_at, now()), now());
begin
  select * into k from public.contributions where id = p_id and user_id = me;
  if k.id is null then raise exception 'nonight' using errcode = '22023'; end if;
  if k.ended_at is not null then return k.card_no; end if;
  if at < k.started_at then at := now(); end if;
  tps := (select (p.data ->> 'est_tps')::numeric from public.passports p where p.user_id = me order by p.measured_at desc limit 1);
  cap := case when tps is null or tps <= 0 then greatest(coalesce(p_tokens, 0), 0)
              else least(greatest(coalesce(p_tokens, 0), 0), ceil(tps * greatest(coalesce(p_seconds, 0), 0) * 1.5)::bigint) end;
  select r.params_b / 7 into w from public.projects r where r.id = k.project_id;
  amount := round(cap / 1000.0 * w, 2);
  update public.contributions set ended_at = at, tokens = cap, seconds = greatest(coalesce(p_seconds, 0), 0),
         kwh = greatest(coalesce(p_kwh, 0), 0), credits = amount, card_no = nextval('public.card_no_seq')
   where id = k.id returning card_no into k.card_no;
  insert into public.credits (user_id, contribution_id, project_id, weight, amount) values (me, k.id, k.project_id, round(w, 4), amount)
  on conflict (contribution_id) do nothing;
  return k.card_no;
end;
$$;

drop function if exists public.contribution_open();
create or replace function public.contribution_open()
returns table (id uuid, slug text, title text, model text, started_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query select k.id, r.slug, r.title, r.model, k.started_at
  from public.contributions k join public.projects r on r.id = k.project_id
  where k.user_id = me and k.ended_at is null order by k.started_at desc limit 1;
end;
$$;

-- A card: the night's numbers and the project it was for; crew = friends on the same
-- project that night (first names, up to five), as initials on the back of the card.
drop function if exists public.cards_of(uuid, uuid);
create or replace function public.cards_of(p_viewer uuid, p_who uuid)
returns table (card_no bigint, started_at timestamptz, ended_at timestamptz, tokens bigint, seconds int, kwh numeric, credits numeric,
               slug text, title text, model text, org text, city_name text, poster_no int, image_url text,
               night_no int, crew text[], crew_more int)
language sql
stable
security definer
set search_path = public
as $$
  select k.card_no, k.started_at, k.ended_at, k.tokens, k.seconds, k.kwh, k.credits,
         r.slug, r.title, r.model, r.org, c.name, r.poster_no, r.image_url,
         (select count(*)::int from public.contributions x where x.user_id = p_who and x.project_id = k.project_id and x.card_no is not null and x.ended_at <= k.ended_at),
         coalesce((select array_agg(n order by n) from (
            select coalesce(p.handle, p.display_name) n from public.contributions o join public.profiles p on p.id = o.user_id
            where o.project_id = k.project_id and o.card_no is not null and o.user_id <> p_who
              and o.started_at::date = k.started_at::date and public.are_friends(p_viewer, o.user_id) and public.reachable(p_viewer, o.user_id)
            limit 5) s), '{}'),
         greatest(0, (select count(*)::int from public.contributions o
            where o.project_id = k.project_id and o.card_no is not null and o.user_id <> p_who and o.started_at::date = k.started_at::date) - 5)
  from public.contributions k join public.projects r on r.id = k.project_id left join public.cities c on c.id = r.city_id
  where k.user_id = p_who and k.card_no is not null
  order by k.ended_at desc;
$$;
revoke execute on function public.cards_of(uuid, uuid) from public, anon, authenticated;

drop function if exists public.my_cards();
create or replace function public.my_cards()
returns table (card_no bigint, started_at timestamptz, ended_at timestamptz, tokens bigint, seconds int, kwh numeric, credits numeric,
               slug text, title text, model text, org text, city_name text, poster_no int, image_url text,
               night_no int, crew text[], crew_more int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query select * from public.cards_of(me, me);
end;
$$;

drop function if exists public.person_cards(text);
create or replace function public.person_cards(p_handle text)
returns table (card_no bigint, started_at timestamptz, ended_at timestamptz, tokens bigint, seconds int, kwh numeric, credits numeric,
               slug text, title text, model text, org text, city_name text, poster_no int, image_url text,
               night_no int, crew text[], crew_more int)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
  who uuid := public.handle_to_id(p_handle);
begin
  if who is null or not public.are_friends(me, who) or not public.reachable(me, who) then return; end if;
  return query select * from public.cards_of(me, who);
end;
$$;

drop function if exists public.credits_mine();
create or replace function public.credits_mine()
returns table (id bigint, amount numeric, weight numeric, slug text, title text, card_no bigint, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query select c.id, c.amount, c.weight, r.slug, r.title, k.card_no, c.created_at
  from public.credits c join public.projects r on r.id = c.project_id join public.contributions k on k.id = c.contribution_id
  where c.user_id = me order by c.created_at desc;
end;
$$;

drop function if exists public.friends_live();
create or replace function public.friends_live()
returns table (handle text, display_name text, slug text, title text, started_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return query select p.handle, p.display_name, r.slug, r.title, k.started_at
  from public.contributions k join public.profiles p on p.id = k.user_id join public.projects r on r.id = k.project_id
  where k.ended_at is null and k.started_at > now() - interval '14 hours'
    and public.are_friends(me, k.user_id) and public.reachable(me, k.user_id)
  order by k.started_at desc;
end;
$$;

revoke execute on function public.contribution_start(text, uuid, timestamptz), public.contribution_end(uuid, bigint, int, numeric, timestamptz),
  public.contribution_open(), public.my_cards(), public.person_cards(text), public.credits_mine(), public.friends_live() from public, anon;
grant execute on function public.contribution_start(text, uuid, timestamptz), public.contribution_end(uuid, bigint, int, numeric, timestamptz),
  public.contribution_open(), public.my_cards(), public.person_cards(text), public.credits_mine(), public.friends_live() to authenticated;

create or replace function public.export_me()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  me uuid := public.assert_member();
begin
  return jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) - 'is_admin' from public.profiles p where p.id = me),
    'settings', (select to_jsonb(s) from public.profile_settings s where s.user_id = me),
    'joins', (select coalesce(jsonb_agg(jsonb_build_object('project', r.slug, 'direction', j.direction, 'at', j.created_at)), '[]')
              from public.joins j join public.projects r on r.id = j.project_id where j.user_id = me),
    'friends', (select coalesce(jsonb_agg(jsonb_build_object('handle', p.handle, 'status', f.status)), '[]')
                from public.friendships f join public.profiles p on p.id = case when f.requester_id = me then f.addressee_id else f.requester_id end
                where me in (f.requester_id, f.addressee_id)),
    'passports', (select coalesce(jsonb_agg(p.data order by p.measured_at desc), '[]') from public.passports p where p.user_id = me),
    'nights', (select coalesce(jsonb_agg(jsonb_build_object('project', r.slug, 'card_no', k.card_no, 'started_at', k.started_at, 'ended_at', k.ended_at,
                 'tokens', k.tokens, 'seconds', k.seconds, 'kwh', k.kwh, 'credits', k.credits) order by k.started_at), '[]')
               from public.contributions k join public.projects r on r.id = k.project_id where k.user_id = me));
end;
$$;

do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('08_contributions.sql', '7058a5f9101244e4ab9499c820b5d16b7d2925ab814bcb3f0cc0c54bea3e88fa');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('08_contributions.sql');
  end if;
end $$;
