/* afterhours — a night sent in: the sender hears, can take it back, stale ones leave the queue (76) */

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
await db.exec(await read("../sql/76_sent_nights.sql"));

const [A, B, CM] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222", "cccccccc-3333-3333-3333-333333333333"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${CM}','cm@x')`);
await db.exec(`update public.profiles set handle = 'ada' where id = '${A}'`);
await db.exec(`update public.profiles set handle = 'berk' where id = '${B}'`);
await db.exec(`update public.profiles set account_type = 'community_manager' where id = '${CM}'`);
const city = (await rows(`select id from public.cities limit 1`))[0].id;
const type = (await rows(`select id from public.event_types limit 1`))[0].id;
const sent = async (slug, days) => (await rows(`insert into public.events (slug, city_id, type_id, title, meta, starts_at, source, created_by, review, is_published)
  values ('${slug}', '${city}', '${type}', '${slug}', 'x', now() + interval '${days} days', 'user', '${A}', 'pending', false) returning id`))[0].id;
const good = await sent('good-night', 10), bad = await sent('bad-night', 11), mine = await sent('my-night', 12), stale = await sent('stale-night', -2);

console.log("\n— the staff decide, the sender hears —");
{
  await as(CM);
  const queue = (await rows(`select slug from public.staff_pending()`)).map((r) => r.slug);
  check(!queue.includes("stale-night") && queue.length === 3, "opening the queue clears the one whose date passed", JSON.stringify(queue));
  await db.exec(`select public.staff_review('${good}', true, null)`);
  await db.exec(`select public.staff_review('${bad}', false, 'no ticket link')`);
  await as(A);
  const n = await rows(`select kind, data from public.my_notices() order by id`);
  check(n.some((x) => x.kind === "night_ok" && x.data.title === "good-night"), "let through: the sender is told", JSON.stringify(n));
  check(n.some((x) => x.kind === "night_no" && x.data.title === "bad-night" && x.data.note === "no ticket link"), "turned down: with the note");
  check(n.some((x) => x.kind === "night_no" && x.data.title === "stale-night" && x.data.note === "the date passed"), "expired: told that too");
  await asService();
  check((await rows(`select review, review_note from public.events where id = '${stale}'`))[0].review_note === "the date passed", "the stale one is marked, not deleted");
}

console.log("\n— the sender takes one back —");
{
  await as(B);
  check(Boolean(await fails(`select public.event_withdraw('${mine}')`)), "not someone else's");
  await as(A);
  await db.exec(`select public.event_withdraw('${mine}')`);
  await asService();
  check((await rows(`select 1 from public.events where id = '${mine}'`)).length === 0, "a waiting night of yours can be taken back");
  await as(A);
  check(Boolean(await fails(`select public.event_withdraw('${good}')`)), "once it is through, it is a night, not yours to take back");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
