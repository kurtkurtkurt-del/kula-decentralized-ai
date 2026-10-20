/* afterhours — who answered a spark, by name */

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
  process.exit(1);
});

const db = new PGlite();
for (const d of ["../test/supabase-shim.sql", "../sql/01_schema.sql", "../sql/02_rls.sql",
                 "../sql/03_seed_catalog.sql", "../sql/06_views.sql", "../sql/07_friends.sql",
                 "../sql/12_profiles.sql", "../sql/27_sparks.sql", "../sql/28_spark_waves.sql",
                 "../sql/35_spark_people.sql"]) {
  await db.exec(await read(d));
}
await db.exec(await read("../sql/35_spark_people.sql"));

const A = "aaaaaaaa-1111-1111-1111-111111111111";  /* host */
const B = "bbbbbbbb-2222-2222-2222-222222222222";  /* in */
const C = "cccccccc-3333-3333-3333-333333333333";  /* out */
const D = "dddddddd-4444-4444-4444-444444444444";  /* in */
const E = "eeeeeeee-5555-5555-5555-555555555555";  /* not answered */
const S = "99999999-7777-7777-7777-777777777777";  /* stranger */

const asUser = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const rows = async (sql) => (await db.query(sql)).rows;
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };

await asService();
await db.exec(`
  insert into auth.users (id, email) values
    ('${A}', 'a@x.com'), ('${B}', 'b@x.com'), ('${C}', 'c@x.com'), ('${D}', 'd@x.com'), ('${E}', 'e@x.com'), ('${S}', 's@x.com');
  update public.profiles set handle = 'ada' where id = '${A}';
  update public.profiles set handle = 'berk'  where id = '${B}';
  update public.profiles set handle = 'cansu' where id = '${C}';
  update public.profiles set handle = 'deniz' where id = '${D}';
  update public.profiles set handle = 'ece'   where id = '${E}';
  insert into public.friendships (requester_id, addressee_id, status) values
    ('${A}', '${B}', 'accepted'), ('${A}', '${C}', 'accepted'), ('${A}', '${D}', 'accepted'), ('${A}', '${E}', 'accepted');
`);
await asUser(A);
const id = (await rows(`select public.spark_create('grill', 'grill', now() + interval '1 day', 'river', 1) as id`))[0].id;
for (const [who, a] of [[B, "in"], [C, "out"], [D, "in"]]) {
  await asUser(who);
  await db.exec(`select public.spark_answer('${id}', '${a}')`);
}
const people = async (who) => { await asUser(who); return rows(`select name, answer, me from public.spark_people('${id}')`); };

console.log("\n— the host —");
{
  const p = await people(A);
  check(p.length === 3, "the host sees everyone who answered", JSON.stringify(p));
  check(p[0].answer === "in" && p[1].answer === "in" && p[2].answer === "out", "in first, then out");
  check(!p.some((r) => r.name === "ece"), "someone who has not answered is not listed");
}

console.log("\n— the others —");
{
  const b = await people(B);
  check(b.length === 2 && b.every((r) => r.answer === "in"), "someone who is in sees the others who are in, not the no", JSON.stringify(b));
  check(b.some((r) => r.name === "berk" && r.me), "and finds themselves marked");
  check((await people(C)).length === 0, "someone who said out sees nobody");
  check((await people(E)).length === 0, "someone who has not answered sees nobody");
  check((await people(S)).length === 0, "a stranger sees nobody");
  await asAnon();
  check(Boolean(await fails(`select * from public.spark_people('${id}')`)), "signed out, closed");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
