-- GENERATED FILE - source: explore/comment-pools.js
-- Sample comments: no real user behind them, they carry an author_name.
-- The same selection the site shows today (same seed, same cards).

-- Running this file twice used to double every conversation. The sample
-- rows are exactly the ones carrying time_text ("4 days ago", "Nov 2023"):
-- nothing in the app ever writes that column, only this file does. So we
-- clear the previous sample set first and the file becomes repeatable.
-- A real comment whose author deleted their account keeps time_text null,
-- so it is never touched here.
delete from public.comments where time_text is not null;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'dnk', 'Tram 20 back to the centre after is packed. U3 from Olympiazentrum is emptier even if it''s a longer walk.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz
  from public.events where slug = 'asap-rocky'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'seraph', 'Tickets moved faster than last time. Two of us have spares if anyone''s short.', '4 days ago', '2026-08-25T19:00:00.000Z'::timestamptz
  from public.events where slug = 'asap-rocky'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'juli', 'Still going? I''d take one.', '3 days ago', '2026-08-26T19:00:00.000Z'::timestamptz from topic
  union all
  select topic.event_id, topic.id, 'seraph', 'Gone — but people keep dropping them in here the week of.', '2 days ago', '2026-08-27T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'pia.m', 'First time seeing them. Is it the kind of show where the whole floor sings, or is that just the internet?', '6 h ago', '2026-08-29T13:00:00.000Z'::timestamptz
  from public.events where slug = 'asap-rocky'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'lena_k', 'It''s real. Bring a voice you don''t need tomorrow.', '3 h ago', '2026-08-29T16:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'lena_k', 'Went to the same tour two years ago. The hall show is a different animal from the festival set — slower, and you actually hear the band talk between songs.', 'Nov 2023', '2023-11-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'asap-rocky'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'tobi', 'Agreed. Seated until the encore, then nobody was seated.', 'Nov 2023', '2023-11-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'marek', 'Olympiahalle sound is fine if you''re not under the balcony. Anything past block D and it turns to soup.', 'Sept 2024', '2024-09-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'asap-rocky'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'annu', 'Confirmed. Stood at the back once, never again.', 'Sept 2024', '2024-09-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'pia.m', 'First time seeing them. Is it the kind of show where the whole floor sings, or is that just the internet?', '6 h ago', '2026-08-29T13:00:00.000Z'::timestamptz
  from public.events where slug = 'nick-cave'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'lena_k', 'It''s real. Bring a voice you don''t need tomorrow.', '3 h ago', '2026-08-29T16:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'seraph', 'Tickets moved faster than last time. Two of us have spares if anyone''s short.', '4 days ago', '2026-08-25T19:00:00.000Z'::timestamptz
  from public.events where slug = 'nick-cave'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'juli', 'Still going? I''d take one.', '3 days ago', '2026-08-26T19:00:00.000Z'::timestamptz from topic
  union all
  select topic.event_id, topic.id, 'seraph', 'Gone — but people keep dropping them in here the week of.', '2 days ago', '2026-08-27T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'dnk', 'Tram 20 back to the centre after is packed. U3 from Olympiazentrum is emptier even if it''s a longer walk.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz
  from public.events where slug = 'nick-cave'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'hbf_nights', 'Doors said 18:30 and the support started 19:40. Don''t rush your dinner.', 'Mar 2025', '2025-03-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'nick-cave'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'marek', 'Olympiahalle sound is fine if you''re not under the balcony. Anything past block D and it turns to soup.', 'Sept 2024', '2024-09-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'nick-cave'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'annu', 'Confirmed. Stood at the back once, never again.', 'Sept 2024', '2024-09-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'seraph', 'Tickets moved faster than last time. Two of us have spares if anyone''s short.', '4 days ago', '2026-08-25T19:00:00.000Z'::timestamptz
  from public.events where slug = 'bonez-mc-raf-camora'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'juli', 'Still going? I''d take one.', '3 days ago', '2026-08-26T19:00:00.000Z'::timestamptz from topic
  union all
  select topic.event_id, topic.id, 'seraph', 'Gone — but people keep dropping them in here the week of.', '2 days ago', '2026-08-27T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'dnk', 'Tram 20 back to the centre after is packed. U3 from Olympiazentrum is emptier even if it''s a longer walk.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz
  from public.events where slug = 'bonez-mc-raf-camora'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'pia.m', 'First time seeing them. Is it the kind of show where the whole floor sings, or is that just the internet?', '6 h ago', '2026-08-29T13:00:00.000Z'::timestamptz
  from public.events where slug = 'bonez-mc-raf-camora'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'lena_k', 'It''s real. Bring a voice you don''t need tomorrow.', '3 h ago', '2026-08-29T16:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'lena_k', 'Went to the same tour two years ago. The hall show is a different animal from the festival set — slower, and you actually hear the band talk between songs.', 'Nov 2023', '2023-11-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'bonez-mc-raf-camora'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'tobi', 'Agreed. Seated until the encore, then nobody was seated.', 'Nov 2023', '2023-11-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'marek', 'Olympiahalle sound is fine if you''re not under the balcony. Anything past block D and it turns to soup.', 'Sept 2024', '2024-09-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'bonez-mc-raf-camora'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'annu', 'Confirmed. Stood at the back once, never again.', 'Sept 2024', '2024-09-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'pia.m', 'First time seeing them. Is it the kind of show where the whole floor sings, or is that just the internet?', '6 h ago', '2026-08-29T13:00:00.000Z'::timestamptz
  from public.events where slug = 'thirty-seconds-to-mars'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'lena_k', 'It''s real. Bring a voice you don''t need tomorrow.', '3 h ago', '2026-08-29T16:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'dnk', 'Tram 20 back to the centre after is packed. U3 from Olympiazentrum is emptier even if it''s a longer walk.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz
  from public.events where slug = 'thirty-seconds-to-mars'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'seraph', 'Tickets moved faster than last time. Two of us have spares if anyone''s short.', '4 days ago', '2026-08-25T19:00:00.000Z'::timestamptz
  from public.events where slug = 'thirty-seconds-to-mars'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'juli', 'Still going? I''d take one.', '3 days ago', '2026-08-26T19:00:00.000Z'::timestamptz from topic
  union all
  select topic.event_id, topic.id, 'seraph', 'Gone — but people keep dropping them in here the week of.', '2 days ago', '2026-08-27T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'hbf_nights', 'Doors said 18:30 and the support started 19:40. Don''t rush your dinner.', 'Mar 2025', '2025-03-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'thirty-seconds-to-mars'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'lena_k', 'Went to the same tour two years ago. The hall show is a different animal from the festival set — slower, and you actually hear the band talk between songs.', 'Nov 2023', '2023-11-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'thirty-seconds-to-mars'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'tobi', 'Agreed. Seated until the encore, then nobody was seated.', 'Nov 2023', '2023-11-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'seraph', 'Tickets moved faster than last time. Two of us have spares if anyone''s short.', '4 days ago', '2026-08-25T19:00:00.000Z'::timestamptz
  from public.events where slug = 'annenmaykantereit'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'juli', 'Still going? I''d take one.', '3 days ago', '2026-08-26T19:00:00.000Z'::timestamptz from topic
  union all
  select topic.event_id, topic.id, 'seraph', 'Gone — but people keep dropping them in here the week of.', '2 days ago', '2026-08-27T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'pia.m', 'First time seeing them. Is it the kind of show where the whole floor sings, or is that just the internet?', '6 h ago', '2026-08-29T13:00:00.000Z'::timestamptz
  from public.events where slug = 'annenmaykantereit'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'lena_k', 'It''s real. Bring a voice you don''t need tomorrow.', '3 h ago', '2026-08-29T16:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'dnk', 'Tram 20 back to the centre after is packed. U3 from Olympiazentrum is emptier even if it''s a longer walk.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz
  from public.events where slug = 'annenmaykantereit'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'lena_k', 'Went to the same tour two years ago. The hall show is a different animal from the festival set — slower, and you actually hear the band talk between songs.', 'Nov 2023', '2023-11-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'annenmaykantereit'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'tobi', 'Agreed. Seated until the encore, then nobody was seated.', 'Nov 2023', '2023-11-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'marek', 'Olympiahalle sound is fine if you''re not under the balcony. Anything past block D and it turns to soup.', 'Sept 2024', '2024-09-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'annenmaykantereit'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'annu', 'Confirmed. Stood at the back once, never again.', 'Sept 2024', '2024-09-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'obst', 'Weather looks like it''ll hold. Saying that out loud is probably a mistake.', '11 h ago', '2026-08-29T08:00:00.000Z'::timestamptz
  from public.events where slug = 'elysium'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'kaan', 'Anyone doing the whole thing without camping? Last trains are the part I never plan properly.', '2 days ago', '2026-08-27T19:00:00.000Z'::timestamptz
  from public.events where slug = 'elysium'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'sanne', 'It fits inside one walk home if you stay east. That''s the whole point of it.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'tess', 'Line-up dropped and the second stage is quietly the better one again.', '5 days ago', '2026-08-24T19:00:00.000Z'::timestamptz
  from public.events where slug = 'elysium'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'ferro', 'It''s always the better one. That''s the joke by now.', '4 days ago', '2026-08-25T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'ferro', 'Went alone the first year and left with six people I still go out with. It''s that kind of field.', 'Sept 2024', '2024-09-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'elysium'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'milo_b', 'Same. The queue for water is basically a dating app.', 'Sept 2024', '2024-09-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'sanne', 'Bring cash for the food stalls. Half of them still don''t take cards and the queue for the machine is its own festival.', 'July 2024', '2024-07-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'elysium'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'kaan', 'Anyone doing the whole thing without camping? Last trains are the part I never plan properly.', '2 days ago', '2026-08-27T19:00:00.000Z'::timestamptz
  from public.events where slug = 'tollwood'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'sanne', 'It fits inside one walk home if you stay east. That''s the whole point of it.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'tess', 'Line-up dropped and the second stage is quietly the better one again.', '5 days ago', '2026-08-24T19:00:00.000Z'::timestamptz
  from public.events where slug = 'tollwood'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'ferro', 'It''s always the better one. That''s the joke by now.', '4 days ago', '2026-08-25T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'obst', 'Weather looks like it''ll hold. Saying that out loud is probably a mistake.', '11 h ago', '2026-08-29T08:00:00.000Z'::timestamptz
  from public.events where slug = 'tollwood'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'sanne', 'Bring cash for the food stalls. Half of them still don''t take cards and the queue for the machine is its own festival.', 'July 2024', '2024-07-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'tollwood'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'ferro', 'Went alone the first year and left with six people I still go out with. It''s that kind of field.', 'Sept 2024', '2024-09-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'tollwood'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'milo_b', 'Same. The queue for water is basically a dating app.', 'Sept 2024', '2024-09-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'tess', 'Line-up dropped and the second stage is quietly the better one again.', '5 days ago', '2026-08-24T19:00:00.000Z'::timestamptz
  from public.events where slug = 'mondscheinexpress'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'ferro', 'It''s always the better one. That''s the joke by now.', '4 days ago', '2026-08-25T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'obst', 'Weather looks like it''ll hold. Saying that out loud is probably a mistake.', '11 h ago', '2026-08-29T08:00:00.000Z'::timestamptz
  from public.events where slug = 'mondscheinexpress'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'kaan', 'Anyone doing the whole thing without camping? Last trains are the part I never plan properly.', '2 days ago', '2026-08-27T19:00:00.000Z'::timestamptz
  from public.events where slug = 'mondscheinexpress'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'sanne', 'It fits inside one walk home if you stay east. That''s the whole point of it.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'vito', 'The year it rained, the small stage turned into the best one — everyone squeezed under the roof and stayed there until 3.', 'Aug 2023', '2023-08-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'mondscheinexpress'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'roh', 'Best accidental afterhours I''ve had.', 'Aug 2023', '2023-08-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'ferro', 'Went alone the first year and left with six people I still go out with. It''s that kind of field.', 'Sept 2024', '2024-09-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'mondscheinexpress'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'milo_b', 'Same. The queue for water is basically a dating app.', 'Sept 2024', '2024-09-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'obst', 'Weather looks like it''ll hold. Saying that out loud is probably a mistake.', '11 h ago', '2026-08-29T08:00:00.000Z'::timestamptz
  from public.events where slug = 'isle-of-summer'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'tess', 'Line-up dropped and the second stage is quietly the better one again.', '5 days ago', '2026-08-24T19:00:00.000Z'::timestamptz
  from public.events where slug = 'isle-of-summer'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'ferro', 'It''s always the better one. That''s the joke by now.', '4 days ago', '2026-08-25T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'kaan', 'Anyone doing the whole thing without camping? Last trains are the part I never plan properly.', '2 days ago', '2026-08-27T19:00:00.000Z'::timestamptz
  from public.events where slug = 'isle-of-summer'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'sanne', 'It fits inside one walk home if you stay east. That''s the whole point of it.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'sanne', 'Bring cash for the food stalls. Half of them still don''t take cards and the queue for the machine is its own festival.', 'July 2024', '2024-07-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'isle-of-summer'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'ferro', 'Went alone the first year and left with six people I still go out with. It''s that kind of field.', 'Sept 2024', '2024-09-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'isle-of-summer'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'milo_b', 'Same. The queue for water is basically a dating app.', 'Sept 2024', '2024-09-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'obst', 'Weather looks like it''ll hold. Saying that out loud is probably a mistake.', '11 h ago', '2026-08-29T08:00:00.000Z'::timestamptz
  from public.events where slug = 'zamanand'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'kaan', 'Anyone doing the whole thing without camping? Last trains are the part I never plan properly.', '2 days ago', '2026-08-27T19:00:00.000Z'::timestamptz
  from public.events where slug = 'zamanand'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'sanne', 'It fits inside one walk home if you stay east. That''s the whole point of it.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'tess', 'Line-up dropped and the second stage is quietly the better one again.', '5 days ago', '2026-08-24T19:00:00.000Z'::timestamptz
  from public.events where slug = 'zamanand'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'ferro', 'It''s always the better one. That''s the joke by now.', '4 days ago', '2026-08-25T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'vito', 'The year it rained, the small stage turned into the best one — everyone squeezed under the roof and stayed there until 3.', 'Aug 2023', '2023-08-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'zamanand'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'roh', 'Best accidental afterhours I''ve had.', 'Aug 2023', '2023-08-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'sanne', 'Bring cash for the food stalls. Half of them still don''t take cards and the queue for the machine is its own festival.', 'July 2024', '2024-07-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'zamanand'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'grau', 'Bringing someone to their first one. Any advice that isn''t ''drink water''?', '2 h ago', '2026-08-29T17:00:00.000Z'::timestamptz
  from public.events where slug = 'blitz'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'hallo_ben', 'Agree on a meeting spot. Phones die, the room is dark, that''s it.', '1 h ago', '2026-08-29T18:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'esra_p', 'Who''s playing the back room? The flyer says nothing and that''s usually where the night actually happens.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz
  from public.events where slug = 'blitz'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'mira', 'Unannounced on purpose. It was the better room last time too.', '20 h ago', '2026-08-28T23:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'lu', 'Door is doing a hard no on groups of guys again. Not a complaint, just don''t roll up six deep and act surprised.', '3 days ago', '2026-08-26T19:00:00.000Z'::timestamptz
  from public.events where slug = 'blitz'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'trm', 'Also: they mean it about the phones now, not just on the poster.', '3 days ago', '2026-08-26T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'mira', 'Came at 1, thought I was early. Room was already full — this crowd starts before the internet says it does.', 'Feb 2024', '2024-02-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'blitz'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'hallo_ben', 'Closing set ran two hours over and nobody working there seemed to mind. That''s the whole memory.', 'May 2025', '2025-05-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'blitz'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, '0x_nadja', 'We left at 9 in the morning into full daylight. Brutal, correct.', 'May 2025', '2025-05-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'grau', 'Bringing someone to their first one. Any advice that isn''t ''drink water''?', '2 h ago', '2026-08-29T17:00:00.000Z'::timestamptz
  from public.events where slug = 'rote-sonne-bahnwarter'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'hallo_ben', 'Agree on a meeting spot. Phones die, the room is dark, that''s it.', '1 h ago', '2026-08-29T18:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'esra_p', 'Who''s playing the back room? The flyer says nothing and that''s usually where the night actually happens.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz
  from public.events where slug = 'rote-sonne-bahnwarter'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'mira', 'Unannounced on purpose. It was the better room last time too.', '20 h ago', '2026-08-28T23:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'lu', 'Door is doing a hard no on groups of guys again. Not a complaint, just don''t roll up six deep and act surprised.', '3 days ago', '2026-08-26T19:00:00.000Z'::timestamptz
  from public.events where slug = 'rote-sonne-bahnwarter'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'trm', 'Also: they mean it about the phones now, not just on the poster.', '3 days ago', '2026-08-26T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'hallo_ben', 'Closing set ran two hours over and nobody working there seemed to mind. That''s the whole memory.', 'May 2025', '2025-05-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'rote-sonne-bahnwarter'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, '0x_nadja', 'We left at 9 in the morning into full daylight. Brutal, correct.', 'May 2025', '2025-05-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, '0x_nadja', 'The no-photo rule held all night, and you could feel it. Nobody was performing for anyone.', 'Oct 2023', '2023-10-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'rote-sonne-bahnwarter'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'stv', 'One guy tried and the whole floor turned around. Never seen a phone go away that fast.', 'Oct 2023', '2023-10-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'grau', 'Bringing someone to their first one. Any advice that isn''t ''drink water''?', '2 h ago', '2026-08-29T17:00:00.000Z'::timestamptz
  from public.events where slug = 'silo-west'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'hallo_ben', 'Agree on a meeting spot. Phones die, the room is dark, that''s it.', '1 h ago', '2026-08-29T18:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'esra_p', 'Who''s playing the back room? The flyer says nothing and that''s usually where the night actually happens.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz
  from public.events where slug = 'silo-west'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'mira', 'Unannounced on purpose. It was the better room last time too.', '20 h ago', '2026-08-28T23:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'lu', 'Door is doing a hard no on groups of guys again. Not a complaint, just don''t roll up six deep and act surprised.', '3 days ago', '2026-08-26T19:00:00.000Z'::timestamptz
  from public.events where slug = 'silo-west'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'trm', 'Also: they mean it about the phones now, not just on the poster.', '3 days ago', '2026-08-26T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, '0x_nadja', 'The no-photo rule held all night, and you could feel it. Nobody was performing for anyone.', 'Oct 2023', '2023-10-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'silo-west'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'stv', 'One guy tried and the whole floor turned around. Never seen a phone go away that fast.', 'Oct 2023', '2023-10-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'mira', 'Came at 1, thought I was early. Room was already full — this crowd starts before the internet says it does.', 'Feb 2024', '2024-02-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'silo-west'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'grau', 'Bringing someone to their first one. Any advice that isn''t ''drink water''?', '2 h ago', '2026-08-29T17:00:00.000Z'::timestamptz
  from public.events where slug = 'cfu-open-air'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'hallo_ben', 'Agree on a meeting spot. Phones die, the room is dark, that''s it.', '1 h ago', '2026-08-29T18:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'lu', 'Door is doing a hard no on groups of guys again. Not a complaint, just don''t roll up six deep and act surprised.', '3 days ago', '2026-08-26T19:00:00.000Z'::timestamptz
  from public.events where slug = 'cfu-open-air'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'trm', 'Also: they mean it about the phones now, not just on the poster.', '3 days ago', '2026-08-26T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'esra_p', 'Who''s playing the back room? The flyer says nothing and that''s usually where the night actually happens.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz
  from public.events where slug = 'cfu-open-air'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'mira', 'Unannounced on purpose. It was the better room last time too.', '20 h ago', '2026-08-28T23:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'hallo_ben', 'Closing set ran two hours over and nobody working there seemed to mind. That''s the whole memory.', 'May 2025', '2025-05-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'cfu-open-air'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, '0x_nadja', 'We left at 9 in the morning into full daylight. Brutal, correct.', 'May 2025', '2025-05-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, '0x_nadja', 'The no-photo rule held all night, and you could feel it. Nobody was performing for anyone.', 'Oct 2023', '2023-10-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'cfu-open-air'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'stv', 'One guy tried and the whole floor turned around. Never seen a phone go away that fast.', 'Oct 2023', '2023-10-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'esra_p', 'Who''s playing the back room? The flyer says nothing and that''s usually where the night actually happens.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz
  from public.events where slug = 'daytime-rave'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'mira', 'Unannounced on purpose. It was the better room last time too.', '20 h ago', '2026-08-28T23:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'grau', 'Bringing someone to their first one. Any advice that isn''t ''drink water''?', '2 h ago', '2026-08-29T17:00:00.000Z'::timestamptz
  from public.events where slug = 'daytime-rave'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'hallo_ben', 'Agree on a meeting spot. Phones die, the room is dark, that''s it.', '1 h ago', '2026-08-29T18:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'lu', 'Door is doing a hard no on groups of guys again. Not a complaint, just don''t roll up six deep and act surprised.', '3 days ago', '2026-08-26T19:00:00.000Z'::timestamptz
  from public.events where slug = 'daytime-rave'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'trm', 'Also: they mean it about the phones now, not just on the poster.', '3 days ago', '2026-08-26T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'hallo_ben', 'Closing set ran two hours over and nobody working there seemed to mind. That''s the whole memory.', 'May 2025', '2025-05-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'daytime-rave'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, '0x_nadja', 'We left at 9 in the morning into full daylight. Brutal, correct.', 'May 2025', '2025-05-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, '0x_nadja', 'The no-photo rule held all night, and you could feel it. Nobody was performing for anyone.', 'Oct 2023', '2023-10-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'daytime-rave'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'stv', 'One guy tried and the whole floor turned around. Never seen a phone go away that fast.', 'Oct 2023', '2023-10-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'sol', 'Two of us going, don''t know anyone. Say hi if you''re also standing near the pillar looking unsure.', '8 h ago', '2026-08-29T11:00:00.000Z'::timestamptz
  from public.events where slug = 'echonomist'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'aylin', 'The pillar is a legitimate meeting point at this place.', '5 h ago', '2026-08-29T14:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'fitz', 'Doors 23:59 is a bit of a statement but the room genuinely doesn''t fill before 1.', '4 days ago', '2026-08-25T19:00:00.000Z'::timestamptz
  from public.events where slug = 'echonomist'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'meret', 'Is it card only at the bar now? Got caught out last month with a wallet full of coins.', '2 days ago', '2026-08-27T19:00:00.000Z'::timestamptz
  from public.events where slug = 'echonomist'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'kiez', 'Card at the bar, cash at the door. Annoying but consistent.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'roza', 'This used to be a Thursday thing and honestly it was better — smaller room, no queue, everyone there on purpose.', 'Dec 2023', '2023-12-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'echonomist'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'n_than', 'The Thursday version is the one people still talk about.', 'Dec 2023', '2023-12-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'kiez', 'Basement gets to about 40 degrees by 2am. Leave the jacket at home, the wardrobe queue is the real enemy.', 'Jun 2024', '2024-06-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'echonomist'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'meret', 'Is it card only at the bar now? Got caught out last month with a wallet full of coins.', '2 days ago', '2026-08-27T19:00:00.000Z'::timestamptz
  from public.events where slug = '10-years-blurred-vision'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'kiez', 'Card at the bar, cash at the door. Annoying but consistent.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'fitz', 'Doors 23:59 is a bit of a statement but the room genuinely doesn''t fill before 1.', '4 days ago', '2026-08-25T19:00:00.000Z'::timestamptz
  from public.events where slug = '10-years-blurred-vision'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'sol', 'Two of us going, don''t know anyone. Say hi if you''re also standing near the pillar looking unsure.', '8 h ago', '2026-08-29T11:00:00.000Z'::timestamptz
  from public.events where slug = '10-years-blurred-vision'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'aylin', 'The pillar is a legitimate meeting point at this place.', '5 h ago', '2026-08-29T14:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'aylin', 'Came for the headliner, stayed for the local who played first. Happens here more than anywhere else in the city.', 'Jan 2025', '2025-01-15T20:00:00.000Z'::timestamptz
  from public.events where slug = '10-years-blurred-vision'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'roza', 'That''s the booking policy, not luck.', 'Jan 2025', '2025-01-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'roza', 'This used to be a Thursday thing and honestly it was better — smaller room, no queue, everyone there on purpose.', 'Dec 2023', '2023-12-15T20:00:00.000Z'::timestamptz
  from public.events where slug = '10-years-blurred-vision'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'n_than', 'The Thursday version is the one people still talk about.', 'Dec 2023', '2023-12-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'fitz', 'Doors 23:59 is a bit of a statement but the room genuinely doesn''t fill before 1.', '4 days ago', '2026-08-25T19:00:00.000Z'::timestamptz
  from public.events where slug = 'legal-blitz'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'meret', 'Is it card only at the bar now? Got caught out last month with a wallet full of coins.', '2 days ago', '2026-08-27T19:00:00.000Z'::timestamptz
  from public.events where slug = 'legal-blitz'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'kiez', 'Card at the bar, cash at the door. Annoying but consistent.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'sol', 'Two of us going, don''t know anyone. Say hi if you''re also standing near the pillar looking unsure.', '8 h ago', '2026-08-29T11:00:00.000Z'::timestamptz
  from public.events where slug = 'legal-blitz'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'aylin', 'The pillar is a legitimate meeting point at this place.', '5 h ago', '2026-08-29T14:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'kiez', 'Basement gets to about 40 degrees by 2am. Leave the jacket at home, the wardrobe queue is the real enemy.', 'Jun 2024', '2024-06-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'legal-blitz'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'roza', 'This used to be a Thursday thing and honestly it was better — smaller room, no queue, everyone there on purpose.', 'Dec 2023', '2023-12-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'legal-blitz'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'n_than', 'The Thursday version is the one people still talk about.', 'Dec 2023', '2023-12-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'meret', 'Is it card only at the bar now? Got caught out last month with a wallet full of coins.', '2 days ago', '2026-08-27T19:00:00.000Z'::timestamptz
  from public.events where slug = 'bahnwarter-techno-nacht'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'kiez', 'Card at the bar, cash at the door. Annoying but consistent.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'sol', 'Two of us going, don''t know anyone. Say hi if you''re also standing near the pillar looking unsure.', '8 h ago', '2026-08-29T11:00:00.000Z'::timestamptz
  from public.events where slug = 'bahnwarter-techno-nacht'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'aylin', 'The pillar is a legitimate meeting point at this place.', '5 h ago', '2026-08-29T14:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'fitz', 'Doors 23:59 is a bit of a statement but the room genuinely doesn''t fill before 1.', '4 days ago', '2026-08-25T19:00:00.000Z'::timestamptz
  from public.events where slug = 'bahnwarter-techno-nacht'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'kiez', 'Basement gets to about 40 degrees by 2am. Leave the jacket at home, the wardrobe queue is the real enemy.', 'Jun 2024', '2024-06-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'bahnwarter-techno-nacht'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'aylin', 'Came for the headliner, stayed for the local who played first. Happens here more than anywhere else in the city.', 'Jan 2025', '2025-01-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'bahnwarter-techno-nacht'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'roza', 'That''s the booking policy, not luck.', 'Jan 2025', '2025-01-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'sol', 'Two of us going, don''t know anyone. Say hi if you''re also standing near the pillar looking unsure.', '8 h ago', '2026-08-29T11:00:00.000Z'::timestamptz
  from public.events where slug = 'unterwelt'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'aylin', 'The pillar is a legitimate meeting point at this place.', '5 h ago', '2026-08-29T14:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'meret', 'Is it card only at the bar now? Got caught out last month with a wallet full of coins.', '2 days ago', '2026-08-27T19:00:00.000Z'::timestamptz
  from public.events where slug = 'unterwelt'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'kiez', 'Card at the bar, cash at the door. Annoying but consistent.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'fitz', 'Doors 23:59 is a bit of a statement but the room genuinely doesn''t fill before 1.', '4 days ago', '2026-08-25T19:00:00.000Z'::timestamptz
  from public.events where slug = 'unterwelt'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'kiez', 'Basement gets to about 40 degrees by 2am. Leave the jacket at home, the wardrobe queue is the real enemy.', 'Jun 2024', '2024-06-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'unterwelt'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'roza', 'This used to be a Thursday thing and honestly it was better — smaller room, no queue, everyone there on purpose.', 'Dec 2023', '2023-12-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'unterwelt'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'n_than', 'The Thursday version is the one people still talk about.', 'Dec 2023', '2023-12-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'sibel', 'Address only goes out the day of, right? Don''t want to plan a whole evening around a doorbell I can''t find.', '5 days ago', '2026-08-24T19:00:00.000Z'::timestamptz
  from public.events where slug = 'kuchentisch'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'nemo', 'Day of, and it''s the fourth floor. There is no lift. That''s the ritual.', '4 days ago', '2026-08-25T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'ana', 'Last one ended with everyone on the staircase at 5am talking about nothing. Hoping for the same.', '3 h ago', '2026-08-29T16:00:00.000Z'::timestamptz
  from public.events where slug = 'kuchentisch'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'mo', 'Bringing two people who don''t know anyone. Is that a lot or normal here?', '2 days ago', '2026-08-27T19:00:00.000Z'::timestamptz
  from public.events where slug = 'kuchentisch'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'juno_r', 'Normal. Two is fine, six is a different situation.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'juno_r', 'Someone brought a record player and the whole night changed direction at 2am. Best thing that''s happened in that flat.', 'Feb 2025', '2025-02-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'kuchentisch'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'wg_küche', 'That was Timo. He''s invited forever now.', 'Feb 2025', '2025-02-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'nemo', 'Neighbours were fine until midnight, then the ceiling started talking to us. Take it inside at twelve and it stays a party.', 'Sept 2024', '2024-09-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'kuchentisch'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'mo', 'Bringing two people who don''t know anyone. Is that a lot or normal here?', '2 days ago', '2026-08-27T19:00:00.000Z'::timestamptz
  from public.events where slug = '3-stock-links'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'juno_r', 'Normal. Two is fine, six is a different situation.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'sibel', 'Address only goes out the day of, right? Don''t want to plan a whole evening around a doorbell I can''t find.', '5 days ago', '2026-08-24T19:00:00.000Z'::timestamptz
  from public.events where slug = '3-stock-links'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'nemo', 'Day of, and it''s the fourth floor. There is no lift. That''s the ritual.', '4 days ago', '2026-08-25T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'ana', 'Last one ended with everyone on the staircase at 5am talking about nothing. Hoping for the same.', '3 h ago', '2026-08-29T16:00:00.000Z'::timestamptz
  from public.events where slug = '3-stock-links'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'juno_r', 'Someone brought a record player and the whole night changed direction at 2am. Best thing that''s happened in that flat.', 'Feb 2025', '2025-02-15T20:00:00.000Z'::timestamptz
  from public.events where slug = '3-stock-links'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'wg_küche', 'That was Timo. He''s invited forever now.', 'Feb 2025', '2025-02-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'wg_küche', 'The kitchen is always the party. Every year we plan the living room, every year everyone stands by the fridge.', 'Mar 2024', '2024-03-15T20:00:00.000Z'::timestamptz
  from public.events where slug = '3-stock-links'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'flo', 'Put the good speaker in the kitchen and stop fighting it.', 'Mar 2024', '2024-03-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'ana', 'Last one ended with everyone on the staircase at 5am talking about nothing. Hoping for the same.', '3 h ago', '2026-08-29T16:00:00.000Z'::timestamptz
  from public.events where slug = 'boxenturm'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'sibel', 'Address only goes out the day of, right? Don''t want to plan a whole evening around a doorbell I can''t find.', '5 days ago', '2026-08-24T19:00:00.000Z'::timestamptz
  from public.events where slug = 'boxenturm'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'nemo', 'Day of, and it''s the fourth floor. There is no lift. That''s the ritual.', '4 days ago', '2026-08-25T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'mo', 'Bringing two people who don''t know anyone. Is that a lot or normal here?', '2 days ago', '2026-08-27T19:00:00.000Z'::timestamptz
  from public.events where slug = 'boxenturm'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'juno_r', 'Normal. Two is fine, six is a different situation.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'nemo', 'Neighbours were fine until midnight, then the ceiling started talking to us. Take it inside at twelve and it stays a party.', 'Sept 2024', '2024-09-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'boxenturm'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'juno_r', 'Someone brought a record player and the whole night changed direction at 2am. Best thing that''s happened in that flat.', 'Feb 2025', '2025-02-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'boxenturm'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'wg_küche', 'That was Timo. He''s invited forever now.', 'Feb 2025', '2025-02-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'mo', 'Bringing two people who don''t know anyone. Is that a lot or normal here?', '2 days ago', '2026-08-27T19:00:00.000Z'::timestamptz
  from public.events where slug = 'klingel-14'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'juno_r', 'Normal. Two is fine, six is a different situation.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'sibel', 'Address only goes out the day of, right? Don''t want to plan a whole evening around a doorbell I can''t find.', '5 days ago', '2026-08-24T19:00:00.000Z'::timestamptz
  from public.events where slug = 'klingel-14'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'nemo', 'Day of, and it''s the fourth floor. There is no lift. That''s the ritual.', '4 days ago', '2026-08-25T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'ana', 'Last one ended with everyone on the staircase at 5am talking about nothing. Hoping for the same.', '3 h ago', '2026-08-29T16:00:00.000Z'::timestamptz
  from public.events where slug = 'klingel-14'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'juno_r', 'Someone brought a record player and the whole night changed direction at 2am. Best thing that''s happened in that flat.', 'Feb 2025', '2025-02-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'klingel-14'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'wg_küche', 'That was Timo. He''s invited forever now.', 'Feb 2025', '2025-02-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'wg_küche', 'The kitchen is always the party. Every year we plan the living room, every year everyone stands by the fridge.', 'Mar 2024', '2024-03-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'klingel-14'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'flo', 'Put the good speaker in the kitchen and stop fighting it.', 'Mar 2024', '2024-03-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'sibel', 'Address only goes out the day of, right? Don''t want to plan a whole evening around a doorbell I can''t find.', '5 days ago', '2026-08-24T19:00:00.000Z'::timestamptz
  from public.events where slug = 'plattenabend'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'nemo', 'Day of, and it''s the fourth floor. There is no lift. That''s the ritual.', '4 days ago', '2026-08-25T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'ana', 'Last one ended with everyone on the staircase at 5am talking about nothing. Hoping for the same.', '3 h ago', '2026-08-29T16:00:00.000Z'::timestamptz
  from public.events where slug = 'plattenabend'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'mo', 'Bringing two people who don''t know anyone. Is that a lot or normal here?', '2 days ago', '2026-08-27T19:00:00.000Z'::timestamptz
  from public.events where slug = 'plattenabend'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'juno_r', 'Normal. Two is fine, six is a different situation.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'wg_küche', 'The kitchen is always the party. Every year we plan the living room, every year everyone stands by the fridge.', 'Mar 2024', '2024-03-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'plattenabend'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'flo', 'Put the good speaker in the kitchen and stop fighting it.', 'Mar 2024', '2024-03-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'juno_r', 'Someone brought a record player and the whole night changed direction at 2am. Best thing that''s happened in that flat.', 'Feb 2025', '2025-02-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'plattenabend'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'wg_küche', 'That was Timo. He''s invited forever now.', 'Feb 2025', '2025-02-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'ana', 'Last one ended with everyone on the staircase at 5am talking about nothing. Hoping for the same.', '3 h ago', '2026-08-29T16:00:00.000Z'::timestamptz
  from public.events where slug = 'vierter-stock'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'mo', 'Bringing two people who don''t know anyone. Is that a lot or normal here?', '2 days ago', '2026-08-27T19:00:00.000Z'::timestamptz
  from public.events where slug = 'vierter-stock'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'juno_r', 'Normal. Two is fine, six is a different situation.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'sibel', 'Address only goes out the day of, right? Don''t want to plan a whole evening around a doorbell I can''t find.', '5 days ago', '2026-08-24T19:00:00.000Z'::timestamptz
  from public.events where slug = 'vierter-stock'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'nemo', 'Day of, and it''s the fourth floor. There is no lift. That''s the ritual.', '4 days ago', '2026-08-25T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'juno_r', 'Someone brought a record player and the whole night changed direction at 2am. Best thing that''s happened in that flat.', 'Feb 2025', '2025-02-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'vierter-stock'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'wg_küche', 'That was Timo. He''s invited forever now.', 'Feb 2025', '2025-02-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'nemo', 'Neighbours were fine until midnight, then the ceiling started talking to us. Take it inside at twelve and it stays a party.', 'Sept 2024', '2024-09-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'vierter-stock'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'clea', 'German or English? Asking for the friend I''m dragging along who''s three weeks into the city.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz
  from public.events where slug = 'zine-klub'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'pauli', 'Both, in the same sentence usually. Nobody minds.', '22 h ago', '2026-08-28T21:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'yusuf', 'Do you need to bring anything or is turning up enough? The listing is very relaxed about it.', '6 days ago', '2026-08-23T19:00:00.000Z'::timestamptz
  from public.events where slug = 'zine-klub'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'org_jo', 'Turning up is enough. Bring something only if you want to show it.', '5 days ago', '2026-08-24T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'rem', 'Room fits about thirty and it was full last time twenty minutes in. Don''t stroll in at half past.', '4 h ago', '2026-08-29T15:00:00.000Z'::timestamptz
  from public.events where slug = 'zine-klub'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'pauli', 'Come alone. Genuinely. Everyone who shows up in a pair ends up talking only to their pair.', 'Apr 2024', '2024-04-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'zine-klub'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'bine', 'Ends earlier than you''d think, then half the room walks to the same bar anyway. That part is the meetup.', 'Nov 2024', '2024-11-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'zine-klub'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'hanna', 'The second half is undocumented and that''s fine.', 'Nov 2024', '2024-11-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'yusuf', 'Do you need to bring anything or is turning up enough? The listing is very relaxed about it.', '6 days ago', '2026-08-23T19:00:00.000Z'::timestamptz
  from public.events where slug = 'kaffee-karten'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'org_jo', 'Turning up is enough. Bring something only if you want to show it.', '5 days ago', '2026-08-24T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'clea', 'German or English? Asking for the friend I''m dragging along who''s three weeks into the city.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz
  from public.events where slug = 'kaffee-karten'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'pauli', 'Both, in the same sentence usually. Nobody minds.', '22 h ago', '2026-08-28T21:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'rem', 'Room fits about thirty and it was full last time twenty minutes in. Don''t stroll in at half past.', '4 h ago', '2026-08-29T15:00:00.000Z'::timestamptz
  from public.events where slug = 'kaffee-karten'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'bine', 'Ends earlier than you''d think, then half the room walks to the same bar anyway. That part is the meetup.', 'Nov 2024', '2024-11-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'kaffee-karten'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'hanna', 'The second half is undocumented and that''s fine.', 'Nov 2024', '2024-11-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'pauli', 'Come alone. Genuinely. Everyone who shows up in a pair ends up talking only to their pair.', 'Apr 2024', '2024-04-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'kaffee-karten'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'clea', 'German or English? Asking for the friend I''m dragging along who''s three weeks into the city.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz
  from public.events where slug = 'nachtlinie'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'pauli', 'Both, in the same sentence usually. Nobody minds.', '22 h ago', '2026-08-28T21:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'yusuf', 'Do you need to bring anything or is turning up enough? The listing is very relaxed about it.', '6 days ago', '2026-08-23T19:00:00.000Z'::timestamptz
  from public.events where slug = 'nachtlinie'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'org_jo', 'Turning up is enough. Bring something only if you want to show it.', '5 days ago', '2026-08-24T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'rem', 'Room fits about thirty and it was full last time twenty minutes in. Don''t stroll in at half past.', '4 h ago', '2026-08-29T15:00:00.000Z'::timestamptz
  from public.events where slug = 'nachtlinie'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'hanna', 'Went to the very first one when it was four people and a table. It''s bigger now and somehow still not awkward.', 'Oct 2023', '2023-10-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'nachtlinie'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'org_jo', 'Four people and one broken chair. We kept the chair.', 'Oct 2023', '2023-10-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'pauli', 'Come alone. Genuinely. Everyone who shows up in a pair ends up talking only to their pair.', 'Apr 2024', '2024-04-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'nachtlinie'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'rem', 'Room fits about thirty and it was full last time twenty minutes in. Don''t stroll in at half past.', '4 h ago', '2026-08-29T15:00:00.000Z'::timestamptz
  from public.events where slug = 'sprechstunde'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'yusuf', 'Do you need to bring anything or is turning up enough? The listing is very relaxed about it.', '6 days ago', '2026-08-23T19:00:00.000Z'::timestamptz
  from public.events where slug = 'sprechstunde'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'org_jo', 'Turning up is enough. Bring something only if you want to show it.', '5 days ago', '2026-08-24T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'clea', 'German or English? Asking for the friend I''m dragging along who''s three weeks into the city.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz
  from public.events where slug = 'sprechstunde'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'pauli', 'Both, in the same sentence usually. Nobody minds.', '22 h ago', '2026-08-28T21:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'hanna', 'Went to the very first one when it was four people and a table. It''s bigger now and somehow still not awkward.', 'Oct 2023', '2023-10-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'sprechstunde'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'org_jo', 'Four people and one broken chair. We kept the chair.', 'Oct 2023', '2023-10-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'pauli', 'Come alone. Genuinely. Everyone who shows up in a pair ends up talking only to their pair.', 'Apr 2024', '2024-04-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'sprechstunde'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'rem', 'Room fits about thirty and it was full last time twenty minutes in. Don''t stroll in at half past.', '4 h ago', '2026-08-29T15:00:00.000Z'::timestamptz
  from public.events where slug = 'riso-abend'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'clea', 'German or English? Asking for the friend I''m dragging along who''s three weeks into the city.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz
  from public.events where slug = 'riso-abend'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'pauli', 'Both, in the same sentence usually. Nobody minds.', '22 h ago', '2026-08-28T21:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'yusuf', 'Do you need to bring anything or is turning up enough? The listing is very relaxed about it.', '6 days ago', '2026-08-23T19:00:00.000Z'::timestamptz
  from public.events where slug = 'riso-abend'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'org_jo', 'Turning up is enough. Bring something only if you want to show it.', '5 days ago', '2026-08-24T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'hanna', 'Went to the very first one when it was four people and a table. It''s bigger now and somehow still not awkward.', 'Oct 2023', '2023-10-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'riso-abend'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'org_jo', 'Four people and one broken chair. We kept the chair.', 'Oct 2023', '2023-10-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'pauli', 'Come alone. Genuinely. Everyone who shows up in a pair ends up talking only to their pair.', 'Apr 2024', '2024-04-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'riso-abend'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'yusuf', 'Do you need to bring anything or is turning up enough? The listing is very relaxed about it.', '6 days ago', '2026-08-23T19:00:00.000Z'::timestamptz
  from public.events where slug = 'lange-tafel'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'org_jo', 'Turning up is enough. Bring something only if you want to show it.', '5 days ago', '2026-08-24T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'clea', 'German or English? Asking for the friend I''m dragging along who''s three weeks into the city.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz
  from public.events where slug = 'lange-tafel'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'pauli', 'Both, in the same sentence usually. Nobody minds.', '22 h ago', '2026-08-28T21:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'rem', 'Room fits about thirty and it was full last time twenty minutes in. Don''t stroll in at half past.', '4 h ago', '2026-08-29T15:00:00.000Z'::timestamptz
  from public.events where slug = 'lange-tafel'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'hanna', 'Went to the very first one when it was four people and a table. It''s bigger now and somehow still not awkward.', 'Oct 2023', '2023-10-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'lange-tafel'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'org_jo', 'Four people and one broken chair. We kept the chair.', 'Oct 2023', '2023-10-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'pauli', 'Come alone. Genuinely. Everyone who shows up in a pair ends up talking only to their pair.', 'Apr 2024', '2024-04-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'lange-tafel'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'grau', 'Bringing someone to their first one. Any advice that isn''t ''drink water''?', '2 h ago', '2026-08-29T17:00:00.000Z'::timestamptz
  from public.events where slug = 'strobo'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'hallo_ben', 'Agree on a meeting spot. Phones die, the room is dark, that''s it.', '1 h ago', '2026-08-29T18:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'lu', 'Door is doing a hard no on groups of guys again. Not a complaint, just don''t roll up six deep and act surprised.', '3 days ago', '2026-08-26T19:00:00.000Z'::timestamptz
  from public.events where slug = 'strobo'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'trm', 'Also: they mean it about the phones now, not just on the poster.', '3 days ago', '2026-08-26T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'esra_p', 'Who''s playing the back room? The flyer says nothing and that''s usually where the night actually happens.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz
  from public.events where slug = 'strobo'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'mira', 'Unannounced on purpose. It was the better room last time too.', '20 h ago', '2026-08-28T23:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'mira', 'Came at 1, thought I was early. Room was already full — this crowd starts before the internet says it does.', 'Feb 2024', '2024-02-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'strobo'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'hallo_ben', 'Closing set ran two hours over and nobody working there seemed to mind. That''s the whole memory.', 'May 2025', '2025-05-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'strobo'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, '0x_nadja', 'We left at 9 in the morning into full daylight. Brutal, correct.', 'May 2025', '2025-05-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'grau', 'Bringing someone to their first one. Any advice that isn''t ''drink water''?', '2 h ago', '2026-08-29T17:00:00.000Z'::timestamptz
  from public.events where slug = 'tunnelblick'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'hallo_ben', 'Agree on a meeting spot. Phones die, the room is dark, that''s it.', '1 h ago', '2026-08-29T18:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'lu', 'Door is doing a hard no on groups of guys again. Not a complaint, just don''t roll up six deep and act surprised.', '3 days ago', '2026-08-26T19:00:00.000Z'::timestamptz
  from public.events where slug = 'tunnelblick'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'trm', 'Also: they mean it about the phones now, not just on the poster.', '3 days ago', '2026-08-26T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'esra_p', 'Who''s playing the back room? The flyer says nothing and that''s usually where the night actually happens.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz
  from public.events where slug = 'tunnelblick'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'mira', 'Unannounced on purpose. It was the better room last time too.', '20 h ago', '2026-08-28T23:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, '0x_nadja', 'The no-photo rule held all night, and you could feel it. Nobody was performing for anyone.', 'Oct 2023', '2023-10-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'tunnelblick'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'stv', 'One guy tried and the whole floor turned around. Never seen a phone go away that fast.', 'Oct 2023', '2023-10-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'mira', 'Came at 1, thought I was early. Room was already full — this crowd starts before the internet says it does.', 'Feb 2024', '2024-02-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'tunnelblick'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'fitz', 'Doors 23:59 is a bit of a statement but the room genuinely doesn''t fill before 1.', '4 days ago', '2026-08-25T19:00:00.000Z'::timestamptz
  from public.events where slug = 'spiegelsaal'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'meret', 'Is it card only at the bar now? Got caught out last month with a wallet full of coins.', '2 days ago', '2026-08-27T19:00:00.000Z'::timestamptz
  from public.events where slug = 'spiegelsaal'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'kiez', 'Card at the bar, cash at the door. Annoying but consistent.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'sol', 'Two of us going, don''t know anyone. Say hi if you''re also standing near the pillar looking unsure.', '8 h ago', '2026-08-29T11:00:00.000Z'::timestamptz
  from public.events where slug = 'spiegelsaal'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'aylin', 'The pillar is a legitimate meeting point at this place.', '5 h ago', '2026-08-29T14:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'kiez', 'Basement gets to about 40 degrees by 2am. Leave the jacket at home, the wardrobe queue is the real enemy.', 'Jun 2024', '2024-06-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'spiegelsaal'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'aylin', 'Came for the headliner, stayed for the local who played first. Happens here more than anywhere else in the city.', 'Jan 2025', '2025-01-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'spiegelsaal'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'roza', 'That''s the booking policy, not luck.', 'Jan 2025', '2025-01-15T20:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'fitz', 'Doors 23:59 is a bit of a statement but the room genuinely doesn''t fill before 1.', '4 days ago', '2026-08-25T19:00:00.000Z'::timestamptz
  from public.events where slug = 'pegel'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'meret', 'Is it card only at the bar now? Got caught out last month with a wallet full of coins.', '2 days ago', '2026-08-27T19:00:00.000Z'::timestamptz
  from public.events where slug = 'pegel'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'kiez', 'Card at the bar, cash at the door. Annoying but consistent.', 'yesterday', '2026-08-28T19:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'sol', 'Two of us going, don''t know anyone. Say hi if you''re also standing near the pillar looking unsure.', '8 h ago', '2026-08-29T11:00:00.000Z'::timestamptz
  from public.events where slug = 'pegel'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'aylin', 'The pillar is a legitimate meeting point at this place.', '5 h ago', '2026-08-29T14:00:00.000Z'::timestamptz from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'kiez', 'Basement gets to about 40 degrees by 2am. Leave the jacket at home, the wardrobe queue is the real enemy.', 'Jun 2024', '2024-06-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'pegel'
  returning id, event_id
)
select 1 from topic;

with topic as (
  insert into public.comments (event_id, author_name, body, time_text, created_at)
  select id, 'roza', 'This used to be a Thursday thing and honestly it was better — smaller room, no queue, everyone there on purpose.', 'Dec 2023', '2023-12-15T20:00:00.000Z'::timestamptz
  from public.events where slug = 'pegel'
  returning id, event_id
)
insert into public.comments (event_id, parent_id, author_name, body, time_text, created_at)
  select topic.event_id, topic.id, 'n_than', 'The Thursday version is the one people still talk about.', 'Dec 2023', '2023-12-15T20:00:00.000Z'::timestamptz from topic;


-- Stamp the migration log, if it is there (00_migrations.sql).
do $$ begin
  if to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('05_seed_comments.sql');
  end if;
end $$;
