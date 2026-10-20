/* afterhours — feedback: everyone writes, only the admin reads */

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
                 "../sql/06_views.sql", "../sql/07_friends.sql",
                 "../sql/12_profiles.sql", "../sql/13_feedback.sql"]) {
  await db.exec(await read(d));
}

const A = "aaaaaaaa-1111-1111-1111-111111111111";   /* yonetici */
const B = "bbbbbbbb-2222-2222-2222-222222222222";   /* an ordinary person */

const asUser = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);

await asService();
await db.exec(`
  insert into auth.users (id, email) values ('${A}', 'a@x.com'), ('${B}', 'b@x.com');
  update public.profiles set handle = 'ada', is_admin = true where id = '${A}';
  update public.profiles set handle = 'lena' where id = '${B}';
`);

console.log("\n— everyone can write —");
{
  await asAnon();
  await db.exec(`insert into public.feedback (kind, body, contact)
                 values ('broken', 'the deck stops after four cards', 'someone@example.com')`);
  check(true, "someone signed out can write");

  await asUser(B);
  /* a breath between the two, so "newest on top" does not depend on the clock's
     resolution (both landed in the same millisecond when the whole gate ran) */
  await new Promise((ok) => setTimeout(ok, 5));
  await db.exec(`insert into public.feedback (kind, body)
                 values ('idea', 'let me undo the last swipe, just before')`);
  check(true, "someone signed in can write");
}

console.log("\n— the limits —");
{
  await asUser(B);
  let tooShort = null;
  try { await db.exec(`insert into public.feedback (body) values ('no')`); }
  catch (e) { tooShort = e.message; }
  check(Boolean(tooShort), "a message that is too short is refused");

  let kind = null;
  try { await db.exec(`insert into public.feedback (kind, body) values ('spam', 'here is another message')`); }
  catch (e) { kind = e.message; }
  check(Boolean(kind), "an unknown kind is refused");

  let forged = null;
  try {
    await db.exec(`insert into public.feedback (author_id, body)
                   values ('${A}', 'baskasinin adina yazilan one mesaj')`);
  } catch (e) { forged = e.message; }
  check(Boolean(forged), "you cannot write in someone else's name");

  /* handled is the admin's mark. If a writer could send it along, the
     message would arrive already filed away and never be seen. */
  let preHandled = null;
  try {
    await db.exec(`insert into public.feedback (body, handled)
                   values ('mark this one done already', true)`);
  } catch (e) { preHandled = e.message; }
  check(Boolean(preHandled), "handled is not the writer's to send");
}

console.log("\n— only the admin reads —");
{
  /* A signed-out reader was never GRANTED read at all: it is the
     privilege stopping them, not a policy. So an error is the right result. */
  await asAnon();
  let anonError = null, anonSatir = null;
  try {
    const a = await db.query(`select count(*)::int as n from public.feedback`);
    anonSatir = a.rows[0].n;
  } catch (e) { anonError = e.message; }
  check(anonError !== null || anonSatir === 0, "signed out, nothing is visible",
    "it saw " + anonSatir);

  await asUser(B);
  const b = await db.query(`select count(*)::int as n from public.feedback`);
  check(b.rows[0].n === 0, "even the writer cannot read their own back", "it saw " + b.rows[0].n);

  await asUser(A);
  const y = await db.query(`select count(*)::int as n from public.feedback`);
  check(y.rows[0].n === 2, "the admin sees all of it", "it saw " + y.rows[0].n);
}

console.log("\n— the admin list —");
{
  await asUser(A);
  const l = await db.query(`select * from public.feedback_list(10)`);
  check(l.rows.length === 2, "list geliyor");
  check(l.rows[0].kind === "idea", "the newest one is on top");
  check(l.rows[0].author === "lena", "the signed-in writer resolves to a name");
  check(l.rows[1].author === null && l.rows[1].contact === "someone@example.com",
    "the signed-out one has no name, only the contact they left");

  await db.exec(`update public.feedback set handled = true where kind = 'idea'`);
  const s = await db.query(`select count(*)::int as n from public.feedback where handled`);
  check(s.rows[0].n === 1, "the admin can mark one handled");

  await asUser(B);
  await db.exec(`update public.feedback set handled = true`);
  const k = await db.query(`select count(*)::int as n from public.feedback where handled`);
  await asUser(A);
  const t = await db.query(`select count(*)::int as n from public.feedback where handled`);
  check(t.rows[0].n === 1, "an ordinary person cannot mark one");
}

console.log("\n— when the account is deleted —");
{
  await asUser(B);
  await db.exec(`select public.delete_account()`);
  await asUser(A);
  const l = await db.query(`select author, body from public.feedback_list(10)`);
  check(l.rows.length === 2, "what they wrote stays");
  check(l.rows[0].author === null, "the name fell away");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
