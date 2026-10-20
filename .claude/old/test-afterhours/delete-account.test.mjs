/* afterhours — deleting an account, end to end (65)
   The stores ask that a deletion take everything. delete_account() (12) removes the
   auth user and the cascades do the rest; this test puts something of one person in
   every table that names a person, deletes the account, and then walks every foreign
   key to profiles: no row may still point at them. Two loose ends a cascade cannot
   tie (65): the last admin, and the groups the person owned. */

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
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${C}','c@x');
  update public.profiles set handle = 'ana' where id = '${A}';
  update public.profiles set handle = 'ben' where id = '${B}';
  update public.profiles set handle = 'cem' where id = '${C}';`);
const ev = (await one(`select id from public.events where is_published order by starts_at nulls last limit 1`)).id;

/* Something of A in every table that names a person, and B beside A where it takes two. */
await db.exec(`
  insert into public.swipes (user_id, event_id, direction) values ('${A}', '${ev}', 'right'), ('${B}', '${ev}', 'right');
  insert into public.friendships (requester_id, addressee_id, status) values ('${A}', '${B}', 'accepted');
  insert into public.comments (event_id, author_id, body) values ('${ev}', '${A}', 'a line of mine');
  insert into public.feedback (author_id, kind, body) values ('${A}', 'idea', 'a thought about the deck');
  insert into public.checkins (user_id, event_id) values ('${A}', '${ev}');
  insert into public.room_posts (event_id, user_id, body) values ('${ev}', '${A}', 'in the room');
  insert into public.profile_photos (user_id, path) values ('${A}', '${A}/1.jpg');
  insert into public.profile_links (user_id, kind, value) values ('${A}', 'instagram', 'ana');
  insert into public.push_tokens (user_id, token, platform) values ('${A}', 'ExpoPushToken[ana]', 'android');
  insert into public.push_outbox (user_id, kind, key) values ('${A}', 'dm', 'k1');
  insert into public.rsvps (user_id, event_id, answer) values ('${A}', '${ev}', 'in');
  insert into public.tickets (user_id, event_id, answer) values ('${A}', '${ev}', 'got');
  insert into public.sparks (id, host_id, kind, title, starts_at)
    values ('11111111-0000-0000-0000-000000000001', '${A}', 'hike', 'up the hill', now() + interval '1 day'),
           ('11111111-0000-0000-0000-000000000002', '${B}', 'grill', 'by the river', now() + interval '1 day');
  insert into public.spark_invites (spark_id, user_id) values ('11111111-0000-0000-0000-000000000002', '${A}'),
                                                               ('11111111-0000-0000-0000-000000000001', '${B}');
  insert into public.blocks (blocker_id, blocked_id) values ('${A}', '${C}'), ('${C}', '${A}');
  insert into public.reports (reporter_id, kind, target) values ('${A}', 'profile', '${C}');
  insert into public.notices (user_id, kind) values ('${A}', 'role');
  insert into public.posts (id, author_id, body) values ('22222222-0000-0000-0000-000000000001', '${A}', 'my post'),
                                                        ('22222222-0000-0000-0000-000000000002', '${B}', 'their post');
  insert into public.post_likes (post_id, user_id) values ('22222222-0000-0000-0000-000000000002', '${A}');
  insert into public.post_comments (post_id, author_id, body) values ('22222222-0000-0000-0000-000000000002', '${A}', 'nice');
  insert into public.post_reports (post_id, reporter_id) values ('22222222-0000-0000-0000-000000000002', '${A}');
  insert into public.client_errors (user_id, message) values ('${A}', 'a crash');
  insert into public.dm_threads (id, a, b) values ('33333333-0000-0000-0000-000000000001', '${A}', '${B}');
  insert into public.dm_messages (thread_id, user_id, body) values ('33333333-0000-0000-0000-000000000001', '${A}', 'hi'),
                                                                   ('33333333-0000-0000-0000-000000000001', '${B}', 'hey');

  /* three groups: A owns one with B, A owns one alone, B owns one A is in */
  insert into public.groups (id, name, created_by) values
    ('44444444-0000-0000-0000-000000000001', 'with ben', '${A}'),
    ('44444444-0000-0000-0000-000000000002', 'just me', '${A}'),
    ('44444444-0000-0000-0000-000000000003', 'bens', '${B}');
  insert into public.group_members (group_id, user_id, role, joined_at) values
    ('44444444-0000-0000-0000-000000000001', '${A}', 'owner', now() - interval '2 days'),
    ('44444444-0000-0000-0000-000000000001', '${B}', 'member', now() - interval '1 day'),
    ('44444444-0000-0000-0000-000000000002', '${A}', 'owner', now()),
    ('44444444-0000-0000-0000-000000000003', '${B}', 'owner', now() - interval '2 days'),
    ('44444444-0000-0000-0000-000000000003', '${A}', 'member', now());
  insert into public.group_swipes (group_id, user_id, event_id, direction) values ('44444444-0000-0000-0000-000000000003', '${A}', '${ev}', 'right');
  insert into public.group_live (group_id, user_id) values ('44444444-0000-0000-0000-000000000003', '${A}');
  insert into public.group_tickets (group_id, event_id, user_id) values ('44444444-0000-0000-0000-000000000003', '${ev}', '${A}');
  insert into public.group_messages (group_id, user_id, body) values ('44444444-0000-0000-0000-000000000003', '${A}', 'see you');
  insert into public.group_photos (group_id, event_id, user_id, path) values ('44444444-0000-0000-0000-000000000003', '${ev}', '${A}', '${A}/2.jpg');
  update public.profiles set is_admin = true where id = '${A}';`);

/* every column of public that points at profiles (or the auth user) */
const keys = await rows(`
  select c.conrelid::regclass::text as tbl, a.attname as col
    from pg_constraint c
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
   where c.contype = 'f' and c.confrelid in ('public.profiles'::regclass, 'auth.users'::regclass)`);
const pointing = async (id) => {
  const left = [];
  for (const k of keys) {
    const n = (await one(`select count(*)::int as n from ${k.tbl} where ${k.col} = '${id}'`)).n;
    if (n) left.push(`${k.tbl}.${k.col}: ${n}`);
  }
  return left;
};

console.log("\n— before —");
{
  check(keys.length >= 40, "the walk knows every column that names a person", String(keys.length));
  const before = await pointing(A);
  check(before.length >= 30, "the person is in most of them", before.length + " columns");
}

console.log("\n— the last admin —");
{
  await as(A);
  check(Boolean(await fails(`select public.delete_account()`)), "the only admin cannot delete the account");
  await asService();
  check((await one(`select count(*)::int as n from public.profiles where id = '${A}'`)).n === 1, "and it is still there");
  await db.exec(`update public.profiles set is_admin = true where id = '${C}'`);
}

console.log("\n— the deletion —");
{
  await as(A);
  await db.exec(`select public.delete_account()`);
  await asService();
  check((await one(`select count(*)::int as n from auth.users where id = '${A}'`)).n === 0, "the account is gone");
  const left = await pointing(A);
  check(left.length === 0, "no row of any table still points at the person", left.join(", "));
  check((await one(`select count(*)::int as n from public.dm_messages where body = 'hi'`)).n === 0, "the direct messages went, both sides of the thread");
  check((await one(`select author_name from public.comments where body = 'a line of mine'`)).author_name === "someone", "a comment stays, as someone");
  check((await rows(`select 1 from public.room_posts where body = 'in the room'`)).length === 0, "a room line goes with the person (73)");
  check((await rows(`select 1 from public.group_messages where body = 'see you'`)).length === 0, "a group line too");
}

console.log("\n— what stays with the others —");
{
  check((await one(`select count(*)::int as n from public.swipes where user_id = '${B}'`)).n === 1, "the friend keeps their swipe");
  check((await one(`select count(*)::int as n from public.posts where author_id = '${B}'`)).n === 1, "and their post");
  check((await one(`select count(*)::int as n from public.sparks where host_id = '${B}'`)).n === 1, "and their spark");
  check((await one(`select role from public.group_members where group_id = '44444444-0000-0000-0000-000000000001' and user_id = '${B}'`))?.role === "owner",
    "a group the person owned goes to the longest member");
  check((await one(`select count(*)::int as n from public.groups where id = '44444444-0000-0000-0000-000000000002'`)).n === 0,
    "a group they were alone in goes with them");
  check((await one(`select role from public.group_members where group_id = '44444444-0000-0000-0000-000000000003' and user_id = '${B}'`))?.role === "owner",
    "a group they were only in keeps its owner");
  check((await one(`select count(*)::int as n from public.friendships where requester_id = '${B}' or addressee_id = '${B}'`)).n === 0,
    "the friendship is gone from the other side too");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
