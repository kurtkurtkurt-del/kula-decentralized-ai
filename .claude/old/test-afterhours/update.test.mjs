/* afterhours — the update file.
   Buradaki asil mesele SU: one goc dosyasini GUNCEL semaya karsi test
   proves nothing. That is exactly what happened the first time: the
   bende passed, sahibin projesinde "column c.continent does not exist"
   update stopped on a live project, because its schema had no such column.

   So here we roll the schema back to its OLD state first.  */

import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

const read = (y) => readFile(new URL(y, import.meta.url), "utf8");
let passed = 0, failed = 0;
const check = (k, name, extra = "") => {
  if (k) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
};
process.on("unhandledRejection", (e) => {
  console.log("\nERROR: " + ((e && e.message) || e)); process.exit(1);
});

const db = new PGlite();
for (const d of ["../test/supabase-shim.sql", "../sql/01_schema.sql", "../sql/02_rls.sql",
                 "../sql/03_seed_catalog.sql", "../sql/04_seed_events.sql",
                 "../sql/06_views.sql", "../sql/07_friends.sql"]) {
  await db.exec(await read(d));
}

console.log("\n— rolling the schema back to before the world —");
await db.exec(`
  drop function if exists public.city_counts();
  alter table public.cities drop column if exists country;
  alter table public.cities drop column if exists country_slug;
  alter table public.cities drop column if exists continent;
  alter table public.cities drop column if exists continent_slug;
  delete from public.cities where slug in ('hamburg','frankfurt','leipzig','izmir','graz');
`);
{
  const r = await db.query(`select count(*)::int as n from public.cities`);
  check(r.rows[0].n === 6, "the old state: 6 cities, no country/continent columns");
}

console.log("\n— applying the update —");
{
  let err = null;
  try { await db.exec(await read("../sql/update-world.sql")); }
  catch (e) { err = e.message; }
  check(!err, "the update runs on the old schema", err);
}

{
  const r = await db.query(`
    select (select count(*) from public.cities) s,
           (select count(*) from public.events) e,
           (select count(distinct continent_slug) from public.cities) k,
           (select count(distinct country_slug) from public.cities) u`);
  check(Number(r.rows[0].s) === 54, "54 cities", "found " + r.rows[0].s);
  check(Number(r.rows[0].e) === 142, "142 events (36 Munich + 106 world)", "found " + r.rows[0].e);
  check(Number(r.rows[0].k) === 6, "6 continents");
  check(Number(r.rows[0].u) === 18, "18 countries");

  const c = await db.query(`select count(*)::int as n from public.city_counts()`);
  check(c.rows[0].n === 54, "city_counts works");

  /* Exactly three cities per country - the filter is built on that */
  const threeEach = await db.query(`
    select count(*)::int as n from (
      select country_slug from public.cities
      group by country_slug having count(*) <> 3
    ) x`);
  check(threeEach.rows[0].n === 0, "every country has exactly three cities");

  /* The poster numbers must not collide: each event shows its own */
  const clashing = await db.query(`
    select count(*)::int as n from (
      select poster_no from public.events
      where poster_no is not null group by poster_no having count(*) > 1
    ) x`);
  check(clashing.rows[0].n === 0, "no poster is used by two events");
}

console.log("\n— running it a second time —");
{
  await db.exec(await read("../sql/update-world.sql"));
  const r = await db.query(`
    select (select count(*) from public.cities) s, (select count(*) from public.events) e`);
  check(Number(r.rows[0].s) === 54 && Number(r.rows[0].e) === 142,
    "the counts did not change", r.rows[0].s + " / " + r.rows[0].e);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
