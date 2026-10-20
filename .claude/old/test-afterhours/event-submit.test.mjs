/* afterhours — a night sent in by anyone, let through by the staff (43) */

import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

const read = (y) => readFile(new URL(y, import.meta.url), "utf8");
let passed = 0, failed = 0;
const check = (k, name, extra = "") => {
  if (k) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
};
process.on("unhandledRejection", (e) => { console.log("\nERROR: " + ((e && e.message) || e)); process.exit(1); });

const db = new PGlite();
for (const d of ["../test/supabase-shim.sql", "../sql/01_schema.sql", "../sql/02_rls.sql",
                 "../sql/03_seed_catalog.sql", "../sql/06_views.sql", "../sql/12_profiles.sql",
                 "../sql/13_feedback.sql", "../sql/15_ticketmaster.sql", "../sql/18_geo.sql", "../sql/20_djs.sql",
                 "../sql/41_account_types.sql", "../sql/42_staff.sql", "../sql/43_event_submit.sql"]) {
  await db.exec(await read(d));
}
await db.exec(await read("../sql/43_event_submit.sql"));
// is_guest() comes from 22_hardening.sql, which needs half the schema; the same body here.
await db.exec(`create or replace function public.is_guest() returns boolean language sql stable as $$
  select coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'is_anonymous')::boolean, false); $$;`);

const CM = "bbbbbbbb-2222-2222-2222-222222222222";
const U = "dddddddd-4444-4444-4444-444444444444";
const G = "ffffffff-6666-6666-6666-666666666666";
const as = (id, guest = false) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"${guest ? ',"is_anonymous":true' : ""}}';`);
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const one = async (sql) => (await db.query(sql)).rows[0];
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
await db.exec(`insert into auth.users (id, email) values ('${CM}', 'b@x.com'), ('${U}', 'd@x.com'), ('${G}', null)`);
await db.exec(`update public.profiles set account_type = 'community_manager' where id = '${CM}'`);
const city = (await one(`select slug from public.cities order by sort_order limit 1`)).slug;
const kind = (await one(`select slug from public.event_types order by sort_order limit 1`)).slug;
const soon = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
const submit = (title, ticket = "https://t.example/1") =>
  `select public.event_submit('${title}', '${city}', '${kind}', null, '${soon}', '23:00', 'come', ${ticket ? `'${ticket}'` : "null"}, null) as s`;

console.log("\n— sending a night in —");
let slug;
{
  await as(U);
  slug = (await one(submit("Keller Rave"))).s;
  check(Boolean(slug), "a person sends a night in");
  check(/ticket/.test(await fails(submit("No Ticket", null)) ?? ""), "a ticket link is needed");
  const mine = await rows(`select * from public.event_submissions()`);
  check(mine.length === 1 && mine[0].review === "pending", "they see it waiting");
  await asAnon();
  check(!(await one(`select 1 as x from public.events where slug = '${slug}'`)), "nobody else sees it yet");
  await as(U);
  check(!(await one(`select 1 as x from public.events where slug = '${slug}'`)), "not even in the table for its maker");
  for (const n of [2, 3, 4, 5]) await db.exec(submit("Rave " + n));
  check(/five/.test(await fails(submit("Rave 6")) ?? ""), "at most five waiting");
  await as(G, true);
  check(/account/.test(await fails(submit("Guest Rave")) ?? ""), "a guest must make an account first");
  await asAnon();
  check(Boolean(await fails(submit("Anon Rave"))), "signed out: no");
}

console.log("\n— the staff decide —");
{
  await as(U);
  check(Boolean(await fails(`select * from public.staff_pending()`)) || (await rows(`select * from public.staff_pending()`)).length === 0, "a person sees no queue");
  check(Boolean(await fails(`select public.staff_review((select id from public.events where slug = '${slug}' limit 1), true, null)`)), "nor lets anything through");
  await as(CM);
  const q = await rows(`select * from public.staff_pending()`);
  check(q.length === 5 && q[0].title === "Keller Rave", "the queue, oldest first", JSON.stringify(q.map((r) => r.title)));
  const o = (await one(`select public.admin_overview() as o`)).o;
  check(o.pending === 5, "the panel counts it");
  check(/through/.test(await fails(`select public.staff_event_save('${q[0].id}', 'Keller Rave', '${city}', '${kind}', null, '${soon}', '23:00', '', 'https://t.example/1', null, true)`) ?? ""), "editing cannot publish past the review");
  check((await fails(`select public.staff_event_save('${q[0].id}', 'Keller Rave!', '${city}', '${kind}', null, '${soon}', '23:00', '', 'https://t.example/1', null, false)`)) === null, "but the staff may fix it before");
  await db.exec(`select public.staff_review('${q[0].id}', true, null)`);
  await db.exec(`select public.staff_review('${q[1].id}', false, 'no such club')`);
  check(Boolean(await fails(`select public.staff_review('${q[0].id}', false, null)`)), "a decided one is not decided twice");
  await asAnon();
  const pub = await one(`select title from public.events where id = '${q[0].id}'`);
  check(pub && pub.title === "Keller Rave!", "let through: everyone sees it");
  check(!(await one(`select 1 as x from public.events where id = '${q[1].id}'`)), "turned down: nobody does");
  await as(U);
  const mine = await rows(`select * from public.event_submissions() order by title`);
  const rejected = mine.find((m) => m.review === "rejected");
  check(rejected && rejected.review_note === "no such club", "the maker sees why it was turned down");
  check(mine.some((m) => m.review === null && m.is_published), "and the one that went through");
  await as(U);
  check((await one(submit("Rave 7"))).s, "a decided one frees a place in the five");
  await as(CM);
  check((await fails(`select public.staff_event_delete('${q[2].id}')`)) === null, "the staff may delete one sent in");
  const list = await rows(`select source, review from public.staff_events(50)`);
  check(list.some((l) => l.source === "user"), "the panel list carries nights sent in too");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
