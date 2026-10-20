/* afterhours — the deck does not depend on the clock job (67): a past synced night is off the deck and out of the counts */

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
await db.exec(await read("../sql/67_deck_today.sql"));

const rows = async (sql) => (await db.query(sql)).rows;
await db.exec(`set role anon; set request.jwt.claims = '';`);
await db.exec(`reset role;`);
const city = (await rows(`select id, slug from public.cities order by sort_order limit 1`))[0];
const type = (await rows(`select id, slug from public.event_types limit 1`))[0];
await db.exec(`
  insert into public.events (slug, city_id, type_id, title, meta, starts_at, source, external_id) values
    ('tm-yesterday', '${city.id}', '${type.id}', 'Yesterday',   'x', now() - interval '26 hours', 'ticketmaster', 'y1'),
    ('tm-tonight',   '${city.id}', '${type.id}', 'Tonight',     'x', now() + interval '3 hours',  'ticketmaster', 't1'),
    ('tm-running',   '${city.id}', '${type.id}', 'Still going', 'x', now() - interval '2 hours',  'ticketmaster', 'r1'),
    ('ours-past',    '${city.id}', '${type.id}', 'Our own',     'x', now() - interval '26 hours', 'seed', null);
`);
await db.exec(`set role anon; set request.jwt.claims = '';`);

console.log("\n— the deck, signed out —");
{
  const d = (await rows(`select slug from public.deck('${city.slug}', null, 500)`)).map((r) => r.slug);
  check(!d.includes("tm-yesterday"), "a synced night from yesterday is off the deck, cron or no cron");
  check(d.includes("tm-tonight"), "tonight is on it");
  check(d.includes("tm-running"), "a night that started two hours ago is still on it");
  check(d.includes("ours-past"), "our own past night is left to the jobs, as before");
}

console.log("\n— the counters —");
{
  const t = await rows(`select n from public.event_counts('${city.slug}') where type_slug = '${type.slug}'`);
  const c = await rows(`select n from public.city_counts() where slug = '${city.slug}'`);
  await db.exec(`reset role;`);
  const all = (await rows(`select count(*)::int as n from public.events e join public.cities c on c.id = e.city_id where c.slug = '${city.slug}' and e.is_published`))[0].n;
  check(Number(t[0].n) < all && Number(c[0].n) < all, "the type and city counts leave yesterday out", `${t[0].n} / ${c[0].n} of ${all}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
