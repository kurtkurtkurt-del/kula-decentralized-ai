/* afterhours — a changed or cancelled night tells the people on it (72) */

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
await db.exec(await read("../sql/72_night_changed.sql"));

const [A, B, C, D] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222",
                      "cccccccc-3333-3333-3333-333333333333", "dddddddd-4444-4444-4444-444444444444"];
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const rows = async (sql) => (await db.query(sql)).rows;
const outbox = async (user) => rows(`select key, data from public.push_outbox where user_id = '${user}' and kind = 'night_changed' order by id`);

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${C}','c@x'),('${D}','d@x')`);
await db.exec(`update public.profile_settings set locale = 'tr' where user_id = '${B}'`);
await db.exec(`update public.profile_settings set locale = 'de' where user_id = '${C}'`);
const city = (await rows(`select id from public.cities limit 1`))[0].id;
const type = (await rows(`select id from public.event_types limit 1`))[0].id;
const ev = (await rows(`insert into public.events (slug, city_id, type_id, title, meta, starts_at, source, external_id)
  values ('tm-night', '${city}', '${type}', 'Big Night', 'x', now() + interval '10 days', 'ticketmaster', 'tm-n') returning id`))[0].id;
/* A kept it, B answered in, C holds a ticket, D has nothing to do with it */
await db.exec(`insert into public.swipes (user_id, event_id, direction) values ('${A}', '${ev}', 'right')`);
await db.exec(`insert into public.rsvps (user_id, event_id, answer) values ('${B}', '${ev}', 'in')`);
await db.exec(`insert into public.tickets (user_id, event_id, answer) values ('${C}', '${ev}', 'got')`);

console.log("\n— the night moves —");
{
  await db.exec(`update public.events set starts_at = now() + interval '17 days' where id = '${ev}'`);
  const a = await outbox(A), b = await outbox(B), c = await outbox(C), d = await outbox(D);
  check(a.length === 1 && /moved to/.test(a[0].data.what) && a[0].data.title === "Big Night", "the one who kept it: moved to, in english", JSON.stringify(a));
  check(b.length === 1 && /tarihine alındı/.test(b[0].data.what), "the one who answered in: in turkish", JSON.stringify(b));
  check(c.length === 1 && /verlegt auf/.test(c[0].data.what), "the one with a ticket: in german");
  check(d.length === 0, "nobody else");
  await db.exec(`update public.events set meta = 'y' where id = '${ev}'`);
  check((await outbox(A)).length === 1, "an unrelated change says nothing");
}

console.log("\n— the night is cancelled —");
{
  await db.exec(`update public.events set status = 'cancelled', is_published = false where id = '${ev}'`);
  const a = await outbox(A);
  check(a.length === 2 && a[1].data.what === "cancelled", "cancelled: one more push", JSON.stringify(a));
  await db.exec(`update public.events set status = 'cancelled' where id = '${ev}'`);
  check((await outbox(A)).length === 2, "saying cancelled twice is one push");
  check(Boolean(await (async () => { try { await db.exec(`update public.events set status = 'gone' where id = '${ev}'`); return null; } catch (e) { return e.message; } })()), "only the five statuses");
  const words = await rows(`select * from public.push_text('night_changed', 'tr', '{"title":"Big Night","what":"iptal edildi"}')`);
  check(words[0].title === "Big Night" && words[0].body === "iptal edildi", "the push words carry the phrase, never a member text");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
