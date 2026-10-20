/* afterhours — posts: a photo and a few words for your friends (45) */

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
                 "../sql/12_profiles.sql", "../sql/13_feedback.sql", "../sql/15_ticketmaster.sql", "../sql/18_geo.sql", "../sql/20_djs.sql"]) {
  await db.exec(await read(d));
}
await db.exec(`create or replace function public.is_guest() returns boolean language sql stable as $$
  select coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'is_anonymous')::boolean, false); $$;`);
for (const d of ["../sql/41_account_types.sql", "../sql/42_staff.sql", "../sql/43_event_submit.sql", "../sql/44_groups.sql", "../sql/45_posts.sql", "../sql/45_posts.sql"]) {
  await db.exec(await read(d));
}

const [A, B, C, CM, G] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222",
  "cccccccc-3333-3333-3333-333333333333", "dddddddd-4444-4444-4444-444444444444", "ffffffff-6666-6666-6666-666666666666"];
const as = (id, guest = false) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"${guest ? ',"is_anonymous":true' : ""}}';`);
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const one = async (sql) => (await db.query(sql)).rows[0];
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${C}','c@x'),('${CM}','cm@x'),('${G}',null)`);
await db.exec(`insert into public.friendships (requester_id, addressee_id, status) values ('${A}', '${B}', 'accepted')`);
await db.exec(`update public.profiles set account_type = 'community_manager' where id = '${CM}'`);
const night = (await one(`select id, slug from public.events limit 1`));

console.log("\n— posting —");
let p;
{
  await as(A);
  p = (await one(`select public.post_create('what a night', '${A}/p1.jpg', '${night.id}') as p`)).p;
  check(Boolean(p), "a photo, a few words, the night");
  check((await fails(`select public.post_create('just words', null, null)`)) === null, "words alone are fine");
  check(/photo or a few words/.test(await fails(`select public.post_create('   ', null, null)`) ?? ""), "but not nothing");
  check(/your file/.test(await fails(`select public.post_create('x', '${B}/p.jpg', null)`) ?? ""), "only your own photo");
  check(Boolean(await fails(`select * from public.posts`)), "the table itself is closed");
  await as(G, true);
  check(/account/.test(await fails(`select public.post_create('hi', null, null)`) ?? ""), "a guest makes an account first");
}

console.log("\n— who sees it —");
{
  await as(B);
  const f = await rows(`select * from public.posts_feed(null, 10)`);
  check(f.length === 2 && f.find((x) => x.id === p).event_slug === night.slug, "a friend sees both, with the night");
  await as(C);
  check((await rows(`select * from public.posts_feed(null, 10)`)).length === 0, "a stranger sees nothing");
  await asAnon();
  check(Boolean(await fails(`select * from public.posts_feed(null, 10)`)), "signed out: nothing");
  await as(A);
  const mine = await rows(`select * from public.posts_feed(null, 10)`);
  check(mine.length === 2 && mine.every((x) => x.mine), "the author sees their own, marked as theirs");
  const page = await rows(`select * from public.posts_feed('${mine[0].created_at.toISOString()}', 10)`);
  check(page.length <= 1, "a page at a time");
}

console.log("\n— reports, the staff —");
{
  await as(C);
  check(/no such post/.test(await fails(`select public.post_report('${p}', 'x')`) ?? ""), "who cannot see it cannot report it");
  await as(A);
  check(/own post/.test(await fails(`select public.post_report('${p}', 'x')`) ?? ""), "nor report your own");
  await as(B);
  await db.exec(`select public.post_report('${p}', 'not ok')`);
  await db.exec(`select public.post_report('${p}', 'again')`);
  await as(CM);
  const r = await rows(`select * from public.staff_posts_reported()`);
  check(r.length === 1 && r[0].reports === 1 && r[0].reasons[0] === "not ok", "the staff see it once, with the reason");
  check((await one(`select public.admin_overview() as o`)).o.reported === 1, "the panel counts it");
  await db.exec(`select public.staff_post_hide('${p}', true)`);
  await as(B);
  check(!(await rows(`select id from public.posts_feed(null, 10)`)).some((x) => x.id === p), "hidden: gone from the feed");
  await as(CM);
  check((await rows(`select * from public.staff_posts_reported()`)).length === 0, "and the report is settled");
  await as(B);
  check(Boolean(await fails(`select public.staff_post_hide('${p}', false)`)), "a user cannot hide or show");
  check(Boolean(await fails(`select public.post_delete('${p}')`)), "nor delete what is not theirs");
  await as(A);
  check((await one(`select public.post_delete('${p}') as path`)).path === `${A}/p1.jpg`, "the author deletes it and gets the file back to remove");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
