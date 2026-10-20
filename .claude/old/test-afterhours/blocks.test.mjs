/* afterhours — blocking someone (50) */

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
for (const d of ["../test/supabase-shim.sql", "../sql/01_schema.sql", "../sql/02_rls.sql",
                 "../sql/03_seed_catalog.sql", "../sql/06_views.sql", "../sql/07_friends.sql",
                 "../sql/12_profiles.sql", "../sql/25_people.sql", "../sql/27_sparks.sql", "../sql/28_spark_waves.sql",
                 "../sql/50_blocks.sql", "../sql/50_blocks.sql"]) {
  await db.exec(await read(d));
}

const [A, B, C, D] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222",
  "cccccccc-3333-3333-3333-333333333333", "dddddddd-4444-4444-4444-444444444444"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const one = async (sql) => (await db.query(sql)).rows[0];
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
await db.exec(`
  insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${C}','c@x'),('${D}','d@x');
  update public.profiles set handle = 'ada' where id = '${A}';
  update public.profiles set handle = 'berk'  where id = '${B}';
  update public.profiles set handle = 'cansu' where id = '${C}';
  update public.profiles set handle = 'deniz' where id = '${D}';
  insert into public.friendships (requester_id, addressee_id, status) values
    ('${A}', '${B}', 'accepted'), ('${B}', '${C}', 'accepted'), ('${D}', '${A}', 'pending');
`);

console.log("\n— blocking —");
{
  await asService();
  check((await rows(`select * from public.spark_waves('${A}')`)).length === 2, "before: the wave reaches a friend and a friend of theirs");
  await as(A);
  check((await one(`select public.block_user('${B}') as r`)).r === true, "A blocks B");
  check((await one(`select public.block_user('${B}') as r`)).r === true, "twice changes nothing");
  check((await one(`select public.people_relation('${B}') as r`)).r === "none", "the friendship is gone");
  await asService();
  check((await rows(`select * from public.spark_waves('${A}')`)).length === 0, "the wave stops at the block");
  await as(A);
  check(/yourself/.test(await fails(`select public.block_user('${A}')`) ?? ""), "not yourself");
  const mine = await rows(`select handle from public.my_blocks()`);
  check(mine.length === 1 && mine[0].handle === "berk", "my_blocks lists B");
  check((await rows(`select * from public.people_search('berk')`)).length === 0, "A no longer finds B");
  check((await rows(`select * from public.profile_card('berk')`)).length === 0, "nor B's card");
  check((await one(`select public.friend_request('berk') as r`)).r === "notfound", "nor can ask");
  check(Boolean(await fails(`select * from public.blocks`)), "the table itself is closed");

  await as(B);
  check((await rows(`select * from public.people_search('ada')`)).length === 0, "B does not find A");
  check((await rows(`select * from public.profile_card('ada')`)).length === 0, "nor A's card");
  check((await one(`select public.friend_request('ada') as r`)).r === "notfound", "a request from B answers notfound");
  check(Boolean(await fails(`insert into public.friendships (requester_id, addressee_id) values ('${B}', '${A}')`)), "a direct insert is refused");
  check((await rows(`select * from public.my_blocks()`)).length === 0, "B's own list is empty: B is not told");
  check((await one(`select public.unblock_user('${A}') as r`)).r === false, "B cannot lift A's block");

  await as(A);
  check((await one(`select public.block_user('${D}') as r`)).r === true, "a pending request is cleared too");
  check((await rows(`select * from public.friends_list()`)).length === 0, "nothing left in the friends list");
}

console.log("\n— unblocking —");
{
  await as(A);
  check((await one(`select public.unblock_user('${B}') as r`)).r === true, "A lifts the block");
  check((await rows(`select * from public.people_search('berk')`)).length === 1, "B can be found again");
  check((await one(`select public.people_relation('${B}') as r`)).r === "none", "but the friendship does not come back");
  check((await one(`select public.friend_request('berk') as r`)).r === "sent", "a new request goes through");

  await asAnon();
  check(Boolean(await fails(`select public.block_user('${C}')`)), "signed out, nothing");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
