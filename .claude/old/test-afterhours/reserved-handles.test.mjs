/* afterhours — some names are nobody's (77) */

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
await db.exec(await read("../sql/77_reserved_handles.sql"));

const [A, CM, W] = ["aaaaaaaa-1111-1111-1111-111111111111", "cccccccc-3333-3333-3333-333333333333", "dddddddd-4444-4444-4444-444444444444"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const rows = async (sql) => (await db.query(sql)).rows;
const status = async (h) => (await rows(`select public.handle_status('${h}') as s`))[0].s;

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${CM}','cm@x')`);
await db.exec(`update public.profiles set account_type = 'community_manager' where id = '${CM}'`);

console.log("\n— asking —");
{
  await as(A);
  check(await status("admin") === "taken" && await status("support") === "taken" && await status("afterhours_team") === "taken" && await status("admin_1") === "taken", "the reserved names and their family read as taken");
  check(await status("ada") === "ok", "an ordinary name is free");
  check((await rows(`select public.profile_setup('support', 'x', null, null) as r`))[0].r === "taken", "and cannot be set up");
  await as(CM);
  check(await status("support") === "ok", "the staff may use them");
}

console.log("\n— at sign-up —");
{
  await asService();
  await db.exec(`insert into auth.users (id, email, raw_user_meta_data) values ('${W}', 'w@x', '{"handle":"afterhours"}')`);
  check((await rows(`select handle from public.profiles where id = '${W}'`))[0].handle === null, "a reserved wish at sign-up is dropped, the handle step asks again");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
