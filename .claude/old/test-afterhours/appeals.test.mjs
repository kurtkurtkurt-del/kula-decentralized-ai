/* afterhours — a closed account may object (85) */

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
await db.exec(await read("../sql/85_appeals.sql"));

const [A, B, C, CM] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222",
                       "cccccccc-3333-3333-3333-333333333333", "dddddddd-4444-4444-4444-444444444444"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const rows = async (sql) => (await db.query(sql)).rows;
const long = "i never wrote that, somebody used my phone that night";

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${C}','c@x'),('${CM}','cm@x')`);
await db.exec(`update public.profiles set handle = 'berk' where id = '${B}'`);
await db.exec(`update public.profiles set handle = 'cansu' where id = '${C}'`);
await db.exec(`update public.profiles set account_type = 'community_manager' where id = '${CM}'`);
await as(CM);
await db.exec(`select public.staff_ban('${B}', 'insults')`);
await db.exec(`select public.staff_ban('${C}', 'spam')`);

console.log("\n— writing —");
{
  await as(A);
  check(Boolean(await fails(`select public.appeal('${long}')`)), "an open account has nothing to object to");
  await as(B);
  check(Boolean(await fails(`select public.appeal('no')`)), "too short is refused");
  await db.exec(`select public.appeal('${long}')`);
  check(Boolean(await fails(`select public.appeal('${long} again')`)), "one at a time");
  const mine = (await rows(`select * from public.my_appeal()`))[0];
  check(mine && mine.outcome === null && mine.settled_at === null, "the closed screen sees it as sent");
  await as(C);
  await db.exec(`select public.appeal('${long}')`);
}

console.log("\n— the staff —");
{
  await as(A);
  check(Boolean(await fails(`select * from public.staff_appeals()`)), "not for everyone");
  await as(CM);
  const l = await rows(`select * from public.staff_appeals()`);
  check(l.length === 2 && l[0].handle === "berk" && l[0].reason === "insults" && l[0].body === long, "the staff see both, oldest first, with the ban reason", JSON.stringify(l[0]));
  await db.exec(`select public.staff_appeal_settle(${l[0].id}, true)`);
  await db.exec(`select public.staff_appeal_settle(${l[1].id}, false)`);
  check((await rows(`select * from public.staff_appeals()`)).length === 0, "both settled");
  check(Boolean(await fails(`select public.staff_appeal_settle(${l[0].id}, true)`)), "a settled one cannot be settled again");
}

console.log("\n— the answer —");
{
  await as(B);
  check((await rows(`select public.is_banned() as b`))[0].b === false, "berk is open again");
  check((await rows(`select kind from public.my_notices()`)).some((n) => n.kind === "appeal_ok"), "and hears so");
  await as(C);
  check((await rows(`select public.is_banned() as b`))[0].b === true, "cansu stays closed");
  const mine = (await rows(`select * from public.my_appeal()`))[0];
  check(mine.outcome === "keep" && mine.settled_at !== null, "and the closed screen says so");
  check((await rows(`select kind from public.my_notices()`)).some((n) => n.kind === "appeal_no"), "with a notice too");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
