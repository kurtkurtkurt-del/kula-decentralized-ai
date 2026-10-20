/* afterhours — sparks: start a night, invite friends, they answer */

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
                 "../sql/12_profiles.sql", "../sql/27_sparks.sql", "../sql/39_spark_kinds.sql", "../sql/56_spark_kinds_2.sql"]) {
  await db.exec(await read(d));
}
/* a second run must not trip over the first */
await db.exec(await read("../sql/27_sparks.sql"));

const A = "aaaaaaaa-1111-1111-1111-111111111111";   /* host */
const B = "bbbbbbbb-2222-2222-2222-222222222222";   /* friend */
const C = "cccccccc-3333-3333-3333-333333333333";   /* friend */
const D = "dddddddd-4444-4444-4444-444444444444";   /* stranger */
const F = "ffffffff-6666-6666-6666-666666666666";   /* asked A, not answered */

const asUser = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
await db.exec(`
  insert into auth.users (id, email) values
    ('${A}', 'a@x.com'), ('${B}', 'b@x.com'), ('${C}', 'c@x.com'), ('${D}', 'd@x.com'), ('${F}', 'f@x.com');
  update public.profiles set handle = 'ada', display_name = 'owner' where id = '${A}';
  update public.profiles set handle = 'berk',  display_name = 'Berk'  where id = '${B}';
  update public.profiles set handle = 'cansu', display_name = 'Cansu' where id = '${C}';
  update public.profiles set handle = 'deniz', display_name = 'Deniz' where id = '${D}';
  update public.profiles set handle = 'feride', display_name = 'Feride' where id = '${F}';
  insert into public.friendships (requester_id, addressee_id, status) values
    ('${A}', '${B}', 'accepted'),
    ('${C}', '${A}', 'accepted'),
    ('${F}', '${A}', 'pending');
`);

let id;
console.log("\n— create —");
{
  await asUser(A);
  const r = await rows(`select public.spark_create('derby', ' derby night ', now() + interval '2 days', 'at mine',
                          array['${B}', '${C}', '${D}', '${F}', '${A}', '${B}']::uuid[]) as id`);
  id = r[0].id;
  check(Boolean(id), "a spark is created");

  await asService();
  const inv = await rows(`select user_id from public.spark_invites where spark_id = '${id}' order by user_id`);
  check(inv.length === 2 && inv[0].user_id === B && inv[1].user_id === C,
        "only confirmed friends are invited, once each (no stranger, no pending, not yourself)", JSON.stringify(inv));
  const s = await rows(`select title, host_id from public.sparks where id = '${id}'`);
  check(s[0].title === "derby night" && s[0].host_id === A, "the title is trimmed and you are the host");

  await asUser(A);
  check(Boolean(await fails(`select public.spark_create('derby', 'x', now() + interval '1 day', null, array['${D}']::uuid[])`)),
        "inviting only strangers is refused");
  check(Boolean(await fails(`select public.spark_create('derby', 'x', now() - interval '3 hours', null, array['${B}']::uuid[])`)),
        "a time in the past is refused");
  check(Boolean(await fails(`select public.spark_create('zumba', 'x', now() + interval '1 day', null, array['${B}']::uuid[])`)),
        "an unknown kind is refused");
  check(!(await fails(`select public.spark_create('sunrise', 'meet the sunrise', now() + interval '1 day', null, array['${B}']::uuid[])`)),
        "a kind added in 39 (sunrise) is taken");
  await asService();
  await db.exec(`delete from public.sparks where kind = 'sunrise'`);
  await asUser(A);
  check(Boolean(await fails(`select public.spark_create('grill', '   ', now() + interval '1 day', null, array['${B}']::uuid[])`)),
        "an empty title is refused");

  await asAnon();
  check(Boolean(await fails(`select public.spark_create('grill', 'x', now() + interval '1 day', null, array['${B}']::uuid[])`)),
        "signed out, nothing can be created");
}

console.log("\n— the tables are closed —");
{
  await asUser(B);
  check(Boolean(await fails(`select * from public.sparks`)), "sparks cannot be read directly");
  check(Boolean(await fails(`select * from public.spark_invites`)), "invites cannot be read directly");
  check(Boolean(await fails(`update public.spark_invites set answer = 'in'`)), "invites cannot be written directly");
}

console.log("\n— inbox and answers —");
{
  await asUser(B);
  const box = await rows(`select id, kind, title, place, host_handle, going from public.spark_inbox()`);
  check(box.length === 1 && box[0].id === id && box[0].host_handle === "ada" && box[0].kind === "derby",
        "the invite reaches the friend's inbox with the host's handle", JSON.stringify(box));

  await asUser(D);
  check((await rows(`select 1 from public.spark_inbox()`)).length === 0, "a stranger's inbox is empty");
  check(Boolean(await fails(`select public.spark_answer('${id}', 'in')`)), "a stranger cannot answer");

  await asUser(B);
  await db.exec(`select public.spark_answer('${id}', 'in')`);
  check((await rows(`select 1 from public.spark_inbox()`)).length === 0, "after answering, it leaves the inbox");
  check(Boolean(await fails(`select public.spark_answer('${id}', 'maybe')`)), "only in / out / waiting are answers");

  await asUser(C);
  const c = await rows(`select going from public.spark_inbox()`);
  check(c.length === 1 && c[0].going === 1, "others see how many are in");
  await db.exec(`select public.spark_answer('${id}', 'out')`);

  await asUser(B);
  await db.exec(`select public.spark_answer('${id}', 'waiting')`);
  check((await rows(`select 1 from public.spark_inbox()`)).length === 1, "undo puts it back in the inbox");
  await db.exec(`select public.spark_answer('${id}', 'in')`);
}

console.log("\n— the host —");
{
  await asUser(A);
  const m = await rows(`select invited, going, not_going from public.spark_mine()`);
  check(m.length === 1 && m[0].invited === 2 && m[0].going === 1 && m[0].not_going === 1,
        "the host sees invited / in / out", JSON.stringify(m));

  await asUser(B);
  check((await rows(`select 1 from public.spark_mine()`)).length === 0, "a guest hosts nothing");
  check(Boolean(await fails(`select public.spark_cancel('${id}')`)), "a guest cannot cancel");

  await asUser(A);
  await db.exec(`select public.spark_cancel('${id}')`);
  await asService();
  check((await rows(`select 1 from public.spark_invites where spark_id = '${id}'`)).length === 0,
        "cancelling removes the invites too");
}

console.log("\n— old plans —");
{
  await asService();
  const old = (await rows(`insert into public.sparks (host_id, kind, title, starts_at)
                           values ('${A}', 'hike', 'old', now() - interval '2 days') returning id`))[0].id;
  await db.exec(`insert into public.spark_invites (spark_id, user_id) values ('${old}', '${B}')`);
  await asUser(B);
  check((await rows(`select 1 from public.spark_inbox()`)).length === 0, "a plan that is over is not in the inbox");
  await asUser(A);
  check((await rows(`select 1 from public.spark_mine()`)).length === 0, "nor in the host's list");
}

console.log("\n— the twenty of 56 —");
{
  await asUser(A);
  check(!(await fails(`select public.spark_create('karaoke', 'karaoke, no shame', now() + interval '1 day', null, array['${B}']::uuid[])`)),
        "a kind added in 56 (karaoke) is taken");
  check(!(await fails(`select public.spark_create('walk', 'walk the city', now() + interval '1 day', null, array['${B}']::uuid[])`)),
        "and the last of them (walk)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
