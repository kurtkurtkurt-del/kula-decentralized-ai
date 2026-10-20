/* afterhours — what a guest kept comes along (80) */

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
await db.exec(await read("../sql/80_guest_merge.sql"));

const [A, B, G] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222", "99999999-9999-9999-9999-999999999999"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asGuest = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}","is_anonymous":true}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x')`);
await db.exec(`insert into auth.users (id, email, is_anonymous) values ('${G}', null, true)`);
const nights = (await rows(`select id from public.events where is_published order by slug limit 3`)).map((r) => r.id);
await db.exec(`insert into public.swipes (user_id, event_id, direction) values
  ('${G}', '${nights[0]}', 'right'), ('${G}', '${nights[1]}', 'right'), ('${G}', '${nights[2]}', 'left'),
  ('${A}', '${nights[0]}', 'left')`);

console.log("\n— who may —");
{
  await asGuest(G);
  check(Boolean(await fails(`select public.guest_merge('${G}')`)), "a guest cannot merge anything");
  await as(A);
  check(Boolean(await fails(`select public.guest_merge('${B}')`)), "an account with an email is not a guest and cannot be taken");
  check((await rows(`select public.guest_merge('${A}') as n`))[0].n === 0, "merging yourself does nothing");
}

console.log("\n— the move —");
{
  await as(A);
  check((await rows(`select public.guest_merge('${G}') as n`))[0].n === 2, "two swipes come along");
  await asService();
  const mine = await rows(`select event_id, direction from public.swipes where user_id = '${A}' order by event_id`);
  check(mine.length === 3, "the account now holds three");
  check(mine.find((r) => r.event_id === nights[0]).direction === "left", "the night already swiped keeps the account's answer");
  check((await rows(`select 1 from auth.users where id = '${G}'`)).length === 0, "the guest user is gone");
  check((await rows(`select 1 from public.swipes where user_id = '${G}'`)).length === 0, "and its swipes with it");
  await as(A);
  check(Boolean(await fails(`select public.guest_merge('${G}')`)), "a second call finds no guest");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
