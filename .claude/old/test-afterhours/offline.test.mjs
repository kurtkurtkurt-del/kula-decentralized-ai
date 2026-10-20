/* afterhours — writes made offline: a second try changes nothing (37) */

import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

const read = (y) => readFile(new URL(y, import.meta.url), "utf8");
let passed = 0, failed = 0;
const check = (k, name, extra = "") => {
  if (k) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
};
process.on("unhandledRejection", (e) => {
  console.log("\nERROR: " + ((e && e.message) || e));
  if (e && e.where) console.log("  " + e.where);
  process.exit(1);
});

const db = new PGlite();
for (const d of ["../test/supabase-shim.sql", "../sql/01_schema.sql", "../sql/02_rls.sql",
                 "../sql/03_seed_catalog.sql", "../sql/04_seed_events.sql", "../sql/06_views.sql",
                 "../sql/07_friends.sql", "../sql/12_profiles.sql", "../sql/15_ticketmaster.sql",
                 "../sql/18_geo.sql", "../sql/19_checkins.sql", "../sql/20_djs.sql", "../sql/22_hardening.sql", "../sql/23_checkin_open.sql",
                 "../sql/37_offline.sql"]) {
  await db.exec(await read(d));
}
// Running it twice is harmless.
await db.exec(await read("../sql/37_offline.sql"));

const A = "aaaaaaaa-1111-1111-1111-111111111111";
const B = "bbbbbbbb-2222-2222-2222-222222222222";
const J1 = "11111111-aaaa-4aaa-8aaa-111111111111";
const J2 = "22222222-aaaa-4aaa-8aaa-222222222222";

const asUser = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
await db.exec(`
  insert into auth.users (id, email) values ('${A}', 'a@x.com'), ('${B}', 'b@x.com');
  update public.profiles set handle = 'ada' where id = '${A}';
  update public.profiles set handle = 'berk'  where id = '${B}';
`);
const [ev] = await rows(`select id, slug from public.events where is_published order by slug limit 1`);

console.log("\n— check-in —");
{
  await asUser(A);
  const at = new Date(Date.now() - 2 * 3600_000).toISOString();
  const [a] = await rows(`select public.check_in('${ev.slug}', null, null, '${at}') as n`);
  const [b] = await rows(`select public.check_in('${ev.slug}', null, null, '${at}') as n`);
  check(a.n !== null && a.n === b.n, "the second try returns the same card");
  await asService();
  const [c] = await rows(`select count(*)::int as n, min(checked_at) as t from public.checkins where user_id = '${A}'`);
  check(c.n === 1, "one card, not two");
  check(Math.abs(new Date(c.t).getTime() - new Date(at).getTime()) < 1000, "the card keeps the time the button was pressed");

  await asUser(B);
  const future = new Date(Date.now() + 5 * 3600_000).toISOString();
  await db.exec(`select public.check_in('${ev.slug}', null, null, '${future}')`);
  const old = new Date(Date.now() - 40 * 3600_000).toISOString();
  await asService();
  const [f] = await rows(`select checked_at from public.checkins where user_id = '${B}'`);
  check(new Date(f.checked_at).getTime() <= Date.now() + 1000, "a time in the future becomes now");

  await db.exec(`delete from public.checkins where user_id = '${B}'`);
  await asUser(B);
  await db.exec(`select public.check_in('${ev.slug}', null, null, '${old}')`);
  await asService();
  const [g] = await rows(`select checked_at from public.checkins where user_id = '${B}'`);
  check(new Date(g.checked_at).getTime() > Date.now() - 60_000, "more than 12 hours back becomes now");

  await asUser(A);
  check((await fails(`select public.check_in('${ev.slug}')`)) === null, "the old call without a time still works");
}

console.log("\n— room lines —");
{
  await asUser(A);
  const [a] = await rows(`select public.room_post('${ev.slug}', 'hello', '${J1}') as id`);
  const [b] = await rows(`select public.room_post('${ev.slug}', 'hello', '${J1}') as id`);
  check(a.id === b.id, "the same job id gives back the same line");
  await db.exec(`select public.room_post('${ev.slug}', 'hello', '${J2}')`);
  await db.exec(`select public.room_post('${ev.slug}', 'again')`);
  await asService();
  const [c] = await rows(`select count(*)::int as n from public.room_posts where user_id = '${A}'`);
  check(c.n === 3, "another job id or none is a new line", String(c.n));

  await asService();
  await db.exec(`delete from public.checkins where user_id = '${B}'`);
  await asUser(B);
  check(/notthere/.test((await fails(`select public.room_post('${ev.slug}', 'hi', '${J1}')`)) ?? ""), "someone else cannot reuse a job id to skip the door");
}

console.log("\n— comments —");
{
  await asUser(A);
  await db.exec(`insert into public.comments (event_id, body, client_id) values ('${ev.id}', 'first', '${J1}') on conflict (author_id, client_id) do nothing`);
  await db.exec(`insert into public.comments (event_id, body, client_id) values ('${ev.id}', 'first', '${J1}') on conflict (author_id, client_id) do nothing`);
  await db.exec(`insert into public.comments (event_id, body) values ('${ev.id}', 'no id')`);
  await db.exec(`insert into public.comments (event_id, body) values ('${ev.id}', 'no id')`);
  await asService();
  const [c] = await rows(`select count(*) filter (where client_id = '${J1}')::int as dup, count(*) filter (where client_id is null)::int as plain from public.comments where author_id = '${A}'`);
  check(c.dup === 1, "a comment sent twice with its id is stored once");
  check(c.plain === 2, "comments without an id (older apps) are not blocked");

  await asUser(B);
  await db.exec(`insert into public.comments (event_id, body, client_id) values ('${ev.id}', 'mine', '${J1}') on conflict (author_id, client_id) do nothing`);
  await asService();
  const [d] = await rows(`select count(*)::int as n from public.comments where author_id = '${B}'`);
  check(d.n === 1, "the same id from someone else is their own comment");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
