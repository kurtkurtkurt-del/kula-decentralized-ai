/* afterhours — account types: a code, and the code is the name (41) */

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
                 "../sql/12_profiles.sql", "../sql/41_account_types.sql"]) {
  await db.exec(await read(d));
}
await db.exec(await read("../sql/41_account_types.sql"));

const A = "aaaaaaaa-1111-1111-1111-111111111111";
const B = "bbbbbbbb-2222-2222-2222-222222222222";
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asUser = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const one = async (sql) => (await db.query(sql)).rows[0];
const type = async (id) => (await one(`select account_type from public.profiles where id = '${id}'`)).account_type;
const set = async (t, c) => (await one(`select public.set_account_type('${t}', '${c}') as r`)).r;

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}', 'a@x.com'), ('${B}', 'b@x.com')`);

console.log("\n— the code is the name —");
{
  check((await type(A)) === "user", "a new account is a normal user");
  await asUser(A);
  check((await set("dj", "admin")) === "code" && (await type(A)) === "user", "a wrong code changes nothing");
  check((await set("dj", " DJ ")) === "ok" && (await type(A)) === "dj", "dj with “dj” (case and spaces do not matter)");
  check((await set("community_manager", "community manager")) === "ok" && (await type(A)) === "community_manager", "community manager");
  check((await set("admin", "admin")) === "ok" && (await type(A)) === "admin", "admin");
  check((await set("user", "normal user")) === "ok" && (await type(A)) === "user", "and back to normal user");
  check((await set("boss", "boss")) === "type", "an unknown type is refused");
}

console.log("\n— no other way in —");
{
  await asUser(A);
  check(Boolean(await fails(`update public.profiles set account_type = 'admin' where id = '${A}'`)), "a plain update cannot change it");
  await set("admin", "admin");
  await asService();
  check((await one(`select is_admin from public.profiles where id = '${A}'`)).is_admin === false, "the admin type does not make anyone a real admin");
  check((await type(B)) === "user", "it only ever changes your own profile");
  await asAnon();
  check(Boolean(await fails(`select public.set_account_type('dj', 'dj')`)), "signed out: not allowed");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
