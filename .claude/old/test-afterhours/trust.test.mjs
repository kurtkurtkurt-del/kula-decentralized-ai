/* afterhours — trust: dj pages checked, admins, notices, limits, blocks in groups (53) */

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
                 "../sql/51_safety.sql", "../sql/52_bans.sql", "../sql/53_trust.sql", "../sql/53_trust.sql"]) {
  await db.exec(await read(d));
}

const [A, B, C, CM, AD] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222",
  "cccccccc-3333-3333-3333-333333333333", "dddddddd-4444-4444-4444-444444444444", "eeeeeeee-5555-5555-5555-555555555555"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const one = async (sql) => (await db.query(sql)).rows[0];
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${C}','c@x'),('${CM}','cm@x'),('${AD}','ad@x')`);
await db.exec(`update public.profiles set handle = 'ada' where id = '${A}'`);
await db.exec(`update public.profiles set handle = 'berk', account_type = 'dj' where id = '${B}'`);
await db.exec(`update public.profiles set handle = 'cansu' where id = '${C}'`);
await db.exec(`update public.profiles set account_type = 'community_manager' where id = '${CM}'`);
await db.exec(`update public.profiles set is_admin = true, account_type = 'admin' where id = '${AD}'`);
const night = await one(`select id from public.events limit 1`);
const seedDjs = (await one(`select count(*)::int as n from public.djs`)).n;

console.log("\n— dj pages are checked —");
{
  await as(B);
  await db.exec(`select public.dj_save_mine('DJ Berk', 'techno', 'techno', null, 'hi', null)`);
  const mine = await one(`select id, verified from public.djs where owner_id = '${B}'`);
  check(mine && mine.verified === false, "a page someone makes waits");
  check((await rows(`select 1 from public.djs where owner_id = '${B}'`)).length === 1, "its owner sees it");
  await asAnon();
  check((await one(`select count(*)::int as n from public.djs`)).n === seedDjs, "nobody else does");
  await as(B);
  check(Boolean(await fails(`update public.djs set verified = true where owner_id = '${B}'`)) ||
        (await one(`select verified from public.djs where owner_id = '${B}'`)).verified === false, "the owner cannot let it through");
  await as(A);
  check(/staff only/.test(await fails(`select * from public.staff_djs_waiting()`) ?? ""), "only the staff see the queue");
  await as(CM);
  const q = await rows(`select * from public.staff_djs_waiting()`);
  check(q.length === 1 && q[0].owner === "berk", "the staff see it waiting");
  await db.exec(`select public.staff_dj_verify('${mine.id}', true)`);
  await asAnon();
  check((await one(`select count(*)::int as n from public.djs`)).n === seedDjs + 1, "let through: everyone sees it");
  await as(B);
  await db.exec(`select public.dj_save_mine('DJ Famous', 'techno', 'techno', null, 'hi', null)`);
  check((await one(`select verified from public.djs where owner_id = '${B}'`)).verified === false, "renamed: it waits again");
  await as(CM);
  await db.exec(`select public.staff_dj_verify('${mine.id}', true)`);
  await as(B);
  await db.exec(`select public.set_account_type('user', 'normal user')`);
  await asService();
  check((await one(`select verified from public.djs where owner_id = '${B}'`)).verified === false, "back to normal user: the page goes down");
  await as(B);
  const n = await rows(`select kind from public.my_notices()`);
  check(n.some((x) => x.kind === "dj_verified"), "the dj was told it went through", JSON.stringify(n));
}

console.log("\n— the other side is told —");
{
  await asService();
  const c = (await one(`insert into public.comments (event_id, author_id, author_name, body) values ('${night.id}', '${C}', 'cansu', 'meh') returning id`)).id;
  const r = (await one(`insert into public.room_posts (event_id, user_id, body) values ('${night.id}', '${C}', 'spam') returning id`)).id;
  await db.exec(`update public.profiles set bio = 'x' where id = '${C}'`);
  await as(A);
  await db.exec(`select public.report('room_post', '${r}', null)`);
  await as(CM);
  await db.exec(`select public.staff_comment_hide('${c}', true)`);
  await db.exec(`select public.staff_report_settle('room_post', '${r}', true)`);
  await as(AD);
  await db.exec(`select public.admin_set_type('${C}', 'dj')`);
  await as(C);
  const n = await rows(`select kind, data from public.my_notices()`);
  check(n.some((x) => x.kind === "comment_hidden" && x.data.text === "meh"), "a hidden comment, with its words");
  check(n.some((x) => x.kind === "removed" && x.data.what === "room_posts"), "a removed room line");
  check(n.some((x) => x.kind === "role" && x.data.role === "dj"), "a new role");
  await db.exec(`select public.notices_seen()`);
  check((await rows(`select * from public.my_notices()`)).length === 0, "seen: gone");
  check(Boolean(await fails(`select * from public.notices`)), "the table itself is closed");
  await asService();
  const own = (await one(`insert into public.room_posts (event_id, user_id, body) values ('${night.id}', '${C}', 'mine') returning id`)).id;
  await as(C);
  await db.exec(`delete from public.room_posts where id = '${own}'`).catch(() => {});
  check((await rows(`select * from public.my_notices()`)).length === 0, "nothing for what you remove yourself");
}

console.log("\n— admins —");
{
  await as(A);
  check(/admin only/.test(await fails(`select public.admin_set_admin('${C}', true)`) ?? ""), "only an admin makes an admin");
  await as(AD);
  check((await one(`select public.admin_set_admin('${AD}', false) as r`)).r === "self", "not on yourself");
  check((await one(`select public.admin_set_admin('${A}', true) as r`)).r === "ok", "a second admin");
  check((await one(`select is_admin, account_type from public.profiles where id = '${A}'`)).account_type === "admin", "with the role");
  await as(A);
  check((await one(`select public.admin_set_admin('${AD}', false) as r`)).r === "ok", "the second takes the first away");
  await asService();
  check(/last admin/.test(await fails(`update public.profiles set is_admin = false where id = '${A}'`) ?? ""), "the last admin stays, even from the editor");
}

console.log("\n— limits —");
{
  await as(C);
  let err = null;
  for (let i = 0; i < 31 && !err; i++) err = await fails(`insert into public.comments (event_id, body) values ('${night.id}', 'c${i}')`);
  check(/slow down/.test(err ?? ""), "thirty comments an hour, then slow down", err);
  await as(CM);
  check((await fails(`insert into public.comments (event_id, body) values ('${night.id}', 'staff')`)) === null, "the staff are not limited");
}

console.log("\n— groups and blocks —");
{
  await as(A);
  const g = (await one(`select public.group_create('test', '✦', 'red', null, 'lasting', null, null, null, array[]::uuid[]) as g`).catch(() => null))?.g;
  await asService();
  const gid = g ?? (await one(`insert into public.groups (name, created_by) values ('test', '${A}') returning id`)).id;
  await db.exec(`insert into public.group_members (group_id, user_id, role) values ('${gid}', '${A}', 'owner') on conflict do nothing`);
  await as(A);
  await db.exec(`select public.block_user('${C}')`);
  await asService();
  await db.exec(`set request.jwt.claims = '{"sub":"${C}"}'`);
  check(/not possible/.test(await fails(`insert into public.group_members (group_id, user_id) values ('${gid}', '${C}')`) ?? ""), "a blocked person cannot join a group with the blocker");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
