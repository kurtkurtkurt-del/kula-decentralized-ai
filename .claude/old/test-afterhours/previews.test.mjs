/* afterhours — listen to the artist: a preview per night, read by anyone, written by the service (63) */

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
for (const d of ["../test/supabase-shim.sql", "../sql/01_schema.sql", "../sql/02_rls.sql", "../sql/03_seed_catalog.sql", "../sql/04_seed_events.sql", "../sql/06_views.sql", "../sql/63_previews.sql", "../sql/63_previews.sql"]) {
  await db.exec(await read(d));
}
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const rows = async (sql) => (await db.query(sql)).rows;

const [a, b] = (await rows(`select id from public.events where is_published order by slug limit 2`)).map((r) => r.id);
await db.exec(`insert into public.event_previews (event_id, track, artist, preview_url, link) values
  ('${a}', 'Exhale', 'Boris Brejcha', 'https://audio-ssl.itunes.apple.com/x.m4a', 'https://music.apple.com/x'),
  ('${b}', 'Song', 'Someone', 'https://audio-ssl.itunes.apple.com/y.m4a', null)`);

console.log("\n— previews —");
check(/check/.test(await fails(`insert into public.event_previews (event_id, track, artist, preview_url) values ('${a}', 'x', 'y', 'http://plain')`) ?? ""), "only https addresses");
await db.exec(`set role anon;`);
const got = await rows(`select * from public.previews_for(array['${a}','${b}']::uuid[])`);
check(got.length === 2 && got.find((r) => r.event_id === a)?.track === "Exhale", "anyone reads the previews of published nights");
check(Boolean(await fails(`select * from public.event_previews`)), "the table itself is closed");
await db.exec(`reset role; update public.events set is_published = false where id = '${b}'`);
await db.exec(`set role anon;`);
check((await rows(`select * from public.previews_for(array['${a}','${b}']::uuid[])`)).length === 1, "an unpublished night has no preview to read");
await db.exec(`reset role;`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
