/* afterhours — the person who reported hears the outcome (68) */

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
await db.exec(await read("../sql/68_report_answered.sql"));

const [A, B, CM] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222", "cccccccc-3333-3333-3333-333333333333"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${CM}','cm@x')`);
await db.exec(`update public.profiles set handle = 'ada' where id = '${A}'`);
await db.exec(`update public.profiles set handle = 'berk' where id = '${B}'`);
await db.exec(`update public.profiles set account_type = 'community_manager' where id = '${CM}'`);
const night = (await rows(`select id from public.events limit 1`))[0].id;
const c1 = (await rows(`insert into public.comments (event_id, author_id, author_name, body) values ('${night}', '${B}', 'berk', 'rude words') returning id`))[0].id;
const c2 = (await rows(`insert into public.comments (event_id, author_id, author_name, body) values ('${night}', '${B}', 'berk', 'fine words') returning id`))[0].id;
await db.exec(`insert into public.reports (reporter_id, kind, target, reason) values ('${A}', 'comment', '${c1}', 'insults'), ('${A}', 'comment', '${c2}', 'not sure')`);

console.log("\n— the staff settle, the reporter hears —");
{
  await as(CM);
  await db.exec(`select public.staff_report_settle('comment', '${c1}', true)`);
  await db.exec(`select public.staff_report_settle('comment', '${c2}', false)`);
  await as(A);
  const mine = await rows(`select kind, data from public.my_notices() order by id`);
  check(mine.some((n) => n.kind === "report_removed" && n.data.what === "comment"), "removed: the reporter is told, and what kind of thing it was", JSON.stringify(mine));
  check(mine.some((n) => n.kind === "report_kept" && n.data.what === "comment"), "kept: the reporter is told that too");
  check(!JSON.stringify(mine).includes("berk") && !JSON.stringify(mine).includes("rude"), "and nothing about who or what was written");
  await as(B);
  const theirs = await rows(`select kind from public.my_notices()`);
  check(theirs.some((n) => n.kind === "comment_hidden") && !theirs.some((n) => n.kind.startsWith("report_")), "the one reported keeps their own notice, not the reporter's");
  await as(CM);
  await db.exec(`select public.staff_report_settle('comment', '${c1}', true)`);
  await as(A);
  check((await rows(`select 1 from public.my_notices() where kind = 'report_removed'`)).length === 1, "settling again does not say it twice");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
