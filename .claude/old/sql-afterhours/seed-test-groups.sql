-- afterhours — fake friends and nights to try the groups end to end. A one-shot
-- for the live database (Supabase SQL editor), AFTER 44 to 48. Running it again
-- first removes what an earlier run made, then makes it fresh.
-- cleanup-test-groups.sql removes all of it.
--
-- You are found by your e-mail (change it below if you sign in with another).
-- Six fake people (fake-…@afterhours.test, no password: nobody can sign in as
-- them) become your friends, and then:
--
--   🪩 cuma ekibi (test)   yours, with four of them, in München:
--                          · they swiped the next nights; three nights wait only
--                            for your yes, so your swipe makes a match
--                          · a vote is open (selin started it, two voted)
--                          · a plan for a night with a ticket link: who comes,
--                            who has a ticket
--                          · a chat with a few lines
--                          · they are "here" in live for 24 hours and answered
--                            every card, so live moves on with each of your answers
--                          · three past nights you went to together (all of you
--                            at one): the shelf, the numbers, the vibe
--   🎧 techno (test)       theirs, visible, with the same plan as yours and a
--                          friend of yours in it: "… is going too"
--   🎉 cumartesi (test)    a group for once, this saturday
--   three posts from them in yours
--
-- Your notifications are switched off while this runs and switched back after,
-- so the phone does not buzz for every fake line.

do $$
declare
  my_email text := 'you@example.com';
  me uuid;
  saved jsonb;
  people text[][] := array[
    array['selin', 'Selin'], array['mert', 'Mert'], array['deniz', 'Deniz'],
    array['can', 'Can'], array['ece', 'Ece'], array['bora', 'Bora']];
  ids uuid[] := '{}';
  p text[];
  u uuid;
  munich uuid;
  club uuid;
  nights uuid[];
  past uuid[] := '{}';
  g uuid;
  techno uuid;
  once uuid;
  r uuid;
  plan uuid;
  i int;
  k int;
