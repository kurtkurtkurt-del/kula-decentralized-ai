/* afterhours — a check-in that means something (88) */

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
await db.exec(await read("../sql/88_checkin_truth.sql"));

const [A, B] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const rows = async (sql) => (await db.query(sql)).rows;
const pushes = async (who) => {
  await asService();
  const r = await rows(`select key from public.push_outbox where user_id = '${who}' and kind = 'friend_live'`);
  await as(A);
  return r;
};
/* the table is closed to browsers; the rows are read at service level and the role put back */
const liveOf = async (slug) => {
  await asService();
  const r = (await rows(`select c.live from public.checkins c join public.events e on e.id = c.event_id where e.slug = '${slug}' and c.user_id = '${A}'`))[0]?.live;
  await as(A);
  return r;
};

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x')`);
await db.exec(`update public.profiles set handle = 'ada' where id = '${A}'`);
await db.exec(`update public.profiles set handle = 'berk' where id = '${B}'`);
await db.exec(`insert into public.friendships (requester_id, addressee_id, status) values ('${A}','${B}','accepted')`);
const city = (await rows(`select id from public.cities order by sort_order limit 1`))[0].id;
const type = (await rows(`select id from public.event_types limit 1`))[0].id;
await db.exec(`insert into public.events (slug, city_id, type_id, title, meta, starts_at, lat, lng, image_url) values
  ('tonight',  '${city}', '${type}', 'Tonight',  'x', now() + interval '2 hours',  48.137, 11.575, 'https://img/1.jpg'),
  ('nextweek', '${city}', '${type}', 'Next week','x', now() + interval '6 days',   48.137, 11.575, 'https://img/2.jpg'),
  ('blind',    '${city}', '${type}', 'No place', 'x', now() + interval '1 hour',   null,   null,   'https://img/3.jpg'),
  ('faraway',  '${city}', '${type}', 'Far',      'x', now() + interval '1 hour',   48.137, 11.575, 'https://img/4.jpg')`);

console.log("\n— live or not —");
{
  await as(A);
  await db.exec(`select public.check_in('tonight', 48.138, 11.576)`);
  check(await liveOf("tonight") === true, "in the window, at the door: live");
  check((await pushes(B)).length === 1, "and the friend hears");
  await db.exec(`select public.check_in('nextweek')`);
  check(await liveOf("nextweek") === false, "six days early: a card, not live");
  await db.exec(`select public.check_in('faraway', 52.52, 13.40)`);
  check(await liveOf("faraway") === false, "four hundred kilometres away: a card, not live");
  await db.exec(`select public.check_in('blind', 52.52, 13.40)`);
  check(await liveOf("blind") === true, "a night without a position is not tested");
  check((await pushes(B)).length === 2, "only the live ones reached the friend", String((await pushes(B)).length));
  await asService();
  const lat = (await rows(`select c.lat from public.checkins c join public.events e on e.id = c.event_id where e.slug = 'tonight'`))[0].lat;
  check(Math.abs(lat - 48.138) < 1e-6, "the position is kept on the row");
  await as(B);
  const seen = (await rows(`select slug from public.friends_live()`)).map((r) => r.slug).sort();
  check(JSON.stringify(seen) === JSON.stringify(["blind", "tonight"]), "friends_live lists the live ones only", seen.join(","));
}

console.log("\n— taking it back —");
{
  await as(A);
  check((await rows(`select public.check_out('tonight') as k`))[0].k === true, "within the hour it comes back");
  check(await liveOf("tonight") === undefined, "the card is gone");
  await asService();
  check((await pushes(B)).length === 1, "and the push that had not left went with it");
  await as(A);
  check((await rows(`select public.check_out('nowhere') as k`))[0].k === false, "nothing to take back is just false");
  await asService();
  await db.exec(`update public.checkins set checked_at = now() - interval '2 hours' where user_id = '${A}'`);
  await as(A);
  check(/toolate/.test(await fails(`select public.check_out('blind')`) ?? ""), "after an hour it stays");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
