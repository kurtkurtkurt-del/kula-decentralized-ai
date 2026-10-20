/* afterhours — health() says when the sync last brought a night and whether pushes are stuck (71) */

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
await db.exec(await read("../sql/71_health_more.sql"));
const rows = async (sql) => (await db.query(sql)).rows;

console.log("\n— the two new numbers —");
{
  const h0 = (await rows(`select * from public.health()`))[0];
  check(h0.newest_synced === null && Number(h0.outbox_stuck) === 0, "nothing synced yet, nothing stuck");
  const city = (await rows(`select id from public.cities limit 1`))[0].id;
  const type = (await rows(`select id from public.event_types limit 1`))[0].id;
  await db.exec(`insert into public.events (slug, city_id, type_id, title, meta, starts_at, source, external_id, created_at)
                 values ('tm-x', '${city}', '${type}', 'X', 'x', now() + interval '2 days', 'ticketmaster', 'x1', now() - interval '2 days')`);
  const A = "aaaaaaaa-1111-1111-1111-111111111111";
  await db.exec(`insert into auth.users (id, email) values ('${A}', 'a@x')`);
  await db.exec(`insert into public.push_outbox (user_id, kind, key, data, created_at) values ('${A}', 'friend_request', 'k1', '{}', now() - interval '7 hours')`);
  await db.exec(`update public.push_outbox set send_after = now() - interval '7 hours', sent_at = null where key = 'k1'`);
  const h = (await rows(`select * from public.health()`))[0];
  check(h.newest_synced !== null && Date.now() - new Date(h.newest_synced).getTime() > 1.9 * 86400000, "the newest synced night is dated");
  check(Number(h.outbox_stuck) === 1, "a push older than six hours still unsent counts as stuck");
  await db.exec(`set role anon; set request.jwt.claims = '';`);
  check((await rows(`select newest_synced from public.health()`)).length === 1, "signed out, the check still answers (health.yml has no secret)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
