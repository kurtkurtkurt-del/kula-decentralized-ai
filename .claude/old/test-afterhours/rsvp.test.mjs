/* afterhours — who is coming: answers stored, friends see them */

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
                 "../sql/07_friends.sql", "../sql/12_profiles.sql", "../sql/32_rsvp.sql"]) {
  await db.exec(await read(d));
}
await db.exec(await read("../sql/32_rsvp.sql"));

const A = "aaaaaaaa-1111-1111-1111-111111111111";   /* me */
const B = "bbbbbbbb-2222-2222-2222-222222222222";   /* friend */
const C = "cccccccc-3333-3333-3333-333333333333";   /* stranger */

const asUser = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
await db.exec(`
  insert into auth.users (id, email) values ('${A}', 'a@x.com'), ('${B}', 'b@x.com'), ('${C}', 'c@x.com');
  update public.profiles set handle = 'ada' where id = '${A}';
  update public.profiles set handle = 'berk'  where id = '${B}';
  update public.profiles set handle = 'cansu' where id = '${C}';
  insert into public.friendships (requester_id, addressee_id, status) values ('${A}', '${B}', 'accepted');
`);
const [e1, e2] = (await rows(`select id from public.events order by slug limit 2`)).map((r) => r.id);

console.log("\n— answering —");
{
  await asUser(A);
  await db.exec(`select public.rsvp_set('${e1}', 'in')`);
  await asUser(B);
  await db.exec(`select public.rsvp_set('${e1}', 'maybe')`);
  await asUser(C);
  await db.exec(`select public.rsvp_set('${e1}', 'in')`);
  await asUser(A);
  const mine = await rows(`select name, answer, mine from public.rsvp_for(array['${e1}']::uuid[])`);
  check(mine.length === 2, "I see my answer and my friend's, not the stranger's", JSON.stringify(mine));
  check(mine[0].name === "ada" && mine[0].answer === "in" && mine[0].mine, "in comes first, marked as mine");
  check(mine[1].name === "berk" && mine[1].answer === "maybe", "then the friend's maybe");

  await db.exec(`select public.rsvp_set('${e1}', 'out')`);
  check((await rows(`select answer from public.rsvp_for(array['${e1}']::uuid[]) where mine`))[0].answer === "out", "answering again changes it");
  await db.exec(`select public.rsvp_set('${e1}', null)`);
  check((await rows(`select 1 from public.rsvp_for(array['${e1}']::uuid[]) where mine`)).length === 0, "an empty answer takes it back");

  check(Boolean(await fails(`select public.rsvp_set('${e1}', 'sure')`)), "only in, maybe, out");
  check(Boolean(await fails(`select public.rsvp_set('99999999-9999-9999-9999-999999999999', 'in')`)), "only real nights");
  check((await rows(`select 1 from public.rsvp_for(array['${e2}']::uuid[])`)).length === 0, "other nights stay apart");
}

console.log("\n— closed —");
{
  await asUser(C);
  const c = await rows(`select name from public.rsvp_for(array['${e1}']::uuid[])`);
  check(c.length === 1 && c[0].name === "cansu", "a stranger sees only their own answer");
  check(Boolean(await fails(`select * from public.rsvps`)), "the table cannot be read directly");
  await asAnon();
  check(Boolean(await fails(`select public.rsvp_set('${e1}', 'in')`)), "signed out, nothing can be answered");
  check(Boolean(await fails(`select * from public.rsvp_for(array['${e1}']::uuid[])`)), "nor read");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
