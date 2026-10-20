/* afterhours — sparks reach a wave: friends, friends of friends, one step further */

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
                 "../sql/03_seed_catalog.sql", "../sql/06_views.sql", "../sql/07_friends.sql",
                 "../sql/12_profiles.sql", "../sql/27_sparks.sql", "../sql/28_spark_waves.sql"]) {
  await db.exec(await read(d));
}
/* a second run must not trip over the first, and 27 again must not undo 28 */
await db.exec(await read("../sql/28_spark_waves.sql"));

/* a chain: A — B — C — D — E, plus F who only asked A (pending), and G alone */
const A = "aaaaaaaa-1111-1111-1111-111111111111";
const B = "bbbbbbbb-2222-2222-2222-222222222222";
const C = "cccccccc-3333-3333-3333-333333333333";
const D = "dddddddd-4444-4444-4444-444444444444";
const E = "eeeeeeee-5555-5555-5555-555555555555";
const F = "ffffffff-6666-6666-6666-666666666666";
const G = "99999999-7777-7777-7777-777777777777";

const asUser = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const rows = async (sql) => (await db.query(sql)).rows;
const inbox = async (who) => { await asUser(who); return rows(`select id, wave, host_handle from public.spark_inbox()`); };

await asService();
await db.exec(`
  insert into auth.users (id, email) values
    ('${A}', 'a@x.com'), ('${B}', 'b@x.com'), ('${C}', 'c@x.com'), ('${D}', 'd@x.com'),
    ('${E}', 'e@x.com'), ('${F}', 'f@x.com'), ('${G}', 'g@x.com');
  update public.profiles set handle = 'ada' where id = '${A}';
  insert into public.friendships (requester_id, addressee_id, status) values
    ('${A}', '${B}', 'accepted'),
    ('${C}', '${B}', 'accepted'),
    ('${C}', '${D}', 'accepted'),
    ('${D}', '${E}', 'accepted'),
    ('${F}', '${A}', 'pending');
`);

console.log("\n— audience —");
{
  await asUser(A);
  const a = (await rows(`select * from public.spark_audience()`))[0];
  check(a.wave1 === 1 && a.wave2 === 2 && a.wave3 === 3, "the waves count 1 · 2 · 3 people (counted up)", JSON.stringify(a));
  await asUser(G);
  const g = (await rows(`select * from public.spark_audience()`))[0];
  check(g.wave1 === 0 && g.wave3 === 0, "someone without friends reaches nobody");
  await asAnon();
  check(Boolean(await fails(`select * from public.spark_audience()`)), "signed out, closed");
  await asUser(A);
  check(Boolean(await fails(`select * from public.spark_waves('${A}')`)), "the walk itself cannot be called from the app");
}

let s1, s2, s3;
console.log("\n— create for a wave —");
{
  await asUser(A);
  s1 = (await rows(`select public.spark_create('derby', 'derby', now() + interval '1 day', 'at mine', 1) as id`))[0].id;
  s2 = (await rows(`select public.spark_create('grill', 'grill', now() + interval '1 day', 'river', 2) as id`))[0].id;
  s3 = (await rows(`select public.spark_create('hike', 'hike', now() + interval '1 day', null, 3) as id`))[0].id;
  check(Boolean(s1 && s2 && s3), "one press creates a spark for each wave");
  check(Boolean(await fails(`select public.spark_create('hike', 'x', now() + interval '1 day', null, 4)`)), "there is no 4th wave");
  await asUser(G);
  check(Boolean((await rows(`select public.spark_create('hike', 'alone', now() + interval '1 day', null, 1) as id`))[0].id),
        "it is created even when the wave is empty yet");
}

console.log("\n— who sees what —");
{
  const b = await inbox(B), c = await inbox(C), d = await inbox(D), e = await inbox(E), f = await inbox(F), g = await inbox(G);
  check(b.length === 3 && b.every((r) => r.wave === 1), "a friend sees all three, as 1st wave", JSON.stringify(b));
  check(c.length === 2 && !c.some((r) => r.id === s1) && c.every((r) => r.wave === 2), "a friend of a friend sees the 2nd and 3rd wave ones", JSON.stringify(c));
  check(d.length === 1 && d[0].id === s3 && d[0].wave === 3, "three steps away sees only the 3rd wave one");
  check(e.length === 0, "four steps away sees nothing");
  check(f.length === 0, "a pending request is not a friendship");
  check(!g.some((r) => [s1, s2, s3].includes(r.id)), "someone outside sees none of them");
  await asUser(A);
  check((await rows(`select 1 from public.spark_inbox()`)).length === 0, "the host does not get their own spark");
}

console.log("\n— answers —");
{
  await asUser(C);
  await db.exec(`select public.spark_answer('${s2}', 'in')`);
  check(!(await inbox(C)).some((r) => r.id === s2), "after answering it leaves the panel");
  await asUser(C);
  check(Boolean(await fails(`select public.spark_answer('${s1}', 'in')`)), "outside the wave you cannot answer");
  await asUser(D);
  await db.exec(`select public.spark_answer('${s3}', 'out')`);
  await asUser(B);
  const g2 = (await rows(`select going from public.spark_inbox() where id = '${s2}'`))[0];
  check(g2.going === 1, "others see how many are in");
  await asUser(C);
  await db.exec(`select public.spark_answer('${s2}', 'waiting')`);
  check((await inbox(C)).some((r) => r.id === s2), "undo puts it back");

  await asUser(A);
  const m = await rows(`select reach, going, not_going from public.spark_mine() order by reach`);
  check(m.length === 3 && m[0].reach === 1 && m[2].not_going === 1, "the host sees each wave and its answers", JSON.stringify(m));
}

console.log("\n— 27 still works —");
{
  await asUser(A);
  const old = (await rows(`select public.spark_create('derby', 'by name', now() + interval '1 day', null, array['${B}']::uuid[]) as id`))[0].id;
  const b = await inbox(B);
  check(b.some((r) => r.id === old && r.wave === 1), "a spark ticked by name still reaches that friend");
  check(!(await inbox(C)).some((r) => r.id === old), "and nobody else");
  await asUser(B);
  await db.exec(`select public.spark_answer('${old}', 'in')`);
  check(!(await inbox(B)).some((r) => r.id === old), "and can still be answered");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
