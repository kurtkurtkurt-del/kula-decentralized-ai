/* afterhours — the door (57) and the words of a push (58) */

import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

const read = (y) => readFile(new URL(y, import.meta.url), "utf8");
let passed = 0, failed = 0;
const check = (k, name, extra = "") => {
  if (k) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
};
process.on("unhandledRejection", (e) => { console.log("\nERROR: " + ((e && e.message) || e)); if (e && e.where) console.log(e.where); process.exit(1); });

// The whole structure, as it is pasted: the door sits on everything.
const db = new PGlite();
await db.exec(await read("../test/supabase-shim.sql"));
await db.exec(await read("../sql/setup-1-structure.sql"));

const [A, B, C, D, G] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222",
  "cccccccc-3333-3333-3333-333333333333", "dddddddd-4444-4444-4444-444444444444", "eeeeeeee-5555-5555-5555-555555555555"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asGuest = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}","is_anonymous":true}';`);
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const one = async (sql) => (await db.query(sql)).rows[0];
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
await db.exec(`
  insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${C}','c@x'),('${D}','d@x'),('${G}','g@x');
  update public.profiles set handle = 'ada', display_name = 'owner' where id = '${A}';
  update public.profiles set handle = 'berk',  display_name = 'Berk'  where id = '${B}';
  update public.profiles set handle = 'cansu', display_name = 'Cansu' where id = '${C}';
  update public.profiles set handle = 'deniz', display_name = 'Deniz' where id = '${D}';
  insert into public.friendships (requester_id, addressee_id, status) values ('${A}', '${B}', 'accepted');
  update public.profiles set is_admin = true, account_type = 'admin' where id = '${G}';
`);

console.log("\n— who is asking —");
{
  await asAnon();
  check(Boolean(await fails(`select public.assert_member()`)), "nobody: refused");
  await as(A);
  check((await one(`select public.assert_member() as me`)).me === A, "a member: their own id");
  await asService();
  await db.exec(`insert into auth.users (id, email) values ('ffffffff-6666-6666-6666-666666666666', 'f@x')`);
  await asGuest('ffffffff-6666-6666-6666-666666666666');
  check((await one(`select public.assert_member() as me`)).me === 'ffffffff-6666-6666-6666-666666666666', "a guest passes the door (the writes refuse them)");
  await as(G);
  await db.exec(`select public.staff_ban('${D}', 'spam')`);
  await as(D);
  check(/closed/.test(await fails(`select public.assert_member()`) ?? ""), "a banned account: refused");
  check(Boolean(await fails(`select * from public.posts_feed()`)), "…and reads no feed");
  check(Boolean(await fails(`select * from public.people_search('be')`)), "…finds nobody");
  check(Boolean(await fails(`select * from public.people_suggested()`)), "…is suggested nobody");
  check(Boolean(await fails(`select * from public.past_feed('munchen')`)), "…sees no past nights");
  check(Boolean(await fails(`select * from public.waves_kept()`)), "…no waves");
  await asAnon();
  check(Boolean(await fails(`select * from public.posts_feed()`)), "signed out: no feed either");
  await as(A);
  check((await fails(`select * from public.posts_feed()`)) === null, "a member reads the feed");
  check((await rows(`select * from public.people_search('be')`)).length === 1, "and finds berk");
}

console.log("\n— who may be seen —");
{
  await asService();
  const vis = (v, o) => one(`select public.visible_to('${v}', '${o}') as r`).then((r) => r.r);
  const reach = (v, o) => one(`select public.reachable('${v}', '${o}') as r`).then((r) => r.r);
  check(await vis(A, B) === true, "a friend is visible");
  check(await vis(A, C) === true, "a stranger who is discoverable is visible");
  check(await vis(A, D) === false, "a banned account is not");
  check(await reach(A, D) === false, "nor reachable");
  await db.exec(`update public.profile_settings set discoverable = false where user_id = '${C}'`);
  check(await vis(A, C) === false, "not discoverable: a stranger does not see them");
  check(await reach(A, C) === true, "but they are still reachable (a wave may pass)");
  await db.exec(`insert into public.friendships (requester_id, addressee_id, status) values ('${A}', '${C}', 'accepted')`);
  check(await vis(A, C) === true, "as a friend they are visible again");
  await db.exec(`insert into public.blocks (blocker_id, blocked_id) values ('${C}', '${A}')`);
  check(await vis(A, C) === false && await reach(A, C) === false, "a block either way closes both");
  check(await vis(A, A) === true, "you see yourself");
  // card_visible is a helper the browser roles cannot call; the service can, with a sub.
  await db.exec(`reset role; set request.jwt.claims = '{"sub":"${A}"}';`);
  check((await one(`select public.card_visible('${B}') as r`)).r === true, "card_visible is visible_to with you as the viewer");
  await asService();
  await db.exec(`insert into public.friendships (requester_id, addressee_id, status) values ('${B}', '${D}', 'accepted')`);
  const w = await rows(`select * from public.spark_waves('${A}')`);
  check(w.length === 1 && w[0].person === B, "a wave stops at the banned friend of a friend", JSON.stringify(w));
}

console.log("\n— the words of a push —");
{
  await asService();
  for (const [kind, data] of [
    ["room_message", '{"name":"berk","title":"blitz","text":"meet at mine, do not tell"}'],
    ["reply", '{"name":"berk","text":"secret"}'],
    ["group_message", '{"group":"🪩 cuma","name":"berk","text":"secret"}'],
    ["post", '{"name":"berk","text":"secret"}'],
    ["post_like", '{"name":"berk","text":"secret"}'],
    ["post_comment", '{"name":"berk","text":"secret"}'],
  ]) {
    for (const lang of ["en", "de", "tr"]) {
      const t = await one(`select * from public.push_text('${kind}', '${lang}', '${data}'::jsonb)`);
      check(!/secret|do not tell/.test(t.title + " " + t.body) && t.body.length > 0, `${kind} · ${lang}: a fixed sentence, not the words`, JSON.stringify(t));
    }
  }
  const t = await one(`select * from public.push_text('room_message', 'en', '{"name":"berk","title":"blitz","text":"x"}'::jsonb)`);
  check(t.title === "berk in blitz" && t.body === "a new line in your room", "the title still names who and where", JSON.stringify(t));
  const m = await one(`select * from public.push_text('match', 'tr', '{"name":"berk","title":"Blitz"}'::jsonb)`);
  check(m.title === "berk de gidiyor" && m.body === "Blitz", "the other kinds are as they were");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
