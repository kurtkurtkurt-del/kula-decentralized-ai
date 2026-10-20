/* afterhours — what the chosen designs read (49) */

import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

const read = (y) => readFile(new URL(y, import.meta.url), "utf8");
let passed = 0, failed = 0;
const check = (k, name, extra = "") => {
  if (k) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
};
process.on("unhandledRejection", (e) => { console.log("\nERROR: " + ((e && e.message) || e)); if (e && e.where) console.log(e.where); process.exit(1); });

const db = new PGlite();
await db.exec(await read("../test/supabase-shim.sql"));
await db.exec(await read("../sql/setup-1-structure.sql"));

const [A, B, C] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222", "cccccccc-3333-3333-3333-333333333333"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const one = async (sql) => (await db.query(sql)).rows[0];
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${C}','c@x')`);
await db.exec(`insert into public.friendships (requester_id, addressee_id, status) values ('${A}', '${B}', 'accepted')`);
await db.exec(`update public.profiles set is_admin = true where id = '${A}'`);
await db.exec(`update public.profiles set account_type = 'dj' where id = '${B}'`);
const ev = (await rows(`select id from public.events where is_published order by slug limit 1`))[0].id;
await db.exec(`update public.events set starts_at = now() + interval '2 days' where id = '${ev}'`);

console.log("\n— the join screen —");
let g, code;
{
  await as(A);
  g = (await one(`select public.group_create('Cuma', '🪩', 'red', 'lasting', null, null, null, array['${B}']::uuid[]) as g`)).g;
  await db.exec(`select public.plan_set('${g}', '${ev}')`);
  code = (await one(`select public.group_invite('${g}') as c`)).c;
  await as(C);
  const p = await one(`select * from public.group_peek('${code}')`);
  check(p.names.join() === "a,b" && p.owner === "a" && p.plan_title, "who is in, who invites, the plan", JSON.stringify(p));
}

console.log("\n— the photo wall —");
{
  await asService();
  await db.exec(`insert into public.checkins (user_id, event_id) values ('${A}', '${ev}'), ('${B}', '${ev}')`);
  await as(B);
  await db.exec(`select public.group_photo_add('${g}', '${ev}', '${B}/w.jpg')`);
  const w = await rows(`select * from public.group_wall('${g}')`);
  check(w.length === 1 && w[0].event_id === ev && w[0].name === "b" && w[0].mine, "every photo with its night");
  await as(C);
  check(Boolean(await fails(`select * from public.group_wall('${g}')`)), "a stranger sees none");
}

console.log("\n— people by role —");
{
  await as(A);
  check((await rows(`select * from public.admin_people_by('', 'dj')`)).map((r) => r.handle ?? r.display_name).join() === "b", "dj filter");
  check((await rows(`select * from public.admin_people_by('', 'admin')`)).length === 1, "admin filter");
  check((await rows(`select * from public.admin_people_by('', 'new')`)).length === 3, "new this week");
  const b = (await rows(`select * from public.admin_people_by('b', '')`))[0];
  check(b.groups === 1 && typeof b.nights === "number", "with groups and nights");
  const c = (await one(`select public.admin_role_counts() as c`)).c;
  check(c.all === 3 && c.dj === 1 && c.admin === 1, "counts for the chips", JSON.stringify(c));
  await as(B);
  check(Boolean(await fails(`select * from public.admin_people_by('', '')`)), "admins only");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
