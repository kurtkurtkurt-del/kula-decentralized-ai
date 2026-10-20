/* afterhours — the file on a person, and who may open a closed account (86) */

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
await db.exec(await read("../sql/86_person_file.sql"));

const [AD, CM, X, Y, Z] = ["aaaaaaaa-1111-1111-1111-111111111111", "dddddddd-4444-4444-4444-444444444444",
                           "bbbbbbbb-2222-2222-2222-222222222222", "cccccccc-3333-3333-3333-333333333333", "eeeeeeee-5555-5555-5555-555555555555"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const rows = async (sql) => (await db.query(sql)).rows;
const banned = async (id) => (await rows(`select public.is_banned('${id}') as b`))[0].b;

await asService();
await db.exec(`insert into auth.users (id, email) values ('${AD}','ad@x'),('${CM}','cm@x'),('${X}','x@x'),('${Y}','y@x'),('${Z}','z@x')`);
await db.exec(`update public.profiles set handle = 'admin_ada', is_admin = true where id = '${AD}'`);
await db.exec(`update public.profiles set handle = 'cm_lena', account_type = 'community_manager' where id = '${CM}'`);
await db.exec(`update public.profiles set handle = 'xavi' where id = '${X}'`);
await db.exec(`update public.profiles set handle = 'yara' where id = '${Y}'`);
await db.exec(`update public.profiles set handle = 'zed' where id = '${Z}'`);
const night = (await rows(`select id from public.events where is_published limit 1`))[0];
const c = (await rows(`insert into public.comments (event_id, author_id, author_name, body) values ('${night.id}', '${X}', 'xavi', 'go away') returning id`))[0].id;

console.log("\n— the tier —");
{
  await as(AD);
  await db.exec(`select public.staff_ban('${X}', 'threats')`);
  await as(CM);
  await db.exec(`select public.staff_ban('${Y}', 'spam')`);
  check(Boolean(await fails(`select public.staff_unban('${X}')`)), "a manager cannot open what an admin closed");
  check(await banned(X) === true, "xavi stays closed");
  await db.exec(`select public.staff_unban('${Y}')`);
  check(await banned(Y) === false, "a manager opens what a manager closed");
  await as(AD);
  await db.exec(`select public.staff_unban('${X}')`);
  check(await banned(X) === false, "the admin opens it");
}

console.log("\n— through an objection —");
{
  await as(AD);
  await db.exec(`select public.staff_ban('${X}', 'threats again')`);
  await as(X);
  await db.exec(`select public.appeal('it was a joke between friends, really, ask them')`);
  await as(CM);
  const id = (await rows(`select id from public.staff_appeals()`))[0].id;
  check(Boolean(await fails(`select public.staff_appeal_settle(${id}, true)`)), "a manager cannot lift it by answering the objection either");
  await db.exec(`select public.staff_appeal_settle(${id}, false)`);
  check(await banned(X) === true, "but can answer no");
}

console.log("\n— the file —");
{
  await as(Z);
  await db.exec(`select public.report('comment', '${c}', 'rude')`);
  check(Boolean(await fails(`select public.staff_person('${X}')`)), "not for everyone");
  await as(CM);
  const f = (await rows(`select public.staff_person('${X}') as f`))[0].f;
  check(f.who.handle === "xavi" && f.who.banned_reason === "threats again" && f.who.banned_by === "admin_ada" && f.who.banned_by_admin === true, "who, and who closed them", JSON.stringify(f.who));
  check(f.reports_about.length === 1 && f.reports_about[0].text === "go away" && f.reports_about[0].reason === "rude", "what they were reported for, with the copy", JSON.stringify(f.reports_about));
  check(f.appeals.length === 1 && f.appeals[0].outcome === "keep", "their objection and its answer");
  const actions = f.log.map((l) => l.action);
  check(actions.includes("ban") && actions.includes("unban") && actions.includes("appeal-keep") && f.log[0].by, "the staff log on them, with names", actions.join(","));
  const z = (await rows(`select public.staff_person('${Z}') as f`))[0].f;
  check(z.reports_made.length === 1 && z.reports_about.length === 0, "and what a person reported themselves");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
