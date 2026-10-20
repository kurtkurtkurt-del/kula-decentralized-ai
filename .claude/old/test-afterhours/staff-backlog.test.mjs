/* afterhours — what the staff have left waiting (93) */

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
await db.exec(await read("../sql/93_staff_backlog.sql"));
const rows = async (sql) => (await db.query(sql)).rows;
const [A, B] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222"];
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x')`);
const night = (await rows(`select id from public.events where is_published limit 1`))[0].id;
const c = (await rows(`insert into public.comments (event_id, author_id, author_name, body) values ('${night}', '${B}', 'b', 'rude') returning id`))[0].id;
await db.exec(`insert into public.reports (reporter_id, kind, target, reason, created_at) values ('${A}', 'comment', '${c}', 'x', now() - interval '2 hours')`);

await db.exec(`set role anon; set request.jwt.claims = '';`);
let b = (await rows(`select * from public.staff_backlog()`))[0];
check(b.reports_waiting === 0 && b.oldest_report !== null, "a fresh report is not a backlog, but the oldest is named");
await db.exec(`reset role;`);
await db.exec(`update public.reports set created_at = now() - interval '30 hours'`);
await db.exec(`set role anon;`);
b = (await rows(`select * from public.staff_backlog()`))[0];
check(b.reports_waiting === 1, "after a day it is");
await db.exec(`reset role;`);
await db.exec(`update public.reports set handled = true`);
await db.exec(`set role anon;`);
b = (await rows(`select * from public.staff_backlog()`))[0];
check(b.reports_waiting === 0 && b.oldest_report === null, "settled, it is gone");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
