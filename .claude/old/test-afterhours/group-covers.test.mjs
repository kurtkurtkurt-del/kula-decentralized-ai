/* afterhours — a group cover from the shelf: preset/<name> beside your own file (62) */

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
                 "../sql/12_profiles.sql", "../sql/15_ticketmaster.sql", "../sql/18_geo.sql"]) {
  await db.exec(await read(d));
}
await db.exec(`create or replace function public.is_guest() returns boolean language sql stable as $$
  select coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'is_anonymous')::boolean, false); $$;`);
for (const d of ["../sql/44_groups.sql", "../sql/62_group_covers.sql", "../sql/62_group_covers.sql"]) await db.exec(await read(d));

const [A, B] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const one = async (sql) => (await db.query(sql)).rows[0];

await db.exec(`reset role; set request.jwt.claims = '';`);
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x')`);
await db.exec(`insert into public.friendships (requester_id, addressee_id, status) values ('${A}', '${B}', 'accepted')`);

console.log("\n— the cover —");
{
  await as(A);
  const g = (await one(`select public.group_create('cuma', '🪩', 'red', 'lasting', null, null, null, array['${B}']::uuid[]) as g`)).g;
  check((await fails(`select public.group_set_cover('${g}', 'preset/club')`)) === null, "a preset from the shelf");
  check((await one(`select public.group_get('${g}') as j`)).j.cover_path === "preset/club", "the group wears it");
  check(/your file/.test(await fails(`select public.group_set_cover('${g}', 'preset/../etc')`) ?? ""), "only a plain name after preset/");
  check(/your file/.test(await fails(`select public.group_set_cover('${g}', '${B}/x.jpg')`) ?? ""), "someone else's folder is still refused");
  check((await fails(`select public.group_set_cover('${g}', '${A}/own.jpg')`)) === null, "your own file still works");
  check((await one(`select public.group_set_cover('${g}', null) as was`)).was === `${A}/own.jpg`, "taking it off returns what was there");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
