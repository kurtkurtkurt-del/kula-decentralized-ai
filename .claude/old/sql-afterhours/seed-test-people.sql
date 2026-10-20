-- afterhours — the test accounts get a life: friends, kept nights, a
-- few words on a night. A one-shot for the live database (paste it into
-- the Supabase SQL editor), run AFTER rename-test-users.sql and after
-- 17_real_people.sql. Running it twice is harmless.
--
-- The graph, from owner2: testuser1 and testuser2 are friends; testuser3
-- is a friend of testuser1; testuser5 a friend of testuser2; testuser4 a
-- friend of testuser3 — so the column on a night shows every distance
-- the design draws. owner1 is friends with all of them. To make
-- everybody a direct friend of owner2 instead, add the missing pairs to
-- the first list.

begin;

-- ----------------------------------------------------------- friends
with pairs(a, b) as (values
  ('owner2', 'testuser1'), ('owner2', 'testuser2'),
  ('testuser1', 'testuser3'), ('testuser2', 'testuser5'), ('testuser3', 'testuser4'),
  ('owner1', 'testuser1'), ('owner1', 'testuser2'), ('owner1', 'testuser3'),
  ('owner1', 'testuser4'), ('owner1', 'testuser5')
)
insert into public.friendships (requester_id, addressee_id, status)
select pa.id, pb.id, 'accepted'
from pairs
join public.profiles pa on pa.handle = pairs.a
join public.profiles pb on pb.handle = pairs.b
on conflict (requester_id, addressee_id) do update set status = 'accepted';

-- ------------------------------------------------------- kept nights
-- Everybody keeps the Weeknd night, and each test account keeps the
-- next few nights in München, staggered so their rolls differ.
insert into public.swipes (user_id, event_id, direction)
select p.id, e.id, 'right'
from public.profiles p
join public.events_public e on e.slug = 'the-weeknd-after-hours-til-dawn-tour-16b72e5f'
where p.handle like 'testuser%'
on conflict (user_id, event_id) do nothing;

insert into public.swipes (user_id, event_id, direction)
select p.id, e.id, 'right'
from public.profiles p
join lateral (
  select id from public.events_public ev
  where ev.is_published and ev.city_slug = 'munchen' and ev.starts_at > now()
  order by ev.starts_at, ev.slug
  offset (substr(p.handle, 9)::int - 1) * 2
  limit 7
) e on true
where p.handle ~ '^testuser[0-9]+$'
on conflict (user_id, event_id) do nothing;

-- ------------------------------------------------------- beforehours
with lines(handle, body) as (values
  ('testuser1', 'Side seats were the right call last time. If you are short, do not fight the floor.'),
  ('testuser2', 'Everyone leaves through one station. Walk out during the encore or make peace with it.'),
  ('testuser3', 'Who is on before? I cannot find a single thing about them.'),
  ('testuser4', 'Doors are early for a reason. Do not rush your dinner, but do not trust the printed time either.'),
  ('testuser5', 'Not making this one. Someone record the quiet part for me.')
)
insert into public.comments (event_id, author_id, body)
select e.id, p.id, lines.body
from lines
join public.profiles p on p.handle = lines.handle
join public.events_public e on e.slug = 'the-weeknd-after-hours-til-dawn-tour-16b72e5f'
where not exists (
  select 1 from public.comments c
  where c.event_id = e.id and c.author_id = p.id and c.body = lines.body
);

commit;

-- What it did:
select p.handle,
       (select count(*) from public.friendships f
         where f.status = 'accepted' and (f.requester_id = p.id or f.addressee_id = p.id)) as friends,
       (select count(*) from public.swipes s where s.user_id = p.id and s.direction = 'right') as kept,
       (select count(*) from public.comments c where c.author_id = p.id) as said
from public.profiles p
order by p.created_at;
