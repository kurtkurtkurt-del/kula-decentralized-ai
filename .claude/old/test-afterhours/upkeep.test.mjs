/* afterhours — upkeep: guests pruned, the staff alerted (54) */

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
                 "../sql/51_safety.sql", "../sql/52_bans.sql", "../sql/53_trust.sql", "../sql/54_upkeep.sql", "../sql/54_upkeep.sql"]) {
  await db.exec(await read(d));
}

const [A, B, CM, AD, G1, G2] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222",
  "dddddddd-4444-4444-4444-444444444444", "eeeeeeee-5555-5555-5555-555555555555",
  "99999999-1111-1111-1111-111111111111", "99999999-2222-2222-2222-222222222222"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const one = async (sql) => (await db.query(sql)).rows[0];

await asService();
await db.exec(`alter table auth.users add column if not exists is_anonymous boolean not null default false;
               alter table auth.users add column if not exists last_sign_in_at timestamptz;`);
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${CM}','cm@x'),('${AD}','ad@x')`);
await db.exec(`insert into auth.users (id, email, is_anonymous, created_at, last_sign_in_at) values
  ('${G1}', null, true, now() - interval '60 days', now() - interval '45 days'),
  ('${G2}', null, true, now() - interval '60 days', now() - interval '2 days')`);
await db.exec(`update public.profiles set handle = 'berk' where id = '${B}'`);
await db.exec(`update public.profiles set account_type = 'community_manager' where id = '${CM}'`);
await db.exec(`update public.profiles set is_admin = true, account_type = 'admin' where id = '${AD}'`);
await db.exec(`update public.profiles set last_seen_at = now() - interval '45 days' where id = '${G1}'`);
const night = await one(`select id from public.events limit 1`);
await db.exec(`insert into public.comments (event_id, author_id, author_name, body) values ('${night.id}', '${G1}', 'guest one', 'hello')`);

console.log("\n— guests —");
{
  const n = (await one(`select public.guests_prune(30) as n`)).n;
  check(n === 1, "the guest gone for 45 days is deleted", String(n));
  check(Boolean(await one(`select 1 as x from auth.users where id = '${G2}'`)), "the one seen two days ago stays");
  check(Boolean(await one(`select 1 as x from auth.users where id = '${A}'`)), "real accounts are never touched");
  const c = await one(`select author_id, author_name from public.comments where body = 'hello'`);
  check(c.author_id === null && c.author_name === "someone", "their comment stays, signed someone");
  await as(A);
  check(Boolean(await fails(`select public.guests_prune(30)`)), "nobody calls it from outside");
}

console.log("\n— the staff are alerted —");
{
  await asService();
  const c = (await one(`insert into public.comments (event_id, author_id, author_name, body) values ('${night.id}', '${B}', 'berk', 'rude') returning id`)).id;
  await as(A);
  await db.exec(`select public.report('comment', '${c}', null)`);
  await asService();
  const rows = (await db.query(`select user_id, kind, data from public.push_outbox where kind = 'staff'`)).rows;
  check(rows.length === 2 && rows.every((r) => r.data.n === "1"), "every staff member: one push, one thing waiting", JSON.stringify(rows));
  check(!rows.some((r) => r.user_id === A || r.user_id === B), "nobody else");
  await as(B);
  await db.exec(`select public.report('profile', 'ada', null)`).catch(() => {});
  await asService();
  check((await one(`select count(*)::int as n from public.push_outbox where kind = 'staff'`)).n === 2, "not again within the hour");
  const t = await one(`select * from public.push_text('staff', 'tr', '{"n": "3"}'::jsonb)`);
  check(t.title === "panel" && t.body.startsWith("3 iş bekliyor"), "the words, in the language of the phone");
  await as(CM);
  check((await one(`select public.staff_waiting() as n`)).n === 1, "the panel reads the same count");
  await as(A);
  check(/staff only/.test(await fails(`select public.staff_waiting()`) ?? ""), "only the staff");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
