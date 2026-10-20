-- afterhours — removes what seed-test-groups.sql made: the "(test)" groups (with
-- their swipes, votes, chat, live, album rows), the fake past nights, and the six
-- fake people (with their friendships, keeps, answers, check-ins and posts).
-- Your own swipes and check-ins on real nights stay.

delete from public.groups where name like '% (test)';
delete from public.events where source = 'fake';
delete from auth.users where email like 'fake-%@afterhours.test';
