/* afterhours — words the staff want to see (79): watched, not refused */

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
await db.exec(await read("../sql/79_word_watch.sql"));

const [A, B, C, CM] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222",
                       "cccccccc-3333-3333-3333-333333333333", "dddddddd-4444-4444-4444-444444444444"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const rows = async (sql) => (await db.query(sql)).rows;
const open = async () => { await as(CM); return rows(`select kind, target, reasons, preview from public.staff_reports()`); };

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${C}','c@x'),('${CM}','cm@x')`);
await db.exec(`update public.profiles set handle = 'ada', is_admin = true where id = '${A}'`);
await db.exec(`update public.profiles set handle = 'berk' where id = '${B}'`);
await db.exec(`update public.profiles set handle = 'cansu' where id = '${C}'`);
await db.exec(`update public.profiles set account_type = 'community_manager' where id = '${CM}'`);
const night = (await rows(`select id, slug from public.events where is_published limit 1`))[0];

console.log("\n— written, kept, flagged —");
{
  await asService();
  await db.exec(`insert into public.comments (event_id, author_id, author_name, body) values ('${night.id}', '${B}', 'berk', 'see you there, slut'), ('${night.id}', '${C}', 'cansu', 'see you there')`);
  check((await rows(`select 1 from public.comments where author_id = '${B}'`)).length === 1, "the line is written, not refused");
  const o = await open();
  check(o.length === 1 && o[0].kind === "comment" && o[0].reasons[0] === "filter: slut", "and sits in the open reports with the word", JSON.stringify(o));
  await asService();
  check(!(await rows(`select 1 from public.reports r join public.comments c on c.id::text = r.target where c.author_id = '${C}'`)).length, "the clean one does not");
  await asService();
  await db.exec(`insert into public.comments (event_id, author_id, author_name, body) values ('${night.id}', '${C}', 'cansu', 'scunthorpe fans, assemble')`);
  check((await open()).length === 1, "a word inside another word is not a hit");
}

console.log("\n— every place —");
{
  await asService();
  const thread = (await rows(`insert into public.dm_threads (a, b) values ('${B}', '${C}') returning id`))[0].id;
  await db.exec(`insert into public.dm_messages (thread_id, user_id, body) values ('${thread}', '${C}', 'geber artık')`);
  await db.exec(`insert into public.room_posts (event_id, user_id, body) values ('${night.id}', '${B}', 'fine line')`);
  await db.exec(`update public.room_posts set body = 'du Schwuchtel' where user_id = '${B}'`);
  await db.exec(`update public.profiles set bio = 'kys all' where id = '${C}'`);
  const kinds = (await open()).map((r) => r.kind).sort();
  check(JSON.stringify(kinds) === JSON.stringify(["comment", "dm_message", "profile", "room_post"]), "a dm, an edited room line and a bio all arrive", kinds.join(","));
  await asService();
  await db.exec(`insert into public.posts (author_id, body) values ('${B}', 'orospu çocuğu bu dj')`);
  check((await rows(`select reason from public.post_reports where reporter_id = '${B}'`))[0]?.reason === "filter: orospu", "a post goes to the post reports");
}

console.log("\n— the list —");
{
  await as(B);
  check(Boolean(await fails(`select public.watch_add('bogus')`)), "an ordinary person cannot add a word");
  await as(A);
  await db.exec(`select public.watch_add('Bogus ')`);
  await as(CM);
  check((await rows(`select * from public.watch_list() w where w = 'bogus'`)).length === 1, "the admin adds one, the staff see it lowercased");
  await asService();
  await db.exec(`insert into public.comments (event_id, author_id, author_name, body) values ('${night.id}', '${C}', 'cansu', 'that was bogus')`);
  check((await open()).some((r) => r.reasons[0] === "filter: bogus"), "and it catches from then on");
  await as(A);
  await db.exec(`select public.watch_drop('bogus')`);
  await as(CM);
  check((await rows(`select * from public.watch_list() w where w = 'bogus'`)).length === 0, "dropped again");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
