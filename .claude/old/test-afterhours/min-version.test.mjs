/* afterhours — the oldest app that still works (78) */

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
await db.exec(await read("../sql/78_min_version.sql"));

const [A, B] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const rows = async (sql) => (await db.query(sql)).rows;
const floor = async () => (await rows(`select public.min_app_version() as v`))[0].v;

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x')`);
await db.exec(`update public.profiles set is_admin = true where id = '${A}'`);

console.log("\n— reading —");
{
  await asAnon();
  check(await floor() === "0.1.0", "signed out, the floor reads 0.1.0 to begin with");
  check(Boolean(await fails(`select * from public.app_floor`)), "but the table itself is closed");
  check((await rows(`select public.version_lt('1.2.0','1.10.0') as k, public.version_lt('1.10.0','1.2.0') as n, public.version_lt('1.2.0','1.2.0') as e`))[0].k === true
     && (await rows(`select public.version_lt('1.10.0','1.2.0') as n`))[0].n === false
     && (await rows(`select public.version_lt('1.2.0','1.2.0') as e`))[0].e === false, "versions compare by number, not by letter");
}

console.log("\n— raising it —");
{
  await as(B);
  check(Boolean(await fails(`select public.set_min_app_version('0.2.0')`)), "an ordinary person cannot raise it");
  await as(A);
  check(Boolean(await fails(`select public.set_min_app_version('two')`)), "a version that is not 1.2.3 is refused");
  await db.exec(`select public.set_min_app_version('0.2.0', 'deck() changed shape')`);
  await asAnon();
  check(await floor() === "0.2.0", "the admin raises it and everyone reads the new floor");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
