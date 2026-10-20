/* afterhours — sparks on the map: a spot, who sees it, how sharp */

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
                 "../sql/12_profiles.sql", "../sql/27_sparks.sql", "../sql/28_spark_waves.sql",
                 "../sql/30_spark_map.sql"]) {
  await db.exec(await read(d));
}
await db.exec(await read("../sql/30_spark_map.sql"));

/* A — B — C — D (a chain of friends), E outside */
const A = "aaaaaaaa-1111-1111-1111-111111111111";
const B = "bbbbbbbb-2222-2222-2222-222222222222";
const C = "cccccccc-3333-3333-3333-333333333333";
const D = "dddddddd-4444-4444-4444-444444444444";
const E = "eeeeeeee-5555-5555-5555-555555555555";

const asUser = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
await db.exec(`
  insert into auth.users (id, email) values ('${A}', 'a@x.com'), ('${B}', 'b@x.com'), ('${C}', 'c@x.com'), ('${D}', 'd@x.com'), ('${E}', 'e@x.com');
  update public.profiles set handle = 'ada' where id = '${A}';
  insert into public.friendships (requester_id, addressee_id, status) values
    ('${A}', '${B}', 'accepted'), ('${B}', '${C}', 'accepted'), ('${C}', '${D}', 'accepted');
`);

/* Munich, Gärtnerplatz */
const LAT = 48.13149, LNG = 11.57531;
let wide, near;
console.log("\n— a spot —");
{
  await asUser(A);
  wide = (await rows(`select public.spark_create('grill', 'grill', now() + interval '1 day', 'river', 2, ${LAT}, ${LNG}) as id`))[0].id;
  near = (await rows(`select public.spark_create('derby', 'derby', now() + interval '1 day', 'at mine', 1, ${LAT}, ${LNG}) as id`))[0].id;
  await asService();
  const s = (await rows(`select lat, lng from public.sparks where id = '${wide}'`))[0];
  check(s.lat === LAT && s.lng === LNG, "the spot is stored with the spark");
  await asUser(A);
  const old = (await rows(`select public.spark_create('hike', 'no spot', now() + interval '1 day', null, 1) as id`))[0].id;
  check(Boolean(old), "creating without a spot still works (older app builds)");
  check(Boolean(await fails(`select public.spark_create('hike', 'x', now() + interval '1 day', null, 1, 95, 11)`)), "a spot off the globe is refused");
}

console.log("\n— the map —");
{
  await asUser(A);
  const a = await rows(`select id, mine, lat from public.sparks_near(${LAT}, ${LNG}, 3)`);
  check(a.length === 2 && a.every((r) => r.mine && r.lat === LAT), "the host sees their own, sharp", JSON.stringify(a));

  await asUser(B);
  const b = await rows(`select id, lat, lng, wave from public.sparks_near(${LAT}, ${LNG}, 3)`);
  check(b.length === 2 && b.every((r) => r.lat === LAT && r.lng === LNG && r.wave === 1), "a friend sees both, sharp");

  await asUser(C);
  const c = await rows(`select id, lat, lng from public.sparks_near(48.13, 11.58, 3)`);
  check(c.length === 1 && c[0].id === wide, "a friend of a friend sees only the 2nd-wave one");
  check(c[0]?.lat === 48.13 && c[0]?.lng === 11.58, "and its spot is blurred to about a kilometre", JSON.stringify(c));

  await asUser(D);
  check((await rows(`select 1 from public.sparks_near(${LAT}, ${LNG}, 3)`)).length === 0, "outside the wave, nothing");
  await asUser(B);
  check((await rows(`select 1 from public.sparks_near(48.2, 11.7, 3)`)).length === 0, "too far away, nothing");
  check((await rows(`select 1 from public.sparks_near(48.2, 11.7, 30)`)).length === 2, "a wider circle finds them");
}

console.log("\n— one spark —");
{
  await asUser(B);
  await db.exec(`select public.spark_answer('${near}', 'in')`);
  const g = (await rows(`select my_answer, going, mine from public.spark_get('${near}')`))[0];
  check(g.my_answer === "in" && g.going === 1 && g.mine === false, "after answering, the page still opens, with your answer");
  await asUser(E);
  check((await rows(`select 1 from public.spark_get('${near}')`)).length === 0, "a stranger cannot open it");
  check(Boolean(await fails(`select * from public.spark_rows()`)), "the inner list cannot be called from the app");
  await asAnon();
  check(Boolean(await fails(`select * from public.sparks_near(${LAT}, ${LNG}, 3)`)), "signed out, closed");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
