/* afterhours — the night and after, for a group (47) */

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
                 "../sql/12_profiles.sql", "../sql/15_ticketmaster.sql", "../sql/18_geo.sql", "../sql/19_checkins.sql", "../sql/32_rsvp.sql"]) {
  await db.exec(await read(d));
}
await db.exec(`create or replace function public.is_guest() returns boolean language sql stable as $$
  select coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'is_anonymous')::boolean, false); $$;`);
for (const d of ["../sql/44_groups.sql", "../sql/46_group_plans.sql", "../sql/47_group_nights.sql", "../sql/47_group_nights.sql"]) await db.exec(await read(d));

const [A, B, C, D, E2] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222",
  "cccccccc-3333-3333-3333-333333333333", "dddddddd-4444-4444-4444-444444444444", "eeeeeeee-5555-5555-5555-555555555555"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const one = async (sql) => (await db.query(sql)).rows[0];
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${C}','c@x'),('${D}','d@x'),('${E2}','e@x')`);
for (const [x, y] of [[A, B], [A, C], [D, E2], [A, D]]) await db.exec(`insert into public.friendships (requester_id, addressee_id, status) values ('${x}', '${y}', 'accepted')`);
const ev = (await rows(`select e.id, v.name as venue from public.events e left join public.venues v on v.id = e.venue_id where e.venue_id is not null order by e.slug limit 4`));
await db.exec(`update public.events set starts_at = date_trunc('year', now()) + interval '10 days 23 hours' where id = '${ev[0].id}'`);
await db.exec(`update public.events set starts_at = date_trunc('year', now()) + interval '20 days 1 hour' where id = '${ev[1].id}'`);
await db.exec(`update public.events set starts_at = now() + interval '3 days' where id = '${ev[3].id}'`);
await as(A);
const g = (await one(`select public.group_create('Cuma', '🪩', 'red', 'lasting', null, null, null, array['${B}','${C}']::uuid[]) as g`)).g;
await as(D);
const other = (await one(`select public.group_create('Techno', '🎧', 'blue', 'lasting', null, null, null, array['${E2}']::uuid[]) as g`)).g;

await asService();
// night 0: all three were there; night 1: A and B; night 2: A alone (not a group night)
for (const [u, e] of [[A, 0], [B, 0], [C, 0], [A, 1], [B, 1], [A, 2]]) {
  await db.exec(`insert into public.checkins (user_id, event_id) values ('${u}', '${ev[e].id}')`);
}

console.log("\n— group nights —");
{
  await as(B);
  const n = await rows(`select * from public.group_nights('${g}')`);
  check(n.length === 2, "two nights with at least two of us; one alone does not count", String(n.length));
  const all = n.find((x) => x.id === ev[0].id);
  check(all.all_of_us && all.people.length === 3 && all.people.every((p) => p.card), "all of us, with our card numbers");
  check(!n.find((x) => x.id === ev[1].id).all_of_us, "two of three: not all of us");
  await as(D);
  check(Boolean(await fails(`select * from public.group_nights('${g}')`)), "a stranger sees none of it");
}

console.log("\n— the album —");
let ph;
{
  await as(B);
  ph = (await one(`select public.group_photo_add('${g}', '${ev[0].id}', '${B}/g1.jpg') as id`)).id;
  check(Boolean(ph), "a member adds a photo to a group night");
  check(/not your file/.test(await fails(`select public.group_photo_add('${g}', '${ev[0].id}', '${A}/x.jpg')`) ?? ""), "only from your own folder");
  check(/only nights/.test(await fails(`select public.group_photo_add('${g}', '${ev[2].id}', '${B}/x.jpg')`) ?? ""), "not to a night the group did not go to");
  await db.exec(`select public.plan_set('${g}', '${ev[3].id}')`);
  check((await fails(`select public.group_photo_add('${g}', '${ev[3].id}', '${B}/plan.jpg')`)) === null, "but to the plan, yes");
  await as(C);
  const album = await rows(`select * from public.group_album('${g}', '${ev[0].id}')`);
  check(album.length === 1 && album[0].name === "b" && !album[0].mine, "the others see it");
  check((await rows(`select photos, cover from public.group_nights('${g}') where id = '${ev[0].id}'`))[0].cover === `${B}/g1.jpg`, "the first photo is the night's cover on the shelf");
  check(/owner/.test(await fails(`select public.group_photo_remove('${ph}')`) ?? ""), "C cannot take B's photo out");
  await as(A);
  check((await one(`select public.group_photo_remove('${ph}') as p`)).p === `${B}/g1.jpg`, "the owner can");
}

console.log("\n— numbers and the vibe —");
{
  await as(B);
  await db.exec(`select public.group_swipe('${g}', '${ev[3].id}', 'right')`);
  const s = (await one(`select public.group_stats('${g}') as s`)).s;
  check(s.nights === 2 && s.nights_year === 2, "two nights together, both this year", JSON.stringify(s));
  check(s.regular && ["a", "b"].includes(s.regular.name) && s.regular.n === 2, "who comes most");
  check(s.room === ev[0].venue || s.room === ev[1].venue, "the room you go to");
  check(Array.isArray(s.kinds) && s.kinds.length >= 1, "the kinds you say yes to");
  check(typeof s.hour === "number", "and the hour your nights start", String(s.hour));
}

console.log("\n— also there —");
{
  await as(D);
  await db.exec(`select public.plan_set('${other}', '${ev[3].id}')`);
  await as(A);
  check((await rows(`select * from public.group_also_there('${g}')`)).length === 0, "an invisible group is not shown");
  await as(B);
  check(/owner/.test(await fails(`select public.group_set_visible('${g}', true)`) ?? ""), "only the owner makes a group visible");
  await as(D);
  await db.exec(`select public.group_set_visible('${other}', true)`);
  await as(A);
  const also = await rows(`select * from public.group_also_there('${g}')`);
  check(also.length === 1 && also[0].name === "Techno" && also[0].friends.join() === "d", "visible, same plan, a friend in it: shown, with the friend", JSON.stringify(also));
  await as(C);
  check((await rows(`select * from public.group_also_there('${g}')`)).length === 0, "C has no friend in it: not shown to C");
  check((await one(`select public.group_get('${g}') as j`)).j.visible === false, "group_get says whether it is visible");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
