/* afterhours — did you get your ticket? (60) */

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
await db.exec(await read("../test/supabase-shim.sql"));
await db.exec(await read("../sql/setup-1-structure.sql"));

const [A, B, G] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222", "eeeeeeee-5555-5555-5555-555555555555"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asGuest = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}","is_anonymous":true}';`);
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const one = async (sql) => (await db.query(sql)).rows[0];
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${G}','g@x');`);
const night = (await one(`select slug, id from public.events where is_published order by starts_at nulls last limit 1`));

console.log("\n— the answer —");
{
  await as(A);
  check((await one(`select public.ticket_state('${night.slug}') as s`)).s === null, "nothing yet");
  await db.exec(`select public.ticket_mark('${night.slug}', 'got')`);
  check((await one(`select public.ticket_state('${night.slug}') as s`)).s === "got", "got: remembered");
  check((await rows(`select * from public.tickets_mine()`)).some((r) => r.tickets_mine === night.id), "and in the list of nights with a ticket");
  await db.exec(`select public.ticket_mark('${night.slug}', 'no')`);
  check((await one(`select public.ticket_state('${night.slug}') as s`)).s === "no", "no: the answer changes, one row");
  check((await rows(`select * from public.tickets_mine()`)).length === 0, "and leaves the list");
  check(Boolean(await fails(`select public.ticket_mark('${night.slug}', 'maybe')`)), "only got or no");
  check(Boolean(await fails(`select public.ticket_mark('no-such-night', 'got')`)), "a night that is not there");
}

console.log("\n— whose it is —");
{
  await as(B);
  check((await one(`select public.ticket_state('${night.slug}') as s`)).s === null, "someone else sees nothing");
  check(Boolean(await fails(`select * from public.tickets`)), "the table itself is closed");
  await asGuest(G);
  check(Boolean(await fails(`select public.ticket_mark('${night.slug}', 'got')`)), "a guest is refused");
  await asAnon();
  check(Boolean(await fails(`select public.ticket_mark('${night.slug}', 'got')`)), "signed out: refused");
  await asService();
  await db.exec(`delete from auth.users where id = '${A}'`);
  check((await rows(`select * from public.tickets where user_id = '${A}'`)).length === 0, "goes with the account");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
