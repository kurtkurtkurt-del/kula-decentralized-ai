/* afterhours — posts are off (81): no post push leaves, the rest still does */

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
await db.exec(await read("../sql/81_posts_off.sql"));

const A = "aaaaaaaa-1111-1111-1111-111111111111";
const rows = async (sql) => (await db.query(sql)).rows;
await db.exec(`reset role; set request.jwt.claims = '';`);
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x')`);
await db.exec(`insert into public.profile_settings (user_id, notify_posts) values ('${A}', true) on conflict (user_id) do update set notify_posts = true`);

const wants = async (k) => (await rows(`select public.push_wants('${A}', '${k}') as w`))[0].w;
check(await wants("post_like") === false && await wants("post_comment") === false && await wants("post") === false, "no post push is wanted, even with the setting on");
check(await wants("match") === true && await wants("dm") === true && await wants("night_soon") === true, "every other kind still is");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
