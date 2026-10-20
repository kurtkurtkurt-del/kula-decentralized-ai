/* afterhours — a spark taken back tells the people who said in (75) */

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
await db.exec(await read("../sql/75_spark_off.sql"));

const [A, B, C] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222", "cccccccc-3333-3333-3333-333333333333"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const rows = async (sql) => (await db.query(sql)).rows;
const outbox = async (user) => { await asService(); return rows(`select key, data from public.push_outbox where user_id = '${user}' and kind = 'spark_off'`); };

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${C}','c@x')`);
await db.exec(`update public.profiles set handle = 'ada' where id = '${A}'`);
await db.exec(`update public.profiles set handle = 'berk' where id = '${B}'`);
await db.exec(`update public.profiles set handle = 'cansu' where id = '${C}'`);
await db.exec(`insert into public.friendships (requester_id, addressee_id, status) values ('${A}','${B}','accepted'), ('${A}','${C}','accepted')`);
await as(A);
const spark = (await rows(`select public.spark_create('grill', 'grill at the river', now() + interval '2 days', 'river', 1) as id`))[0].id;
await as(B);
await db.exec(`select public.spark_answer('${spark}', 'in')`);
await as(C);
await db.exec(`select public.spark_answer('${spark}', 'out')`);
await asService();
await db.exec(`delete from public.push_outbox`);

console.log("\n— the host takes it back —");
{
  await as(B);
  check(Boolean(await fails(`select public.spark_cancel('${spark}')`)), "only the host can");
  await as(A);
  await db.exec(`select public.spark_cancel('${spark}')`);
  const b = await outbox(B);
  check(b.length === 1 && b[0].data.name === "ada" && b[0].data.title === "grill at the river", "the one who said in hears: ada took it back", JSON.stringify(b));
  check((await outbox(C)).length === 0, "the one who said out hears nothing");
  check((await outbox(A)).length === 0, "nor the host");
  check((await rows(`select 1 from public.sparks where id = '${spark}'`)).length === 0, "and the spark is gone");
  const words = await rows(`select * from public.push_text('spark_off', 'de', '{"name":"ada","title":"grill"}')`);
  check(words[0].title === "ada hat es abgesagt" && words[0].body === "grill", "the words, in german");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
