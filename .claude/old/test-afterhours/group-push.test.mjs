/* afterhours — groups and posts say so (48) */

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
for (const d of ["../sql/48_group_push.sql", "../sql/48_group_push.sql"]) await db.exec(await read(d));

const [A, B, C, D] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222",
  "cccccccc-3333-3333-3333-333333333333", "dddddddd-4444-4444-4444-444444444444"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const one = async (sql) => (await db.query(sql)).rows[0];
const rows = async (sql) => (await db.query(sql)).rows;
const box = async (kind) => { await asService(); return rows(`select user_id, key, data from public.push_outbox where kind = '${kind}' order by id`); };
const who = (list) => list.map((r) => r.user_id).sort().join(",");

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${C}','c@x'),('${D}','d@x')`);
for (const x of [B, C]) await db.exec(`insert into public.friendships (requester_id, addressee_id, status) values ('${A}', '${x}', 'accepted')`);
await db.exec(`delete from public.push_outbox`);
const ns = (await rows(`select id from public.events where is_published order by slug limit 3`)).map((r) => r.id);
await db.exec(`update public.events set starts_at = now() + interval '24 hours', ticket_url = 'https://t.example/x' where id = '${ns[0]}'`);
await db.exec(`update public.events set starts_at = now() + interval '5 days' where id in ('${ns[1]}', '${ns[2]}')`);

console.log("\n— members —");
let g;
{
  await as(A);
  g = (await one(`select public.group_create('Cuma', '🪩', 'red', 'lasting', null, null, null, array['${B}','${C}']::uuid[]) as g`)).g;
  const added = await box("group_added");
  check(who(added) === [B, C].sort().join(","), "the two A put in hear it; A does not", who(added));
  check(added[0].data.group === "🪩 Cuma" && added[0].data.name === "a" && added[0].data.url === `/groups/${g}`, "with the group, who added them, and where it opens");
  await as(B);
  const code = (await one(`select public.group_invite('${g}') as c`)).c;
  await as(D);
  await db.exec(`select public.group_join('${code}')`);
  check(who(await box("group_joined")) === [A, B, C].sort().join(","), "D came with the code: the others hear it");
  check((await box("group_added")).length === 2, "and D gets no 'added'");
}

console.log("\n— a match —");
{
  for (const x of [A, B, C]) { await as(x); await db.exec(`select public.group_swipe('${g}', '${ns[1]}', 'right')`); }
  check((await box("group_match")).length === 0, "three of four: no match yet");
  await as(D); await db.exec(`select public.group_swipe('${g}', '${ns[1]}', 'right')`);
  check(who(await box("group_match")) === [A, B, C, D].sort().join(","), "the last yes: everyone hears it");
  await as(D); await db.exec(`select public.group_swipe('${g}', '${ns[1]}', 'right')`);
  check((await box("group_match")).length === 4, "once");
}

console.log("\n— votes, plans, the chat —");
{
  await as(B);
  const r = (await one(`select public.round_start('${g}', array['${ns[0]}','${ns[1]}']::uuid[], 1) as r`)).r;
  check(who(await box("group_round")) === [A, C, D].sort().join(","), "a vote: all but who started it");
  for (const x of [A, B, C, D]) { await as(x); await db.exec(`select public.round_vote('${r}', '${ns[0]}')`); }
  check(who(await box("group_won")) === [A, B, C, D].sort().join(","), "the result: everyone");
  await as(C);
  await db.exec(`select public.plan_set('${g}', '${ns[0]}')`);
  check(who(await box("group_plan")) === [A, B, D].sort().join(","), "a plan set by C: the others");
  await as(A);
  await db.exec(`select public.group_say('${g}', 'who drives?')`);
  await db.exec(`select public.group_say('${g}', 'i can')`);
  const said = await box("group_message");
  check(who(said) === [B, C, D].sort().join(","), "two lines in a row: one buzz each for the others", String(said.length));
  check(said[0].data.text === "who drives?" && said[0].data.url === `/groups/chat?id=${g}`, "the first line, opening the chat");
}

console.log("\n— live —");
{
  await as(B); await db.exec(`select public.group_live_here('${g}')`);
  check(who(await box("group_live")) === [A, C, D].sort().join(","), "B opens live alone: the others are called");
  await as(C); await db.exec(`select public.group_live_here('${g}')`);
  check((await box("group_live")).length === 3, "C joins while B is there: nobody is called again");
}

console.log("\n— the ticket, the switch, posts —");
{
  await as(A); await db.exec(`select public.rsvp_set('${ns[0]}', 'in')`);
  await as(B); await db.exec(`select public.rsvp_set('${ns[0]}', 'maybe')`); await db.exec(`select public.plan_ticket('${g}', true)`);
  await as(C); await db.exec(`select public.rsvp_set('${ns[0]}', 'out')`);
  await asService();
  await db.exec(`select public.group_push_hourly()`);
  await db.exec(`select public.group_push_hourly()`);
  check(who(await box("group_ticket")) === A, "tomorrow: only who is in without a ticket, once", who(await box("group_ticket")));

  await asService();
  await db.exec(`update public.profile_settings set notify_posts = false where user_id = '${C}'`);
  await as(A);
  await db.exec(`select public.post_create('', '${A}/p.jpg', null)`);
  const posts = await box("post");
  check(who(posts) === B && posts[0].data.text === "📷", "a post: friends hear it; C turned posts off", who(posts));
  await asService();
  await db.exec(`update public.profile_settings set notify_groups = false where user_id = '${D}'`);
  await as(A); await db.exec(`select public.plan_set('${g}', '${ns[2]}')`);
  check(!(await box("group_plan")).slice(3).some((r) => r.user_id === D), "groups off: D hears nothing more");
}

console.log("\n— the words —");
{
  await asService();
  const t = await one(`select * from public.push_text('group_match', 'tr', '{"group":"🪩 Cuma","title":"Blitz"}')`);
  check(t.title === "🪩 Cuma · herkes var" && t.body === "Blitz", "in the language of the phone", JSON.stringify(t));
  const old = await one(`select * from public.push_text('spark_in', 'de', '{"name":"a","title":"x"}')`);
  check(old.title === "a ist dabei", "the old kinds still read the same");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
