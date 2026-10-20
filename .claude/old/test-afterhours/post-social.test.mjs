/* afterhours — likes and comments on posts (55) */

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
                 "../sql/19_checkins.sql", "../sql/20_djs.sql", "../sql/24_photos.sql", "../sql/25_people.sql", "../sql/26_push.sql",
                 "../sql/27_sparks.sql", "../sql/28_spark_waves.sql", "../sql/29_profile_more.sql", "../sql/32_rsvp.sql", "../sql/34_spark_push.sql"]) {
  await db.exec(await read(d));
}
await db.exec(`create or replace function public.is_guest() returns boolean language sql stable as $$
  select coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'is_anonymous')::boolean, false); $$;`);
for (const d of ["../sql/41_account_types.sql", "../sql/42_staff.sql", "../sql/43_event_submit.sql", "../sql/44_groups.sql", "../sql/45_posts.sql",
                 "../sql/46_group_plans.sql", "../sql/47_group_nights.sql", "../sql/48_group_push.sql", "../sql/49_design_reads.sql", "../sql/50_blocks.sql",
                 "../sql/51_safety.sql", "../sql/52_bans.sql", "../sql/53_trust.sql", "../sql/54_upkeep.sql", "../sql/55_post_social.sql", "../sql/55_post_social.sql"]) {
  await db.exec(await read(d));
}

const [A, B, C, D, CM] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222",
  "cccccccc-3333-3333-3333-333333333333", "dddddddd-4444-4444-4444-444444444444", "eeeeeeee-5555-5555-5555-555555555555"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const one = async (sql) => (await db.query(sql)).rows[0];
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${C}','c@x'),('${D}','d@x'),('${CM}','cm@x')`);
await db.exec(`update public.profiles set handle = 'ada' where id = '${A}'; update public.profiles set handle = 'berk' where id = '${B}';
               update public.profiles set handle = 'cansu' where id = '${C}'; update public.profiles set handle = 'deniz' where id = '${D}';
               update public.profiles set account_type = 'community_manager' where id = '${CM}'`);
/* A is friends with B and C; D is a stranger */
await db.exec(`insert into public.friendships (requester_id, addressee_id, status) values ('${A}','${B}','accepted'),('${A}','${C}','accepted')`);
await as(A);
const post = (await one(`select public.post_create('what a night', '${A}/p.jpg', null) as p`)).p;

console.log("\n— likes —");
{
  await as(B);
  check((await one(`select public.post_like('${post}', true) as n`)).n === 1, "a friend likes it");
  check((await one(`select public.post_like('${post}', true) as n`)).n === 1, "twice is still one");
  await as(C);
  await db.exec(`select public.post_like('${post}', true)`);
  await as(D);
  check(/no such post/.test(await fails(`select public.post_like('${post}', true)`) ?? ""), "a stranger cannot");
  await as(A);
  const who = await rows(`select handle from public.post_likers('${post}')`);
  check(who.length === 2 && who[0].handle === "cansu", "who liked it, newest first", JSON.stringify(who));
  await as(B);
  check((await one(`select public.post_like('${post}', false) as n`)).n === 1, "taking a like back");
  await asService();
  check((await one(`select count(*)::int as n from public.push_outbox where kind = 'post_like' and user_id = '${A}'`)).n === 2, "the author hears of each like once");
}

console.log("\n— comments —");
{
  await as(B);
  const c1 = (await one(`select public.post_comment_add('${post}', 'so good') as id`)).id;
  await as(C);
  const c2 = (await one(`select public.post_comment_add('${post}', 'next time') as id`)).id;
  await db.exec(`select public.post_comment_add('${post}', 'third')`);
  check(/few words/.test(await fails(`select public.post_comment_add('${post}', '   ')`) ?? ""), "not empty");
  await as(D);
  check(/no such post/.test(await fails(`select public.post_comment_add('${post}', 'hi')`) ?? ""), "a stranger cannot comment");
  await as(A);
  const list = await rows(`select * from public.post_comments_of('${post}')`);
  check(list.length === 3 && list[0].body === "so good" && list.every((x) => x.can_delete), "all three, oldest first; the post author may delete any");
  const feed = (await rows(`select * from public.posts_feed(null, 10)`))[0];
  check(feed.likes === 1 && feed.liked === false && feed.comments === 3 && feed.first_comments.length === 2 && feed.first_comments[0].who === "berk",
        "the feed carries likes, comments and the first two", JSON.stringify(feed));
  await as(C);
  check(/not yours/.test(await fails(`select public.post_comment_delete('${c1}')`) ?? ""), "not someone else's comment");
  await db.exec(`select public.post_comment_delete('${c2}')`);
  await as(A);
  await db.exec(`select public.post_comment_delete('${c1}')`);
  check((await rows(`select * from public.post_comments_of('${post}')`)).length === 1, "own one and, as the author, any");
  await asService();
  check((await one(`select count(*)::int as n from public.push_outbox where kind = 'post_comment' and user_id = '${A}'`)).n === 3, "the author hears of each comment");
}

console.log("\n— reports, blocks, bans —");
{
  await as(C);
  const c3 = (await one(`select public.post_comment_add('${post}', 'rude') as id`)).id;
  await as(B);
  await db.exec(`select public.report('post_comment', '${c3}', 'rude')`);
  await as(CM);
  const r = (await rows(`select * from public.staff_reports()`)).find((x) => x.kind === "post_comment");
  check(r && r.preview === "rude" && r.author === "cansu", "a reported comment reaches the staff, with its words");
  await db.exec(`select public.staff_report_settle('post_comment', '${c3}', true)`);
  await as(A);
  check(!(await rows(`select body from public.post_comments_of('${post}')`)).some((x) => x.body === "rude"), "removed: hidden from everyone");
  await as(C);
  check((await rows(`select kind from public.my_notices()`)).some((x) => x.kind === "comment_hidden"), "and its author is told");
  await as(A);
  await db.exec(`select public.block_user('${B}')`);
  check(!(await rows(`select handle from public.post_likers('${post}')`)).some((x) => x.handle === "berk"), "a blocked person is not among the likers");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
