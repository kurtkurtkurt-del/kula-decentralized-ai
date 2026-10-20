/* afterhours — a report keeps a copy (84) */

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
await db.exec(await read("../sql/84_report_snapshot.sql"));

const [A, B, CM] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222", "dddddddd-4444-4444-4444-444444444444"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const rows = async (sql) => (await db.query(sql)).rows;
const open = async () => { await as(CM); return rows(`select kind, target, preview, author, reports from public.staff_reports()`); };

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${CM}','cm@x')`);
await db.exec(`update public.profiles set handle = 'ada' where id = '${A}'`);
await db.exec(`update public.profiles set handle = 'berk' where id = '${B}'`);
await db.exec(`update public.profiles set account_type = 'community_manager' where id = '${CM}'`);
const night = (await rows(`select id from public.events where is_published limit 1`))[0];
const c = (await rows(`insert into public.comments (event_id, author_id, author_name, body) values ('${night.id}', '${B}', 'berk', 'you are nothing') returning id`))[0].id;

console.log("\n— the copy —");
{
  await as(A);
  await db.exec(`select public.report('comment', '${c}', 'insults')`);
  await asService();
  const snap = (await rows(`select snapshot from public.reports where target = '${c}'`))[0].snapshot;
  check(snap?.text === "you are nothing" && snap?.author === "berk" && snap?.author_id === B && !!snap?.at, "the report took the text, the author and the time", JSON.stringify(snap));
}

console.log("\n— the content goes —");
{
  await asService();
  await db.exec(`delete from public.comments where id = '${c}'`);
  const o = await open();
  check(o.length === 1 && o[0].preview === "you are nothing" && o[0].author === "berk", "the panel still shows what was said and by whom", JSON.stringify(o));
}

console.log("\n— the reporter goes —");
{
  await as(A);
  await db.exec(`select public.delete_account()`);
  await asService();
  const r = (await rows(`select reporter_id, handled from public.reports where target = '${c}'`))[0];
  check(r && r.reporter_id === null && r.handled === false, "the report stays, with no reporter");
  await as(CM);
  await db.exec(`select public.staff_report_settle('comment', '${c}', false)`);
  await asService();
  check((await rows(`select handled from public.reports where target = '${c}'`))[0].handled === true, "the staff can still settle it");
}

console.log("\n— the author goes —");
{
  await asService();
  const c2 = (await rows(`insert into public.comments (event_id, author_id, author_name, body) values ('${night.id}', '${B}', 'berk', 'again') returning id`))[0].id;
  await as(CM);
  await db.exec(`select public.report('comment', '${c2}', 'again')`);
  await as(B);
  await db.exec(`select public.delete_account()`);
  const o = (await open()).find((r) => r.target === c2);
  check(o && o.preview === "again" && o.author === "berk", "a deleted author's words and handle are still on file");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
