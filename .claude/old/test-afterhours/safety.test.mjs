/* afterhours — what the stores require: the terms, reports, client errors (51) */

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
                 "../sql/19_checkins.sql", "../sql/20_djs.sql", "../sql/24_photos.sql", "../sql/27_sparks.sql", "../sql/29_profile_more.sql",
                 "../sql/32_rsvp.sql"]) {
  await db.exec(await read(d));
}
await db.exec(`create or replace function public.is_guest() returns boolean language sql stable as $$
  select coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'is_anonymous')::boolean, false); $$;`);
for (const d of ["../sql/41_account_types.sql", "../sql/42_staff.sql", "../sql/44_groups.sql", "../sql/46_group_plans.sql",
                 "../sql/51_safety.sql", "../sql/51_safety.sql"]) {
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
await db.exec(`update public.profiles set handle = 'berk', bio = 'bad words', about = 'more bad' where id = '${B}'`);
await db.exec(`update public.profiles set account_type = 'community_manager' where id = '${CM}'`);
const night = await one(`select id from public.events limit 1`);
const comment = (await one(`insert into public.comments (event_id, author_id, author_name, body) values ('${night.id}', '${B}', 'berk', 'rude') returning id`)).id;
const room = (await one(`insert into public.room_posts (event_id, user_id, body) values ('${night.id}', '${B}', 'rude too') returning id`)).id;
const spark = (await one(`insert into public.sparks (host_id, kind, title, starts_at) values ('${B}', 'grill', 'bad spark', now() + interval '1 day') returning id`)).id;
await db.exec(`insert into public.profile_links (user_id, kind, value) values ('${B}', 'instagram', 'berk')`);

console.log("\n— the terms —");
{
  await as(A);
  check((await one(`select * from public.terms_status()`)).version === null, "nobody has accepted yet");
  check(/eighteen/.test(await fails(`select public.accept_terms(1, false)`) ?? ""), "under eighteen is refused");
  await db.exec(`select public.accept_terms(1, true)`);
  const s = await one(`select * from public.terms_status()`);
  check(s.version === 1 && s.adult === true && s.at, "accepted: version, adult, when");
  await db.exec(`select public.accept_terms(2, true)`);
  await db.exec(`select public.accept_terms(1, true)`);
  check((await one(`select * from public.terms_status()`)).version === 2, "a newer version sticks; an older one does not go back");
  await asAnon();
  check(Boolean(await fails(`select public.accept_terms(1, true)`)), "signed out: nothing");
}

console.log("\n— reporting —");
{
  await as(A);
  await db.exec(`select public.report('comment', '${comment}', 'insults')`);
  await db.exec(`select public.report('room_post', '${room}', null)`);
  await db.exec(`select public.report('profile', 'berk', 'fake')`);
  await db.exec(`select public.report('spark', '${spark}', null)`);
  await db.exec(`select public.report('comment', '${comment}', 'insults again')`);
  check(/nothing to report/.test(await fails(`select public.report('comment', '00000000-0000-0000-0000-000000000000', null)`) ?? ""), "something that is not there cannot be reported");
  check(/nothing to report/.test(await fails(`select public.report('nonsense', 'x', null)`) ?? ""), "nor an unknown kind");
  check(Boolean(await fails(`select * from public.reports`)), "the table itself is closed");
  await as(B);
  check(/yours/.test(await fails(`select public.report('comment', '${comment}', null)`) ?? ""), "your own is not reported");
  await as(C);
  await db.exec(`select public.report('comment', '${comment}', 'yes')`);
  await as(G, true);
  check(/account/.test(await fails(`select public.report('comment', '${comment}', null)`) ?? ""), "a guest makes an account first");
  await as(A);
  check(/staff only/.test(await fails(`select * from public.staff_reports()`) ?? ""), "only the staff read them");
}

console.log("\n— the staff decide —");
{
  await as(CM);
  const list = await rows(`select * from public.staff_reports()`);
  const c = list.find((r) => r.kind === "comment");
  check(list.length === 4, "four things reported", JSON.stringify(list.map((r) => r.kind)));
  check(c && c.reports === 2 && c.preview === "rude" && c.author === "berk" && c.reasons.includes("insults again"), "the comment: two reports, the words, the author, the reasons");
  check(list[0].kind === "comment", "most reported first");
  const p = list.find((r) => r.kind === "profile");
  check(p && p.target === B, "a profile reported by handle is stored by id");

  await db.exec(`select public.staff_report_settle('comment', '${comment}', true)`);
  await db.exec(`select public.staff_report_settle('room_post', '${room}', true)`);
  await db.exec(`select public.staff_report_settle('profile', '${B}', true)`);
  await db.exec(`select public.staff_report_settle('spark', '${spark}', false)`);
  check((await rows(`select * from public.staff_reports()`)).length === 0, "all settled");
  await asService();
  check((await one(`select is_hidden from public.comments where id = '${comment}'`)).is_hidden === true, "the comment is hidden");
  check(!(await one(`select 1 as x from public.room_posts where id = '${room}'`)), "the room message is gone");
  const prof = await one(`select bio, about from public.profiles where id = '${B}'`);
  check(prof.bio === null && prof.about === null, "the profile lost its words");
  check(!(await one(`select 1 as x from public.profile_links where user_id = '${B}'`)), "and its links");
  check(Boolean(await one(`select 1 as x from public.sparks where id = '${spark}'`)), "the spark was kept");
  check((await one(`select count(*)::int as n from public.staff_log where target like 'report:%'`)).n === 4, "every decision is in the log");
}

console.log("\n— client errors —");
{
  await asAnon();
  await db.exec(`select public.log_error('boom', 'at x', 'flow', 'ios', '1.0.0', true)`);
  await as(A);
  await db.exec(`select public.log_error('', null, null, null, null, null)`);
  check(Boolean(await fails(`select * from public.client_errors`)), "the table itself is closed");
  check(/admin only/.test(await fails(`select * from public.admin_errors(10)`) ?? ""), "only the admin reads them");
  await asService();
  await db.exec(`update public.profiles set is_admin = true where id = '${C}'`);
  await as(C);
  const e = await rows(`select * from public.admin_errors(10)`);
  check(e.length === 2 && e.some((x) => x.message === "unknown" && x.who === null) && e.some((x) => x.fatal && x.platform === "ios"), "both, newest first, empty message named unknown");
  await db.exec(`select public.admin_errors_clear()`);
  check((await rows(`select * from public.admin_errors(10)`)).length === 0, "cleared");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
