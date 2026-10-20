/* afterhours — what is kept, and for how long (94) */

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
await db.exec(await read("../sql/94_retention.sql"));
const rows = async (sql) => (await db.query(sql)).rows;
const n = async (t) => (await rows(`select count(*)::int as n from public.${t}`))[0].n;
const [A, B] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222"];
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x')`);
await db.exec(`insert into public.push_outbox (user_id, kind, key, created_at, sent_at) values
  ('${A}', 'match', 'old-sent',  now() - interval '40 days', now() - interval '40 days'),
  ('${A}', 'match', 'new-sent',  now() - interval '2 days',  now() - interval '2 days'),
  ('${A}', 'match', 'old-stuck', now() - interval '10 days', null),
  ('${A}', 'match', 'new-stuck', now() - interval '1 hour',  null)`);
await db.exec(`insert into public.reports (reporter_id, kind, target, handled, created_at) values
  ('${A}', 'profile', 'x1', true,  now() - interval '400 days'),
  ('${A}', 'profile', 'x2', false, now() - interval '400 days'),
  ('${A}', 'profile', 'x3', true,  now() - interval '10 days')`);
await db.exec(`insert into public.notices (user_id, kind, data, created_at) values
  ('${B}', 'role', '{}', now() - interval '100 days'), ('${B}', 'role', '{}', now() - interval '1 day')`);

const gone = (await rows(`select public.retention_prune() as n`))[0].n;
const keys = (await rows(`select key from public.push_outbox order by key`)).map((r) => r.key);
check(JSON.stringify(keys) === JSON.stringify(["new-sent", "new-stuck"]), "old pushes go, sent or stuck", keys.join(","));
const left = (await rows(`select target from public.reports order by target`)).map((r) => r.target);
check(JSON.stringify(left) === JSON.stringify(["x2", "x3"]), "a settled report goes after a year; an open one never does", left.join(","));
check(await n("notices") === 1, "notices after ninety days");
check(gone === 4, "the count comes back", String(gone));
check((await rows(`select public.retention_prune() as n`))[0].n === 0, "a second pass finds nothing");
await db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${A}"}';`);
let refused = false;
try { await db.exec(`select public.retention_prune()`); } catch { refused = true; }
check(refused, "nobody signed in may run it");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
