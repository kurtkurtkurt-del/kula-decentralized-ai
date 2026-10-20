/* afterhours — a group decides and makes a plan (46) */

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
                 "../sql/03_seed_catalog.sql", "../sql/04_seed_events.sql", "../sql/06_views.sql", "../sql/07_friends.sql",
                 "../sql/12_profiles.sql", "../sql/15_ticketmaster.sql", "../sql/18_geo.sql", "../sql/32_rsvp.sql"]) {
  await db.exec(await read(d));
}
await db.exec(`create or replace function public.is_guest() returns boolean language sql stable as $$
  select coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'is_anonymous')::boolean, false); $$;`);
for (const d of ["../sql/44_groups.sql", "../sql/46_group_plans.sql", "../sql/46_group_plans.sql"]) await db.exec(await read(d));

const [A, B, C, D] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222",
  "cccccccc-3333-3333-3333-333333333333", "dddddddd-4444-4444-4444-444444444444"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const one = async (sql) => (await db.query(sql)).rows[0];
const rows = async (sql) => (await db.query(sql)).rows;
const plan = async () => (await one(`select public.group_plan('${g}') as p`)).p;

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${C}','c@x'),('${D}','d@x')`);
for (const x of [B, C]) await db.exec(`insert into public.friendships (requester_id, addressee_id, status) values ('${A}', '${x}', 'accepted')`);
await db.exec(`update public.events set starts_at = now() + (n.k || ' days')::interval
  from (select id, row_number() over (order by slug) as k from public.events) n where n.id = events.id`);
const ns = (await rows(`select id from public.events order by slug limit 4`)).map((r) => r.id);
await as(A);
const g = (await one(`select public.group_create('Cuma', '🪩', 'red', 'lasting', null, null, null, array['${B}','${C}']::uuid[]) as g`)).g;

console.log("\n— a vote —");
let r;
{
  await as(B);
  check(/two or three/.test(await fails(`select public.round_start('${g}', array['${ns[0]}']::uuid[], 3)`) ?? ""), "two or three nights");
  check(/hours/.test(await fails(`select public.round_start('${g}', array['${ns[0]}','${ns[1]}']::uuid[], 5)`) ?? ""), "1, 3, 12 or 24 hours");
  r = (await one(`select public.round_start('${g}', array['${ns[0]}','${ns[1]}','${ns[2]}']::uuid[], 3) as r`)).r;
  check(Boolean(r), "B puts three nights to a vote");
  check(/already open/.test(await fails(`select public.round_start('${g}', array['${ns[0]}','${ns[1]}']::uuid[], 1)`) ?? ""), "one vote at a time");
  await as(D);
  check(/not in this group/.test(await fails(`select public.round_vote('${r}', '${ns[0]}')`) ?? ""), "a stranger cannot vote");
  await as(A); await db.exec(`select public.round_vote('${r}', '${ns[1]}')`);
  await as(B); await db.exec(`select public.round_vote('${r}', '${ns[1]}')`);
  check(/not one of/.test(await fails(`select public.round_vote('${r}', '${ns[3]}')`) ?? ""), "only the choices");
  let p = await plan();
  check(p.round && p.round.voted === 2 && p.round.my_vote === ns[1] && p.round.options.find((o) => o.id === ns[1]).votes === 2, "the plan tab shows the vote", JSON.stringify(p.round?.options?.map((o) => o.votes)));
  check(p.plan === null, "no plan yet");
  await as(C); await db.exec(`select public.round_vote('${r}', '${ns[0]}')`);
  p = await plan();
  check(p.round === null && p.plan && p.plan.id === ns[1], "everyone voted: closed, the winner is the plan");
  check(/closed/.test(await fails(`select public.round_vote('${r}', '${ns[0]}')`) ?? ""), "a closed vote takes no more votes");
  const thread = await rows(`select kind from public.group_thread('${g}', 0)`);
  check(thread.map((m) => m.kind).join(",") === "round,won", "the chat has the vote and its result", thread.map((m) => m.kind).join(","));
}

console.log("\n— time runs out, or closed early —");
{
  await as(A);
  const r2 = (await one(`select public.round_start('${g}', array['${ns[2]}','${ns[3]}']::uuid[], 1) as r`)).r;
  await as(B); await db.exec(`select public.round_vote('${r2}', '${ns[3]}')`);
  await as(C);
  check(/whoever started/.test(await fails(`select public.round_close('${r2}')`) ?? ""), "only who started it (or the owner) ends it early");
  await asService();
  await db.exec(`update public.group_rounds set closes_at = now() - interval '1 minute' where id = '${r2}'`);
  await as(C);
  const p = await plan();
  check(p.round === null && p.plan.id === ns[3], "time up: the next read settles it");
  await as(A);
  const r3 = (await one(`select public.round_start('${g}', array['${ns[0]}','${ns[2]}']::uuid[], 24) as r`)).r;
  check((await one(`select public.round_close('${r3}') as w`)).w !== null, "closed early with no votes: nothing changes the plan");
  check((await plan()).plan.id === ns[3], "the plan stays");
}

console.log("\n— the plan —");
{
  await as(C);
  await db.exec(`select public.plan_set('${g}', '${ns[0]}')`);
  check((await plan()).plan.id === ns[0], "any member sets the plan straight");
  await db.exec(`select public.rsvp_set('${ns[0]}', 'in')`);
  await db.exec(`select public.plan_ticket('${g}', true)`);
  await as(A);
  await db.exec(`select public.rsvp_set('${ns[0]}', 'maybe')`);
  const people = (await plan()).plan.people;
  const c = people.find((x) => x.id === C), a = people.find((x) => x.id === A), b = people.find((x) => x.id === B);
  check(c.answer === "in" && c.ticket && a.answer === "maybe" && !a.ticket && b.answer === null, "who comes and who has a ticket");
  await as(C); await db.exec(`select public.plan_ticket('${g}', false)`);
  check(!(await plan()).plan.people.find((x) => x.id === C).ticket, "the ticket mark comes off again");
}

console.log("\n— the chat —");
{
  await as(A);
  const id = (await one(`select public.group_say('${g}', 'who drives?') as id`)).id;
  check(Boolean(id), "a member writes");
  await as(B);
  const t = await rows(`select * from public.group_thread('${g}', 0)`);
  const last = t.at(-1);
  check(last.body === "who drives?" && !last.mine && last.name === "a", "the others read it, oldest first");
  check((await rows(`select * from public.group_thread('${g}', ${id})`)).length === 0, "after the last one: nothing new");
  await db.exec(`select public.group_unsay(${id})`);
  check((await rows(`select * from public.group_thread('${g}', 0)`)).some((m) => m.id == id), "nobody deletes someone else's line");
  await as(A); await db.exec(`select public.group_unsay(${id})`);
  check(!(await rows(`select * from public.group_thread('${g}', 0)`)).some((m) => m.id == id), "the writer deletes their own");
  await as(D);
  check(Boolean(await fails(`select * from public.group_thread('${g}', 0)`)), "a stranger reads nothing");
  check(Boolean(await fails(`select public.group_say('${g}', 'hi')`)), "and writes nothing");
  check(Boolean(await fails(`select * from public.group_messages`)), "the table itself is closed");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
