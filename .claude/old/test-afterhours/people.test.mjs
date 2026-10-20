/* afterhours — finding people: search by handle or name, and a few suggestions */

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
                 "../sql/03_seed_catalog.sql", "../sql/06_views.sql", "../sql/07_friends.sql",
                 "../sql/12_profiles.sql", "../sql/25_people.sql"]) {
  await db.exec(await read(d));
}
/* a second run must not trip over the first */
await db.exec(await read("../sql/25_people.sql"));

const A = "aaaaaaaa-1111-1111-1111-111111111111";   /* me */
const B = "bbbbbbbb-2222-2222-2222-222222222222";   /* my friend */
const C = "cccccccc-3333-3333-3333-333333333333";   /* B's friend: a friend of a friend */
const D = "dddddddd-4444-4444-4444-444444444444";   /* same city as me, nobody in common */
const E = "eeeeeeee-5555-5555-5555-555555555555";   /* hidden: discoverable off */
const F = "ffffffff-6666-6666-6666-666666666666";   /* asked me, not answered */
const G = "99999999-7777-7777-7777-777777777777";   /* no handle yet */

const asUser = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
await db.exec(`
  insert into auth.users (id, email) values
    ('${A}', 'a@x.com'), ('${B}', 'b@x.com'), ('${C}', 'c@x.com'), ('${D}', 'd@x.com'),
    ('${E}', 'e@x.com'), ('${F}', 'f@x.com'), ('${G}', 'g@x.com');
  update public.profiles set handle = 'ada',  display_name = 'owner'      where id = '${A}';
  update public.profiles set handle = 'berk',   display_name = 'Berk Aydın' where id = '${B}';
  update public.profiles set handle = 'cansu',  display_name = 'Cansu'      where id = '${C}';
  update public.profiles set handle = 'deniz',  display_name = 'Deniz Kaya' where id = '${D}';
  update public.profiles set handle = 'elif',   display_name = 'Elif'       where id = '${E}';
  update public.profiles set handle = 'feride', display_name = 'Feride'     where id = '${F}';
  update public.profiles set handle = null,     display_name = 'Gökhan'     where id = '${G}';
  update public.profiles set city_id = (select id from public.cities order by sort_order limit 1)
    where id in ('${A}', '${D}', '${E}');
  update public.profile_settings set discoverable = false where user_id = '${E}';
  insert into public.friendships (requester_id, addressee_id, status) values
    ('${A}', '${B}', 'accepted'),
    ('${B}', '${C}', 'accepted'),
    ('${F}', '${A}', 'pending');
`);

console.log("\n— search —");
{
  await asUser(A);
  const byHandle = await rows(`select handle, relation from public.people_search('ber')`);
  check(byHandle.length === 1 && byHandle[0].handle === "berk", "a handle is found from its start");
  check(byHandle[0].relation === "friend", "and says you are already friends");

  const byName = await rows(`select handle from public.people_search('kaya')`);
  check(byName.length === 1 && byName[0].handle === "deniz", "a name is found anywhere in it");

  const at = await rows(`select handle from public.people_search('@cansu')`);
  check(at.length === 1 && at[0].handle === "cansu", "a leading @ is ignored");
  const cansu = await rows(`select mutual, relation from public.people_search('cansu')`);
  check(cansu[0].mutual === 1 && cansu[0].relation === "none", "one friend in common, no link yet");

  const asked = await rows(`select relation from public.people_search('feride')`);
  check(asked[0].relation === "incoming", "someone who asked you shows as incoming");

  check((await rows(`select 1 from public.people_search('a')`)).length === 0, "one letter finds nobody");
  check((await rows(`select 1 from public.people_search('elif')`)).length === 0, "a hidden person is not found");
  check((await rows(`select 1 from public.people_search('ada')`)).length === 0, "you do not find yourself");
  check((await rows(`select 1 from public.people_search('gökhan')`)).length === 0, "someone without a handle is not found");
  check((await rows(`select 1 from public.people_search('%%')`)).length === 0, "% is a letter, not a wildcard");

  await asAnon();
  check(Boolean(await fails(`select * from public.people_search('berk')`)), "signed out, search is closed");
}

console.log("\n— suggestions —");
{
  await asUser(A);
  const s = await rows(`select handle, reason, mutual from public.people_suggested(3)`);
  check(s.length === 2, "two people qualify", JSON.stringify(s));
  check(s[0]?.handle === "cansu" && s[0]?.reason === "mutual" && s[0]?.mutual === 1, "a friend of a friend comes first");
  check(s[1]?.handle === "deniz" && s[1]?.reason === "city", "then the same city");
  check(!s.some((r) => ["berk", "feride", "elif", "ada"].includes(r.handle)),
        "no friends, no pending requests, no hidden people, not you");

  await asUser(D);
  const d = await rows(`select handle, reason from public.people_suggested(3)`);
  check(d.length === 3 && d[0].reason === "city" && d[0].handle === "ada", "for someone new: the city first, then the rest");

  await asAnon();
  check(Boolean(await fails(`select * from public.people_suggested(3)`)), "signed out, suggestions are closed");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
