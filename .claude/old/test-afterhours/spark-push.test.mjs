/* afterhours — sparks say so: a push when one reaches you, and when someone is in */

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
                 "../sql/03_seed_catalog.sql", "../sql/04_seed_events.sql", "../sql/06_views.sql",
                 "../sql/07_friends.sql", "../sql/12_profiles.sql", "../sql/15_ticketmaster.sql",
                 "../sql/19_checkins.sql", "../sql/20_djs.sql", "../sql/26_push.sql",
                 "../sql/27_sparks.sql", "../sql/28_spark_waves.sql", "../sql/34_spark_push.sql"]) {
  await db.exec(await read(d));
}
await db.exec(await read("../sql/26_push.sql"));
await db.exec(await read("../sql/34_spark_push.sql"));

/* A — B — C — D, E alone */
const A = "aaaaaaaa-1111-1111-1111-111111111111";
const B = "bbbbbbbb-2222-2222-2222-222222222222";
const C = "cccccccc-3333-3333-3333-333333333333";
const D = "dddddddd-4444-4444-4444-444444444444";
const E = "eeeeeeee-5555-5555-5555-555555555555";

const asUser = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const rows = async (sql) => (await db.query(sql)).rows;
const outbox = async (kind) => { await asService(); return rows(`select user_id, key, data from public.push_outbox where kind = '${kind}' order by id`); };

await asService();
await db.exec(`
  insert into auth.users (id, email) values
    ('${A}', 'a@x.com'), ('${B}', 'b@x.com'), ('${C}', 'c@x.com'), ('${D}', 'd@x.com'), ('${E}', 'e@x.com');
  update public.profiles set handle = 'ada' where id = '${A}';
  update public.profiles set handle = 'berk'  where id = '${B}';
  update public.profiles set handle = 'cansu' where id = '${C}';
  insert into public.friendships (requester_id, addressee_id, status) values
    ('${A}', '${B}', 'accepted'), ('${B}', '${C}', 'accepted'), ('${C}', '${D}', 'accepted');
`);

let s1, s2;
console.log("\n— a spark reaches its wave —");
{
  await asUser(A);
  s1 = (await rows(`select public.spark_create('grill', 'grill by the river', now() + interval '1 day', 'river', 2) as id`))[0].id;
  const o = await outbox("spark");
  const to = new Set(o.map((r) => r.user_id));
  check(to.has(B) && to.has(C), "the 1st and 2nd wave hear it", JSON.stringify([...to]));
  check(!to.has(D), "the 3rd wave does not, when the spark goes to the 2nd");
  check(!to.has(A), "the host does not hear their own spark");
  check(!to.has(E), "someone outside every wave hears nothing");
  const b = o.find((r) => r.user_id === B);
  check(b.data.name === "ada" && b.data.title === "grill by the river", "it names the host and the spark");
  check(b.data.url === `/spark/grill?invite=${s1}`, "it opens the spark page as an invite", b.data.url);
  check(/^[a-z]{3} \d\d:\d\d$/.test(b.data.when), "it says when, on the phone's clock", b.data.when);
}

console.log("\n— the switch —");
{
  await asService();
  await db.exec(`insert into public.profile_settings (user_id, notify_sparks) values ('${C}', false)
                 on conflict (user_id) do update set notify_sparks = false`);
  await asUser(A);
  s2 = (await rows(`select public.spark_create('hike', 'a hike', now() + interval '2 days', null, 3) as id`))[0].id;
  const o = (await outbox("spark")).filter((r) => r.key.includes(s2));
  check(o.some((r) => r.user_id === D), "the 3rd wave hears a 3rd-wave spark");
  check(!o.some((r) => r.user_id === C), "someone who turned sparks off does not");
}

console.log("\n— someone is in —");
{
  await asUser(B);
  await db.exec(`select public.spark_answer('${s1}', 'in')`);
  let o = await outbox("spark_in");
  check(o.length === 1 && o[0].user_id === A && o[0].data.name === "berk", "the host hears who is in", JSON.stringify(o));
  await asUser(B);
  await db.exec(`select public.spark_answer('${s1}', 'out')`);
  await db.exec(`select public.spark_answer('${s1}', 'in')`);
  o = await outbox("spark_in");
  check(o.length === 1, "changing your mind back and forth tells the host once");
  await asUser(D);
  await db.exec(`select public.spark_answer('${s2}', 'out')`);
  o = await outbox("spark_in");
  check(o.length === 1, "an out says nothing");
}

console.log("\n— the words —");
{
  const t = await rows(`select * from public.push_text('spark', 'tr', '{"name":"ada","title":"mangal","when":"fri 20:00"}')`);
  check(t[0].title === "ada bir şey başlatıyor" && t[0].body === "mangal · fri 20:00", "turkish words", JSON.stringify(t[0]));
  const i = await rows(`select * from public.push_text('spark_in', 'de', '{"name":"berk","title":"x"}')`);
  check(i[0].title === "berk ist dabei", "german words");
}

console.log("\n— a broken push never stops a spark —");
{
  await asService();
  await db.exec(`alter table public.push_outbox add constraint push_outbox_no_spark check (kind <> 'spark') not valid`);
  await asUser(A);
  const id = (await rows(`select public.spark_create('derby', 'derby', now() + interval '1 day', null, 1) as id`))[0].id;
  check(Boolean(id), "the spark is created even when its push cannot be written");
  await asService();
  await db.exec(`alter table public.push_outbox drop constraint push_outbox_no_spark`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
