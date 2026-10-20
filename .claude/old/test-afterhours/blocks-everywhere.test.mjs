/* afterhours — a block reaches every reader, and a direct message can be reported (70) */

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
await db.exec(await read("../sql/70_blocks_and_dm_reports.sql"));

const [A, B, C, CM] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222",
                       "cccccccc-3333-3333-3333-333333333333", "dddddddd-4444-4444-4444-444444444444"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${C}','c@x'),('${CM}','cm@x')`);
await db.exec(`update public.profiles set handle = 'ada' where id = '${A}'`);
await db.exec(`update public.profiles set handle = 'berk' where id = '${B}'`);
await db.exec(`update public.profiles set handle = 'cansu' where id = '${C}'`);
await db.exec(`update public.profiles set account_type = 'community_manager' where id = '${CM}'`);
await db.exec(`insert into public.friendships (requester_id, addressee_id, status) values ('${A}','${B}','accepted')`);
const night = (await rows(`select id, slug from public.events where is_published limit 1`))[0];
await db.exec(`insert into public.comments (event_id, author_id, author_name, body) values ('${night.id}', '${B}', 'berk', 'berk says hi'), ('${night.id}', '${C}', 'cansu', 'cansu says hi')`);
await db.exec(`insert into public.checkins (user_id, event_id) values ('${A}', '${night.id}'), ('${B}', '${night.id}'), ('${C}', '${night.id}')`);
await db.exec(`insert into public.room_posts (event_id, user_id, body) values ('${night.id}', '${B}', 'room berk'), ('${night.id}', '${C}', 'room cansu')`);

console.log("\n— before the block —");
{
  await as(A);
  check((await rows(`select 1 from public.comments_public where event_id = '${night.id}'`)).length === 2, "ada reads both comments");
  check((await rows(`select 1 from public.room_list('${night.slug}')`)).length === 2, "and the whole room");
  await asAnon();
  check((await rows(`select 1 from public.comments_public where event_id = '${night.id}'`)).length === 2, "signed out, the comments still read");
}

console.log("\n— ada blocks berk —");
{
  await as(A);
  await db.exec(`select public.block_user('${B}')`);
  const c = await rows(`select author from public.comments_public where event_id = '${night.id}'`);
  check(c.length === 1 && c[0].author === "cansu", "the blocked person's comment is gone for ada", JSON.stringify(c));
  const r = await rows(`select body from public.room_list('${night.slug}')`);
  check(!r.some((x) => x.body === "room berk") && r.length === 1, "and their room line");
  await as(B);
  check(!(await rows(`select body from public.room_list('${night.slug}')`)).some((x) => x.body === "room ada"), "berk reads nothing of ada either (ada wrote nothing, nothing to see)");
  await as(C);
  check((await rows(`select 1 from public.comments_public where event_id = '${night.id}'`)).length === 2, "a third person still reads everyone");
  await asAnon();
  check((await rows(`select 1 from public.comments_public where event_id = '${night.id}'`)).length === 2, "signed out, still both");
}

console.log("\n— a direct message is reported —");
{
  await asService();
  const thread = (await rows(`insert into public.dm_threads (a, b) values ('${A}', '${C}') returning id`))[0].id;
  await db.exec(`insert into public.friendships (requester_id, addressee_id, status) values ('${A}','${C}','accepted')`);
  const m = (await rows(`insert into public.dm_messages (thread_id, user_id, body) values ('${thread}', '${C}', 'rude line') returning id`))[0].id;
  await as(A);
  await db.exec(`select public.report('dm_message', '${m}', 'insults')`);
  await as(B);
  check(Boolean(await fails(`select public.report('dm_message', '${m}', 'x')`)), "someone outside the thread cannot report it");
  await as(CM);
  const list = await rows(`select kind, preview, author from public.staff_reports()`);
  const d = list.find((x) => x.kind === "dm_message");
  check(d && d.preview === "rude line" && d.author === "cansu", "the staff see the words and who wrote them", JSON.stringify(list));
  await db.exec(`select public.staff_report_settle('dm_message', '${m}', true)`);
  await asService();
  check((await rows(`select 1 from public.dm_messages where id = ${m}`)).length === 0, "removing it deletes the line");
  await as(A);
  check((await rows(`select 1 from public.my_notices() where kind = 'report_removed'`)).length === 1, "and the reporter hears");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
