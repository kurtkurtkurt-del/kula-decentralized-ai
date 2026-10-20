/* afterhours — closing an account (52) */

import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

const read = (y) => readFile(new URL(y, import.meta.url), "utf8");
let passed = 0, failed = 0;
const check = (k, name, extra = "") => {
  if (k) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
};
process.on("unhandledRejection", (e) => { console.log("\nERROR: " + ((e && e.message) || e)); if (e && e.where) console.log(e.where); process.exit(1); });

const db = new PGlite();
for (const d of ["../test/supabase-shim.sql", "../sql/01_schema.sql", "../sql/02_rls.sql",
                 "../sql/03_seed_catalog.sql", "../sql/04_seed_events.sql", "../sql/06_views.sql", "../sql/07_friends.sql",
                 "../sql/12_profiles.sql", "../sql/13_feedback.sql", "../sql/15_ticketmaster.sql", "../sql/18_geo.sql",
                 "../sql/19_checkins.sql", "../sql/20_djs.sql", "../sql/24_photos.sql", "../sql/25_people.sql", "../sql/27_sparks.sql",
                 "../sql/28_spark_waves.sql", "../sql/29_profile_more.sql", "../sql/32_rsvp.sql"]) {
  await db.exec(await read(d));
}
await db.exec(`create or replace function public.is_guest() returns boolean language sql stable as $$
  select coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'is_anonymous')::boolean, false); $$;`);
for (const d of ["../sql/41_account_types.sql", "../sql/42_staff.sql", "../sql/43_event_submit.sql", "../sql/44_groups.sql", "../sql/45_posts.sql",
                 "../sql/46_group_plans.sql", "../sql/47_group_nights.sql", "../sql/49_design_reads.sql", "../sql/50_blocks.sql",
                 "../sql/51_safety.sql", "../sql/52_bans.sql", "../sql/52_bans.sql"]) {
  await db.exec(await read(d));
}

const [A, B, CM, AD] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222",
  "dddddddd-4444-4444-4444-444444444444", "eeeeeeee-5555-5555-5555-555555555555"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const one = async (sql) => (await db.query(sql)).rows[0];
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${CM}','cm@x'),('${AD}','ad@x')`);
await db.exec(`update public.profiles set handle = 'ada' where id = '${A}'`);
await db.exec(`update public.profiles set handle = 'berk' where id = '${B}'`);
await db.exec(`update public.profiles set account_type = 'community_manager' where id = '${CM}'`);
await db.exec(`update public.profiles set is_admin = true, account_type = 'admin' where id = '${AD}'`);
const night = await one(`select id from public.events limit 1`);
const comment = (await one(`insert into public.comments (event_id, author_id, author_name, body) values ('${night.id}', '${B}', 'berk', 'rude') returning id`)).id;
await db.exec(`insert into public.sparks (host_id, kind, title, starts_at) values ('${B}', 'grill', 'later', now() + interval '1 day')`);
await db.exec(`insert into public.friendships (requester_id, addressee_id) values ('${B}', '${A}')`);
await as(A);
await db.exec(`select public.report('comment', '${comment}', 'rude')`);

console.log("\n— closing —");
{
  await as(B);
  check(Boolean(await fails(`update public.profiles set banned_at = now() where id = '${B}'`)), "nobody bans by hand");
  await as(A);
  check(/staff only/.test(await fails(`select public.staff_ban('${B}', 'spam')`) ?? ""), "only the staff ban");
  await as(CM);
  check(/staff cannot/.test(await fails(`select public.staff_ban('${AD}', null)`) ?? ""), "the staff cannot be banned");
  await db.exec(`select public.staff_ban('${B}', 'spam')`);
  await asService();
  const p = await one(`select banned_at, banned_reason, banned_by from public.profiles where id = '${B}'`);
  check(p.banned_at && p.banned_reason === "spam" && p.banned_by === CM, "closed: when, why, by whom");
  check((await one(`select is_hidden from public.comments where id = '${comment}'`)).is_hidden, "their comments are hidden");
  check(!(await one(`select 1 as x from public.sparks where host_id = '${B}'`)), "their upcoming sparks are called off");
  check(!(await one(`select 1 as x from public.friendships where requester_id = '${B}'`)), "their pending requests are gone");
  check((await one(`select count(*)::int as n from public.reports where not handled`)).n === 0, "their reports are settled");
}

console.log("\n— a closed account —");
{
  await as(B);
  const s = await one(`select * from public.account_status()`);
  check(s.banned === true && s.reason === "spam", "knows it is closed, and why");
  const said = await fails(`insert into public.comments (event_id, body) values ('${night.id}', 'again')`);
  check(/closed/.test(said ?? ""), "cannot comment", said);
  check(/closed/.test(await fails(`select public.friend_request('ada')`) ?? ""), "cannot ask anyone");
  check(/closed/.test(await fails(`update public.profiles set bio = 'hi' where id = '${B}'`) ?? ""), "cannot change its words");
  await as(A);
  check((await rows(`select * from public.people_search('berk')`)).length === 0, "nobody finds it");
  check((await rows(`select * from public.profile_card('berk')`)).length === 0, "nor sees its card");
}

console.log("\n— the panel —");
{
  await as(AD);
  const list = await rows(`select * from public.admin_people_by('', 'banned')`);
  check(list.length === 1 && list[0].handle === "berk" && list[0].banned, "the banned filter");
  check((await one(`select public.admin_role_counts() as c`)).c.banned === 1, "and its count");
  await db.exec(`select public.staff_unban('${B}')`);
  check((await rows(`select * from public.admin_people_by('', 'banned')`)).length === 0, "unbanned");
  await as(A);
  check((await rows(`select * from public.people_search('berk')`)).length === 1, "found again");
  await asService();
  check((await one(`select is_hidden from public.comments where id = '${comment}'`)).is_hidden, "hidden content stays hidden");
  check((await one(`select count(*)::int as n from public.staff_log where action in ('ban', 'unban')`)).n === 2, "both in the log");
}

console.log("\n— from the reports pile —");
{
  await asService();
  const room = (await one(`insert into public.room_posts (event_id, user_id, body) values ('${night.id}', '${B}', 'spam spam') returning id`)).id;
  await as(A);
  await db.exec(`select public.report('room_post', '${room}', null)`);
  await as(CM);
  await db.exec(`select public.staff_ban_author('room_post', '${room}', null)`);
  await asService();
  check(!(await one(`select 1 as x from public.room_posts where id = '${room}'`)), "the line is gone");
  check((await one(`select banned_reason from public.profiles where id = '${B}'`)).banned_reason === "report: room_post", "and the author is closed, with the reason");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
