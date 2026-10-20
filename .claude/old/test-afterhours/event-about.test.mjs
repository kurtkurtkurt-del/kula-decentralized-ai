/* afterhours — "who is this?": texts about the act on a night (40) */

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
                 "../sql/40_event_about.sql"]) {
  await db.exec(await read(d));
}
await db.exec(await read("../sql/40_event_about.sql"));

const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asUser = () => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"aaaaaaaa-1111-1111-1111-111111111111"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
const [a, b] = (await rows(`select id, slug from public.events where is_published order by slug limit 2`));

console.log("\n— the one-shot for Munich —");
{
  check((await fails(await read("../sql/about-munich.sql"))) === null, "about-munich.sql runs (nights that are not there are skipped)");
  await db.exec(`update public.events set slug = 'murda-uzay-tour-3be8f956' where id = '${a.id}'`);
  await db.exec(await read("../sql/about-munich.sql"));
  const got = await rows(`select lang, name from public.event_about where event_id = '${a.id}' order by lang`);
  check(got.map((r) => r.lang).join(",") === "de,en,tr" && got[0].name === "Murda", "a night that is there gets its three languages", JSON.stringify(got));
  await db.exec(await read("../sql/about-munich.sql"));
  check((await rows(`select 1 from public.event_about where event_id = '${a.id}'`)).length === 3, "running it again changes nothing");
}

console.log("\n— reading —");
{
  await asAnon();
  const tr = await rows(`select name, who, facts from public.about_for(array['${a.id}', '${b.id}']::uuid[], 'tr')`);
  check(tr.length === 1 && tr[0].facts.length === 2, "signed out too: the night with a text, in Turkish", JSON.stringify(tr));
  const xx = await rows(`select kicker from public.about_for(array['${a.id}']::uuid[], 'fr')`);
  check(xx.length === 1 && /rapper/.test(xx[0].kicker), "an unknown language falls back to English");
  check(Boolean(await fails(`select * from public.event_about`)), "the table itself is closed");
  await asUser();
  check(Boolean(await fails(`insert into public.event_about (event_id, lang, name, kicker, source_url) values ('${b.id}', 'en', 'x', 'x', 'https://x')`)), "nobody but the service writes");
  await asService();
  await db.exec(`update public.events set is_published = false where id = '${a.id}'`);
  await asAnon();
  check((await rows(`select 1 from public.about_for(array['${a.id}']::uuid[], 'tr')`)).length === 0, "an unpublished night shows nothing");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