begin
  select id into me from auth.users where lower(email) = lower(my_email);
  if me is null then raise exception 'no account with the e-mail %', my_email; end if;
  select id into munich from public.cities where slug = 'munchen';
  if munich is null then raise exception 'no city munchen'; end if;

  -- an earlier run goes first
  delete from public.groups where name like '% (test)';
  delete from public.events where source = 'fake';
  delete from auth.users where email like 'fake-%@afterhours.test';

  -- every switch off while this runs (check-ins, friends, groups, posts would all
  -- reach your phone); the row as it was goes back at the end
  select to_jsonb(s) into saved from public.profile_settings s where user_id = me;
  update public.profile_settings set (notify_requests, notify_accepts, notify_matches, notify_live, notify_nights, notify_rooms,
         notify_replies, notify_digest, notify_djs, notify_waves, notify_sparks, notify_groups, notify_posts, notify_email)
       = (false, false, false, false, false, false, false, false, false, false, false, false, false, false)
   where user_id = me;

  -- ------------------------------------------------------------ the people
  foreach p slice 1 in array people loop
    u := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    values ('00000000-0000-0000-0000-000000000000', u, 'authenticated', 'authenticated',
            'fake-' || p[1] || '@afterhours.test', '', now(),
            '{"provider":"email","providers":["email"]}', jsonb_build_object('name', p[2]), now(), now());
    -- the profile row comes from the sign-up trigger; make sure of it anyway
    insert into public.profiles (id) values (u) on conflict (id) do nothing;
    update public.profiles set handle = 'test_' || p[1], display_name = p[2], onboarded_at = coalesce(onboarded_at, now()) where id = u;
    insert into public.friendships (requester_id, addressee_id, status) values (u, me, 'accepted')
    on conflict (requester_id, addressee_id) do update set status = 'accepted';
    ids := ids || u;
  end loop;
  -- they know each other too
  insert into public.friendships (requester_id, addressee_id, status)
  select ids[a], ids[b], 'accepted' from generate_series(1, 6) a, generate_series(1, 6) b where a < b
  on conflict do nothing;

  -- ------------------------------------------------------------ the nights
  nights := array(select e.id from public.events e
                  where e.city_id = munich and e.is_published and e.starts_at > now() + interval '20 hours'
                  order by e.starts_at, e.id limit 24);
  if cardinality(nights) < 8 then raise exception 'too few nights ahead in München (%)', cardinality(nights); end if;

  -- each keeps a few on their own; the first three by all, so the group's deck
  -- (sorted by its taste) puts them first and your first yes makes a match
  for i in 1..6 loop
    insert into public.swipes (user_id, event_id, direction)
    select ids[i], x, 'right' from unnest(nights[1:3] || nights[i + 6:i + 8]) x on conflict do nothing;
  end loop;

  -- three past nights, only for the groups (not published: the deck never shows them)
  select id into club from public.venues where city_id = munich order by name limit 1;
  for i in 1..3 loop
    insert into public.events (slug, city_id, type_id, venue_id, title, meta, body, starts_at, date_text,
                               is_published, source, image_url)
    values ('fake-night-' || i || '-' || substr(md5(random()::text), 1, 6), munich,
            (select id from public.event_types order by sort_order offset (i - 1) % 2 limit 1), club,
            (array['Keller Rave', 'Sonntag am Fluss', 'Blitz Allnighter'])[i], 'test night', 'a night from the test data',
            date_trunc('day', now()) - make_interval(days => 7 * i) + interval '23 hours', 'test',
            false, 'fake',
            (array['https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=1080',
                   'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?w=1080',
                   'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?w=1080'])[i])
    returning id into u;
    past := past || u;
  end loop;

  -- ------------------------------------------------------------ cuma ekibi
  insert into public.groups (name, emoji, color, kind, city_slug, created_by)
  values ('cuma ekibi (test)', '🪩', 'red', 'lasting', 'munchen', me) returning id into g;
  insert into public.group_members (group_id, user_id, role, joined_at) values (g, me, 'owner', now() - interval '3 weeks');
  for i in 1..4 loop
    insert into public.group_members (group_id, user_id, joined_at) values (g, ids[i], now() - interval '3 weeks' + make_interval(mins => i));
  end loop;

  -- the four of them answered the first 24 nights: 1-3 all yes (your yes makes the
  -- match), 4-6 three of four, the rest mixed
  for k in 1..cardinality(nights) loop
    for i in 1..4 loop
      insert into public.group_swipes (group_id, user_id, event_id, direction)
      values (g, ids[i], nights[k],
              case when k <= 3 then 'right' when k <= 6 then (case when i = 4 then 'left' else 'right' end)
                   when (k + i) % 3 = 0 then 'right' else 'left' end)
      on conflict do nothing;
    end loop;
  end loop;

  -- the plan: one of nights 1 to 3 that has a ticket link (else night 2); who
  -- comes and who has a ticket. Real nights are never changed here.
  plan := coalesce((select e.id from public.events e where e.id = any(nights[1:3]) and e.ticket_url is not null order by e.starts_at limit 1), nights[2]);
  update public.groups set plan_event_id = plan, plan_set_by = ids[1], plan_set_at = now() - interval '2 hours' where id = g;
  insert into public.rsvps (user_id, event_id, answer) values
    (ids[1], plan, 'in'), (ids[2], plan, 'in'), (ids[3], plan, 'maybe'), (ids[4], plan, 'out')
  on conflict (user_id, event_id) do update set answer = excluded.answer;
  insert into public.group_tickets (group_id, event_id, user_id) values (g, plan, ids[1]) on conflict do nothing;

  -- a vote is open: nights 4, 5, 6 for 24 hours, selin and mert voted
  insert into public.group_rounds (group_id, started_by, closes_at, created_at)
  values (g, ids[1], now() + interval '23 hours', now() - interval '1 hour') returning id into r;
  insert into public.group_round_options (round_id, event_id) values (r, nights[4]), (r, nights[5]), (r, nights[6]);
  insert into public.group_ballots (round_id, user_id, event_id) values (r, ids[1], nights[4]), (r, ids[2], nights[5]);

  -- the chat
  insert into public.group_messages (group_id, user_id, kind, body, event_id, created_at) values
    (g, ids[1], 'plan', (select title from public.events where id = plan), plan, now() - interval '2 hours'),
    (g, ids[1], 'say', 'ben biletimi aldım, kim geliyor?', null, now() - interval '110 minutes'),
    (g, ids[2], 'say', 'ben varım 🙌', null, now() - interval '100 minutes'),
    (g, ids[3], 'say', 'belki, cumartesi işim var', null, now() - interval '90 minutes'),
    (g, ids[1], 'round', (select string_agg(title, ' · ') from public.events where id in (nights[4], nights[5], nights[6])), null, now() - interval '60 minutes'),
    (g, ids[4], 'say', 'bu sefer ben yokum, sonraki sefere', null, now() - interval '30 minutes'),
    (g, ids[2], 'say', 'oylamaya bakın, akşama kadar kapanıyor', null, now() - interval '5 minutes');

  -- live: they are there for 24 hours and answered everything above
  insert into public.group_live (group_id, user_id, seen_at)
  select g, ids[j], now() + interval '24 hours' from generate_series(1, 3) n(j)
  on conflict (group_id, user_id) do update set seen_at = excluded.seen_at;

  -- the past: you and them at three nights (all five at the first)
  insert into public.checkins (user_id, event_id, checked_at)
  select x.who, past[1], now() - interval '7 days' from unnest(array[me, ids[1], ids[2], ids[3], ids[4]]) x(who)
  union all select x.who, past[2], now() - interval '14 days' from unnest(array[me, ids[1], ids[2]]) x(who)
  union all select x.who, past[3], now() - interval '21 days' from unnest(array[me, ids[3], ids[4]]) x(who)
  on conflict (user_id, event_id) do nothing;

  -- ------------------------------------------------------------ techno (also there)
  insert into public.groups (name, emoji, color, kind, city_slug, created_by, visible, plan_event_id, plan_set_at)
  values ('techno (test)', '🎧', 'blue', 'lasting', 'munchen', ids[5], true, plan, now()) returning id into techno;
  insert into public.group_members (group_id, user_id, role) values (techno, ids[5], 'owner'), (techno, ids[6], 'member');

  -- ------------------------------------------------------------ cumartesi (once)
  insert into public.groups (name, emoji, color, kind, city_slug, date_from, date_to, created_by)
  values ('cumartesi (test)', '🎉', 'gold', 'once', 'munchen',
          current_date + ((6 - extract(dow from current_date)::int + 7) % 7),
          current_date + ((6 - extract(dow from current_date)::int + 7) % 7), ids[2])
  returning id into once;
  insert into public.group_members (group_id, user_id, role) values (once, ids[2], 'owner'), (once, me, 'member'), (once, ids[5], 'member');

  -- ------------------------------------------------------------ posts
  insert into public.posts (author_id, body, event_id, created_at) values
    (ids[1], 'dün gece inanılmazdı, ses sistemi bambaşkaydı', past[1], now() - interval '20 hours'),
    (ids[2], 'bu cumartesi kim çıkıyor?', null, now() - interval '6 hours'),
    (ids[5], 'yeni mekan keşfettik, bir dahakine hep beraber', past[2], now() - interval '2 hours');

  -- the switches back as they were
  if saved is not null then
    delete from public.profile_settings where user_id = me;
    insert into public.profile_settings select * from jsonb_populate_record(null::public.profile_settings, saved);
  end if;
  raise notice 'test groups made for %', my_email;
end $$;
