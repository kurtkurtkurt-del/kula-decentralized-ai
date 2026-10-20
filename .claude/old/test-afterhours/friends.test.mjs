/* afterhours — arkadaslik akisi */

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
                 "../sql/06_views.sql", "../sql/07_friends.sql"]) {
  await db.exec(await read(d));
}

const A = "aaaaaaaa-1111-1111-1111-111111111111";
const B = "bbbbbbbb-2222-2222-2222-222222222222";
const C = "cccccccc-3333-3333-3333-333333333333";

await db.exec(`
  insert into auth.users (id, email) values
    ('${A}', 'a@x.com'), ('${B}', 'b@x.com'), ('${C}', 'c@x.com');
  update public.profiles set handle = 'ada' where id = '${A}';
  update public.profiles set handle = 'lena'  where id = '${B}';
  update public.profiles set handle = 'tobi'  where id = '${C}';
`);

const asUser = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);

console.log("\n— the handle —");
{
  await asService();
  let err = null;
  try { await db.exec(`update public.profiles set handle = 'Büyük Harf' where id = '${A}'`); }
  catch (e) { err = e.message; }
  check(Boolean(err), "a handle that does not fit the shape is refused");

  await db.exec(`update public.profiles set handle = 'ada' where id = '${A}'`);
  let second = null;
  try { await db.exec(`update public.profiles set handle = 'ada' where id = '${B}'`); }
  catch (e) { second = e.message; }
  check(Boolean(second), "two people cannot hold the same handle");
  await db.exec(`update public.profiles set handle = 'lena' where id = '${B}'`);
}

console.log("\n— sending a request —");
{
  await asUser(A);
  const r = await db.query(`select public.friend_request('lena') as s`);
  check(r.rows[0].s === "sent", "the request was sent");

  const y = await db.query(`select public.friend_request('nosuchperson') as s`);
  check(y.rows[0].s === "notfound", "no request goes to a handle that does not exist");

  const k = await db.query(`select public.friend_request('ada') as s`);
  check(k.rows[0].s === "yourself", "you cannot send a request to yourself");

  const l = await db.query(`select other_id, status, direction from public.friends_list()`);
  check(l.rows.length === 1 && l.rows[0].status === "pending" && l.rows[0].direction === "outgoing",
    "an outgoing request shows in your own list");
}

console.log("\n— consent cannot be skipped —");
{
  /* The pending request A→B is on the table. Accepting belongs to the
     side that RECEIVED it; the requester's tools are insert and delete. */
  await asUser(A);
  await db.exec(`update public.friendships set status = 'accepted' where addressee_id = '${B}'`);
  const s = await db.query(`select status from public.friends_list()`);
  check(s.rows[0].status === "pending", "the requester cannot accept their own request");

  let born = null;
  try {
    await db.exec(`insert into public.friendships (requester_id, addressee_id, status)
                   values ('${A}', '${C}', 'accepted')`);
  } catch (e) { born = e.message; }
  check(Boolean(born), "a friendship cannot be INSERTed as already accepted");

  let repointed = null;
  try {
    await db.exec(`update public.friendships set addressee_id = '${C}'
                   where requester_id = '${A}'`);
  } catch (e) { repointed = e.message; }
  check(Boolean(repointed), "an accepted-side swap is not the requester's to make");
}

console.log("\n— the other side —");
{
  await asUser(B);
  const l = await db.query(`select handle, status, direction from public.friends_list()`);
  check(l.rows.length === 1 && l.rows[0].direction === "incoming" && l.rows[0].handle === "ada",
    "on the other side it shows as incoming");

  /* Sending a request back the other way to the same person = accepting */
  const r = await db.query(`select public.friend_request('ada') as s`);
  check(r.rows[0].s === "accepted", "a request in the other direction accepts the pending one");

  const s = await db.query(`select status from public.friends_list()`);
  check(s.rows[0].status === "accepted", "the friendship is confirmed");
}

console.log("\n— what a friend kept —");
{
  await asUser(B);
  await db.exec(`select public.swipe_set('asap-rocky', 'right')`);
  await db.exec(`select public.swipe_set('nick-cave', 'left')`);

  await asUser(A);
  const r = await db.query(`select slug, friend from public.friends_kept()`);
  check(r.rows.length === 1 && r.rows[0].slug === "asap-rocky",
    "what a friend swiped right comes through, what they swiped left does not");
  check(r.rows[0].friend === "lena", "it says who kept it");

  await asUser(C);
  const y = await db.query(`select count(*)::int as n from public.friends_kept()`);
  check(y.rows[0].n === 0, "a non-friend sees nothing");
}

console.log("\n— ending the friendship —");
{
  await asUser(C);
  const y = await db.query(`select public.friend_remove('${A}') as s`);
  check(y.rows[0].s === false, "olmayan arkadasligi silmek one sey yapmiyor");

  await asUser(A);
  const r = await db.query(`select public.friend_remove('${B}') as s`);
  check(r.rows[0].s === true, "the friendship was ended");

  const l = await db.query(`select count(*)::int as n from public.friends_list()`);
  check(l.rows[0].n === 0, "list bosaldi");

  const k = await db.query(`select count(*)::int as n from public.friends_kept()`);
  check(k.rows[0].n === 0, "what a former friend kept is no longer visible");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
