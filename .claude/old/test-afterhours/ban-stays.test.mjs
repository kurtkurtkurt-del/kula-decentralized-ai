/* afterhours — a ban stays (74): the address comes back banned, the handle stays taken, the room forgets the banned */

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
await db.exec(await read("../sql/74_ban_stays.sql"));

const [A, B, CM, B2] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222",
                        "cccccccc-3333-3333-3333-333333333333", "bbbbbbbb-9999-9999-9999-999999999999"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','Berk@Example.com'),('${CM}','cm@x')`);
await db.exec(`update public.profiles set handle = 'ada' where id = '${A}'`);
await db.exec(`update public.profiles set handle = 'berk' where id = '${B}'`);
await db.exec(`update public.profiles set account_type = 'community_manager' where id = '${CM}'`);
const night = (await rows(`select id, slug from public.events where is_published limit 1`))[0];
await db.exec(`insert into public.checkins (user_id, event_id) values ('${A}', '${night.id}'), ('${B}', '${night.id}')`);
await db.exec(`insert into public.room_posts (event_id, user_id, body) values ('${night.id}', '${B}', 'berk in the room')`);

console.log("\n— the ban, then the room —");
{
  await as(CM);
  await db.exec(`select public.staff_ban('${B}', 'spam')`);
  await as(A);
  check(!(await rows(`select body from public.room_list('${night.slug}')`)).some((r) => r.body === "berk in the room"), "the room no longer shows what a banned account wrote");
}

console.log("\n— the banned person deletes the account and comes back —");
{
  await as(B);
  await db.exec(`select public.delete_account()`);
  await asService();
  check((await rows(`select 1 from public.banned_marks where handle = 'berk'`)).length === 1, "a mark of the email and the handle stays behind");
  check((await rows(`select 1 from public.profiles where id = '${B}'`)).length === 0, "the account itself is gone");
  await db.exec(`insert into auth.users (id, email) values ('${B2}', 'berk@example.com')`);
  const again = (await rows(`select banned_at, banned_reason from public.profiles where id = '${B2}'`))[0];
  check(again.banned_at !== null && again.banned_reason === "banned before", "the same address, in any case, is banned at birth", JSON.stringify(again));
  await as(A);
  check((await rows(`select public.handle_status('berk') as s`))[0].s === "taken", "the handle stays taken");
  check((await rows(`select public.handle_status('berk2') as s`))[0].s === "ok", "another handle is free");
  await as(B2);
  check(Boolean(await fails(`select * from public.banned_marks`)), "the marks cannot be read");
}

console.log("\n— an ordinary deletion leaves no mark —");
{
  await as(A);
  await db.exec(`select public.delete_account()`);
  await asService();
  check((await rows(`select 1 from public.banned_marks where handle = 'ada'`)).length === 0, "someone who was not banned is not remembered");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
