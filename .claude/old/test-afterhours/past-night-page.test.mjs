/* afterhours — a night that happened still has its page (95) */

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
for (const d of ["../test/supabase-shim.sql", "../sql/setup-1-structure.sql"]) {
  await db.exec(await read(d));
}
/* a second run must not trip over the first */
await db.exec(await read("../sql/95_past_night_page.sql"));
const rows = async (sql) => (await db.query(sql)).rows;
const city = (await rows(`select id from public.cities where slug = 'munchen'`))[0].id;
const type = (await rows(`select id from public.event_types limit 1`))[0].id;
await db.exec(`insert into public.events (slug, city_id, type_id, title, meta, starts_at, source, external_id, is_published, status) values
  ('over',      '${city}', '${type}', 'Over',      'x', now() - interval '3 days', 'ticketmaster', 't1', false, 'onsale'),
  ('cancelled', '${city}', '${type}', 'Cancelled', 'x', now() + interval '3 days', 'ticketmaster', 't2', false, 'cancelled'),
  ('ahead',     '${city}', '${type}', 'Ahead',     'x', now() + interval '3 days', 'ticketmaster', 't3', true,  'onsale')`);
await db.exec(`insert into public.events (slug, city_id, type_id, title, meta, starts_at, source, is_published) values
  ('waiting', '${city}', '${type}', 'Sent in', 'x', now() + interval '5 days', 'user', false)`);

await db.exec(`set role anon; set request.jwt.claims = '';`);
const page = async (s) => (await rows(`select title from public.night_page('${s}')`))[0]?.title ?? null;
check((await rows(`select 1 from public.events_public where slug = 'over'`)).length === 0, "the plain read still hides a retired night");
check(await page("over") === "Over", "but its page opens");
check(await page("cancelled") === "Cancelled", "a cancelled night too");
check(await page("ahead") === "Ahead", "a published one as before");
check(await page("waiting") === null, "a night waiting for the staff stays hidden");
check(await page("nope") === null, "an unknown slug is nothing");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
