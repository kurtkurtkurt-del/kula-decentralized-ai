/* afterhours — who has read what, kept by the server (90) */

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
await db.exec(await read("../sql/90_dm_seen.sql"));

const [A, B] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const rows = async (sql) => (await db.query(sql)).rows;
const unread = async (who) => { await as(who); return (await rows(`select unread from public.dm_list()`))[0]?.unread; };

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x')`);
await db.exec(`update public.profiles set handle = 'ada' where id = '${A}'`);
await db.exec(`update public.profiles set handle = 'berk' where id = '${B}'`);
await db.exec(`insert into public.friendships (requester_id, addressee_id, status) values ('${A}', '${B}', 'accepted')`);
await as(A);
const thread = (await rows(`select public.dm_start('berk') as t`))[0].t;
await db.exec(`select public.dm_send('${thread}', 'one')`);
await db.exec(`select public.dm_send('${thread}', 'two')`);
const last = Number((await rows(`select public.dm_send('${thread}', 'three') as id`))[0].id);

check(await unread(B) === 3, "berk has three unread");
check(await unread(A) === 0, "my own lines are not unread to me");
await as(B);
await db.exec(`select public.dm_seen('${thread}', ${last - 1})`);
check(await unread(B) === 1, "seen up to the second: one left");
await db.exec(`select public.dm_seen('${thread}', ${last - 2})`);
check(await unread(B) === 1, "a mark never moves back");
await as(B);
await db.exec(`select public.dm_send('${thread}', 'back at you')`);
check(await unread(A) === 1, "and the reply is new to ada");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
