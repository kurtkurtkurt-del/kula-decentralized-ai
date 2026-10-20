/* afterhours — "I am in" reaches the friends on that night (69) */

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
await db.exec(await read("../sql/69_rsvp_push.sql"));

const [A, B, C, D] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222",
                      "cccccccc-3333-3333-3333-333333333333", "dddddddd-4444-4444-4444-444444444444"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const rows = async (sql) => (await db.query(sql)).rows;
const outbox = async (user) => { await asService(); return rows(`select key, data from public.push_outbox where user_id = '${user}' and kind = 'match' order by id`); };

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${C}','c@x'),('${D}','d@x')`);
await db.exec(`update public.profiles set handle = 'ada' where id = '${A}'`);
await db.exec(`update public.profiles set handle = 'berk' where id = '${B}'`);
await db.exec(`update public.profiles set handle = 'cansu' where id = '${C}'`);
await db.exec(`update public.profiles set handle = 'deniz' where id = '${D}'`);
await db.exec(`insert into public.friendships (requester_id, addressee_id, status) values ('${A}','${B}','accepted'), ('${A}','${C}','accepted')`);
const night = (await rows(`select id, title from public.events where is_published limit 1`))[0];
/* B kept the night; C answered in; D (a stranger) kept it too */
await db.exec(`insert into public.swipes (user_id, event_id, direction) values ('${B}', '${night.id}', 'right'), ('${D}', '${night.id}', 'right')`);
await db.exec(`insert into public.rsvps (user_id, event_id, answer) values ('${C}', '${night.id}', 'in')`);
await db.exec(`delete from public.push_outbox`);

console.log("\n— ada says in —");
{
  await as(A);
  await db.exec(`select public.rsvp_set('${night.id}', 'in')`);
  const b = await outbox(B);
  check(b.length === 1 && b[0].key.startsWith("rsvp:") && b[0].data.name === "ada" && b[0].data.title === night.title, "the friend who kept it hears: ada is going too", JSON.stringify(b));
  check((await outbox(C)).length === 1, "the friend who answered in hears it too");
  check((await outbox(D)).length === 0, "a stranger on the same night hears nothing");
  check((await outbox(A)).length === 0, "not yourself");
}

console.log("\n— once, and only for in —");
{
  await as(A);
  await db.exec(`select public.rsvp_set('${night.id}', 'maybe')`);
  await db.exec(`select public.rsvp_set('${night.id}', 'in')`);
  check((await outbox(B)).length === 1, "changing the answer and back says it once");
  await as(B);
  await db.exec(`select public.rsvp_set('${night.id}', 'out')`);
  check((await outbox(A)).length === 0, "out says nothing");
  await as(C);
  await db.exec(`select public.rsvp_set('${night.id}', 'maybe')`);
  check((await outbox(A)).length === 0, "maybe says nothing");
}

console.log("\n— private keeps stay quiet —");
{
  await asService();
  await db.exec(`update public.profile_settings set kept_visibility = 'private' where user_id = '${B}'`);
  await db.exec(`delete from public.push_outbox`);
  await as(B);
  await db.exec(`select public.rsvp_set('${night.id}', 'in')`);
  check((await outbox(A)).length === 0, "someone who keeps their keeps private tells nobody");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
