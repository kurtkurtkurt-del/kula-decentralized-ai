/* afterhours — the photograph: yours to set, your confirmed friends' to see */

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
                 "../sql/03_seed_catalog.sql", "../sql/04_seed_events.sql",
                 "../sql/06_views.sql", "../sql/07_friends.sql",
                 "../sql/12_profiles.sql", "../sql/24_photos.sql"]) {
  await db.exec(await read(d));
}
/* a second run must not trip over the first */
await db.exec(await read("../sql/24_photos.sql"));

const A = "aaaaaaaa-1111-1111-1111-111111111111";   /* has the photograph */
const B = "bbbbbbbb-2222-2222-2222-222222222222";   /* confirmed friend */
const C = "cccccccc-3333-3333-3333-333333333333";   /* asked, not answered */
const D = "dddddddd-4444-4444-4444-444444444444";   /* a stranger */

const asUser = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asGuest = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}","is_anonymous":true}';`);
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
await db.exec(`
  insert into auth.users (id, email) values
    ('${A}', 'a@x.com'), ('${B}', 'b@x.com'), ('${C}', 'c@x.com'), ('${D}', 'd@x.com');
  insert into public.friendships (requester_id, addressee_id, status) values
    ('${A}', '${B}', 'accepted'),
    ('${C}', '${A}', 'pending');
`);

console.log("\n— setting it —");
{
  await asUser(A);
  const first = await rows(`select public.photo_set('${A}/1700000000000.jpg') as was`);
  check(first[0].was === null, "the first photograph replaces nothing");

  const second = await rows(`select public.photo_set('${A}/1700000000001.jpg') as was`);
  check(second[0].was === `${A}/1700000000000.jpg`, "a new one hands back the old path, to be removed");

  const mine = await rows(`select path from public.profile_photos`);
  check(mine.length === 1 && mine[0].path === `${A}/1700000000001.jpg`, "one row, the newest path");

  check(Boolean(await fails(`select public.photo_set('${B}/1700000000002.jpg')`)),
        "a path in somebody else's folder is refused");
  check(Boolean(await fails(`select public.photo_set('${A}/../x.jpg')`)),
        "a path of another shape is refused");
  check(Boolean(await fails(`insert into public.profile_photos (user_id, path) values ('${A}', '${A}/1.jpg')`)),
        "no writing around the function");
  check(Boolean(await fails(`update public.profile_photos set path = '${A}/2.jpg'`)),
        "no updating around it either");

  await asGuest(D);
  check(Boolean(await fails(`select public.photo_set('${D}/1700000000003.jpg')`)),
        "a guest has no photograph");

  await asAnon();
  check(Boolean(await fails(`select public.photo_set('${D}/1700000000003.jpg')`)),
        "signed out, neither");
}

console.log("\n— seeing it —");
{
  await asUser(B);
  const friend = await rows(`select user_id, path from public.profile_photos`);
  check(friend.length === 1 && friend[0].user_id === A, "a confirmed friend sees it");

  await asUser(C);
  check((await rows(`select 1 from public.profile_photos`)).length === 0,
        "a pending request does not");

  await asUser(D);
  check((await rows(`select 1 from public.profile_photos`)).length === 0,
        "a stranger does not");

  await asAnon();
  check(Boolean(await fails(`select 1 from public.profile_photos`)),
        "signed out, the table is closed");
}

console.log("\n— taking it away —");
{
  await asUser(A);
  const gone = await rows(`select public.photo_set(null) as was`);
  check(gone[0].was === `${A}/1700000000001.jpg`, "removing hands back the path");
  check((await rows(`select 1 from public.profile_photos`)).length === 0, "and the row is gone");

  await db.exec(`select public.photo_set('${A}/1700000000004.jpg')`);
  await db.exec(`select public.delete_account()`);
  await asService();
  check((await rows(`select 1 from public.profile_photos where user_id = '${A}'`)).length === 0,
        "deleting the account takes the row with it");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
