/* afterhours — the hour a night starts, in its own city (92) */

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
await db.exec(await read("../test/supabase-shim.sql"));
/* the structure without 92, then a synced night the old way, then 92 */
const all = await read("../sql/setup-1-structure.sql");
const cut = all.indexOf("(92_timezones.sql)");
await db.exec(all.slice(0, all.lastIndexOf("\n-- =====", cut)));
const rows = async (sql) => (await db.query(sql)).rows;
const city = (await rows(`select id from public.cities where slug = 'munchen'`))[0].id;
const ist = (await rows(`select id from public.cities where slug = 'istanbul'`))[0].id;
const type = (await rows(`select id from public.event_types limit 1`))[0].id;
await db.exec(`insert into public.events (slug, city_id, type_id, title, meta, starts_at, date_text, source, external_id) values
  ('old-way',  '${city}', '${type}', 'Old', 'x', '2026-10-31T20:00:00Z', '31.10.26 · 20:00', 'ticketmaster', 'tm-1'),
  ('old-ist',  '${ist}',  '${type}', 'Old', 'x', '2026-10-31T20:00:00Z', '31.10.26 · 20:00', 'ticketmaster', 'tm-2'),
  ('right',    '${city}', '${type}', 'Right','x', '2026-10-31T19:00:00Z', '31.10.26 · 20:00', 'ticketmaster', 'tm-4'),
  ('ours',     '${city}', '${type}', 'Ours','x', '2026-10-31T20:00:00Z', '31.10.26 · 20:00', 'seed', null)`);
await db.exec(await read("../sql/92_timezones.sql"));
const at = async (slug) => (await rows(`select starts_at from public.events where slug = '${slug}'`))[0].starts_at.toISOString();

check((await rows(`select tz from public.cities where slug = 'istanbul'`))[0].tz === "Europe/Istanbul", "cities know their zone");
check(await at("old-way") === "2026-10-31T19:00:00.000Z", "20:00 in munich became 19:00 utc", await at("old-way"));
check(await at("old-ist") === "2026-10-31T17:00:00.000Z", "20:00 in istanbul became 17:00 utc", await at("old-ist"));
check(await at("ours") === "2026-10-31T20:00:00.000Z", "our own rows are not moved");
check(await at("right") === "2026-10-31T19:00:00.000Z", "a row already right (as on the live database) stays where it is", await at("right"));
check((await rows(`select tz from public.events where slug = 'right'`))[0].tz === "Europe/Berlin", "and still learns its zone");
await db.exec(await read("../sql/92_timezones.sql"));
check(await at("old-way") === "2026-10-31T19:00:00.000Z", "a second run moves nothing");
await db.exec(`insert into public.events (slug, city_id, type_id, title, meta, starts_at, tz, source, external_id) values
  ('new-way', '${city}', '${type}', 'New', 'x', '2026-10-31T20:00:00 Europe/Berlin', 'Europe/Berlin', 'ticketmaster', 'tm-3')`);
check(await at("new-way") === "2026-10-31T19:00:00.000Z", "the sync's new form, a zone name after the time, lands right");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
