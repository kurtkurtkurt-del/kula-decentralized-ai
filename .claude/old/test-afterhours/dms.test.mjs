/* afterhours — direct messages (59) */

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
  update public.profiles set handle = 'ada', display_name = 'owner' where id = '${A}';
  update public.profiles set handle = 'berk',  display_name = 'Berk'  where id = '${B}';
  update public.profiles set handle = 'cansu' where id = '${C}';
  update public.profiles set handle = 'deniz' where id = '${D}';
  insert into public.friendships (requester_id, addressee_id, status) values ('${A}', '${B}', 'accepted'), ('${C}', '${A}', 'pending');
`);

console.log("\n— starting one —");
let thread;
{
  await as(A);
  thread = (await one(`select public.dm_start('berk') as t`)).t;
  check(Boolean(thread), "a friend: the thread opens");
  check((await one(`select public.dm_start('@Berk ') as t`)).t === thread, "again, spelled differently: the same thread");
  check(/friends only/.test(await fails(`select public.dm_start('cansu')`) ?? ""), "a pending request is not a friend yet");
  check(/friends only|no such/.test(await fails(`select public.dm_start('deniz')`) ?? ""), "a stranger is nobody");
  check(/no such/.test(await fails(`select public.dm_start('ada')`) ?? ""), "not yourself");
  await as(B);
  check((await one(`select public.dm_start('ada') as t`)).t === thread, "from the other side: the same thread");
  await asAnon();
  check(Boolean(await fails(`select public.dm_start('berk')`)), "signed out: refused");
  await asService();
  check(Boolean(await fails(`set role authenticated; select * from public.dm_threads`)), "the table itself is closed");
}

console.log("\n— writing —");
{
  await as(A);
  const id = (await one(`select public.dm_send('${thread}', '  see you at blitz?  ') as id`)).id;
  check(Boolean(id), "a line is sent");
  await as(B);
  await db.exec(`select public.dm_send('${thread}', 'yes, 23:00')`);
  const t = await rows(`select * from public.dm_thread('${thread}')`);
  check(t.length === 2 && t[0].body === "see you at blitz?" && t[0].mine === false && t[1].mine === true, "the thread, oldest first, trimmed, mine marked", JSON.stringify(t));
  check((await rows(`select * from public.dm_thread('${thread}', ${t[0].id})`)).length === 1, "after an id: only what came after");
  await as(C);
  check(Boolean(await fails(`select * from public.dm_thread('${thread}')`)), "someone else cannot read it");
  check(Boolean(await fails(`select public.dm_send('${thread}', 'hi')`)), "nor write into it");
  await as(A);
  const list = await rows(`select * from public.dm_list()`);
  check(list.length === 1 && list[0].handle === "berk" && list[0].last_body === "yes, 23:00" && list[0].last_mine === false, "the list: berk, his last line", JSON.stringify(list));
  check(Boolean(await fails(`select public.dm_send('${thread}', '')`)), "an empty line is refused");
  await db.exec(`select public.dm_unsay(${id})`);
  check((await rows(`select * from public.dm_thread('${thread}')`)).length === 1, "taking your own line back");
  await as(B);
  const yes = (await rows(`select * from public.dm_thread('${thread}')`))[0].id;
  await as(A);
  await db.exec(`select public.dm_unsay(${yes})`);
  check((await rows(`select * from public.dm_thread('${thread}')`)).length === 1, "not someone else's");
}

console.log("\n— the push —");
{
  await asService();
  const o = await rows(`select kind, data from public.push_outbox where kind = 'dm' and user_id = '${B}'`);
  check(o.length >= 1 && o[0].data.name && !("text" in o[0].data), "berk's outbox got a dm with a name and no words", JSON.stringify(o));
  const w = await one(`select * from public.push_text('dm', 'en', '${JSON.stringify(o[0].data)}'::jsonb)`);
  check(w.title === "ada" && w.body === "a new message", "the words: the name, a fixed sentence", JSON.stringify(w));
  check((await one(`select public.push_wants('${B}', 'dm') as w`)).w === true, "wanted by default");
  await db.exec(`update public.profile_settings set notify_dms = false where user_id = '${B}'`);
  check((await one(`select public.push_wants('${B}', 'dm') as w`)).w === false, "switched off");
}

console.log("\n— a block, a ban —");
{
  await as(B);
  await db.exec(`select public.block_user('${A}')`);
  await as(A);
  check((await rows(`select * from public.dm_list()`)).length === 0, "blocked: the thread leaves the list");
  check(Boolean(await fails(`select public.dm_send('${thread}', 'still there?')`)), "and takes no line");
  check(Boolean(await fails(`select public.dm_start('berk')`)), "nor a new one");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
