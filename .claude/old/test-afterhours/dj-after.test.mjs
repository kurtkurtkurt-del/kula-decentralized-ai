/* afterhours — a DJ page after the DJ (83) */

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
await db.exec(await read("../sql/83_dj_after.sql"));

const [A, B, CM] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222", "dddddddd-4444-4444-4444-444444444444"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const rows = async (sql) => (await db.query(sql)).rows;
const iso = (d) => d.toISOString();
const at = new Date("2026-10-23T20:00:00Z");
const verified = async (slug) => (await rows(`select verified from public.djs where slug = '${slug}'`))[0].verified;

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${CM}','cm@x')`);
await db.exec(`update public.profiles set account_type = 'dj' where id = '${A}'`);
await db.exec(`update public.profiles set account_type = 'community_manager' where id = '${CM}'`);
await db.exec(`insert into public.djs (slug, name, genre, owner_id) values ('owned', 'Mara Volt', 'techno', '${A}')`);
await db.exec(`insert into public.djs (slug, name, genre) values ('staff-made', 'House Cat', 'house')`);
/* the check itself is given through the staff flow (53); here it is set by hand, around the guard */
await db.exec(`alter table public.djs disable trigger guard_dj_verified`);
await db.exec(`update public.djs set verified = true, verified_at = now() where slug = 'owned'`);
await db.exec(`alter table public.djs enable trigger guard_dj_verified`);
await db.exec(`insert into public.dj_sets (dj_id, venue, starts_at) select id, 'Blitz', '${iso(new Date(at.getTime() + 30 * 60e3))}' from public.djs where slug in ('owned', 'staff-made')`);
await db.exec(`insert into public.dj_follows (user_id, dj_id) select '${B}', id from public.djs where slug in ('owned', 'staff-made')`);

console.log("\n— while the owner is here —");
{
  check(await verified("owned") === true && await verified("staff-made") === true, "both pages are checked");
  await asService();
  await db.exec(`select public.push_hourly('${iso(at)}')`);
  const got = await rows(`select data ->> 'name' as name from public.push_outbox where user_id = '${B}' and kind = 'dj_live' order by 1`);
  check(got.length === 2, "the follower hears about both sets", String(got.length));
}

console.log("\n— the owner goes —");
{
  await asService();
  await db.exec(`delete from auth.users where id = '${A}'`);
  check(await verified("owned") === false, "the owned page loses its check");
  check(await verified("staff-made") === true, "the page the staff made, with no owner, stays");
  check((await rows(`select owner_id from public.djs where slug = 'owned'`))[0].owner_id === null, "and nobody owns it now");
  await db.exec(`delete from public.push_outbox where user_id = '${B}'`);
  await db.exec(`select public.push_hourly('${iso(at)}')`);
  const got = await rows(`select data ->> 'name' as name from public.push_outbox where user_id = '${B}' and kind = 'dj_live'`);
  check(got.length === 1 && got[0].name === "House Cat", "only the checked page's set is pushed", JSON.stringify(got));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
