/* afterhours — travel groups: a route of cities and days, a passport page per leg (61) */

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
for (const d of ["../sql/44_groups.sql", "../sql/46_group_plans.sql", "../sql/47_group_nights.sql", "../sql/61_travel.sql", "../sql/61_travel.sql"]) {
  await db.exec(await read(d));
}

const [A, B, C, D] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222",
  "cccccccc-3333-3333-3333-333333333333", "dddddddd-4444-4444-4444-444444444444"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const one = async (sql) => (await db.query(sql)).rows[0];
const rows = async (sql) => (await db.query(sql)).rows;
const iso = (d) => d.toISOString().slice(0, 10);
const day = (n) => { const d = new Date(); d.setUTCHours(12, 0, 0, 0); d.setUTCDate(d.getUTCDate() + n); return d; };

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${C}','c@x'),('${D}','d@x')`);
for (const x of [B, C]) await db.exec(`insert into public.friendships (requester_id, addressee_id, status) values ('${A}', '${x}', 'accepted')`);
// two cities with nights (the seed has one: every other night moves to berlin); the nights of the
// first land on days 10 to 12, those of the second on 13 to 15, one of each far later
const c1 = (await one(`select city_slug from public.events_public group by city_slug order by count(*) desc limit 1`)).city_slug;
const c2 = "berlin";
const all = (await rows(`select id from public.events_public where city_slug = '${c1}' order by slug`)).map((r) => r.id);
await db.exec(`update public.events set city_id = (select id from public.cities where slug = '${c2}') where id in (${all.filter((_, i) => i % 2).map((x) => `'${x}'`).join(",")})`);
const n1 = (await rows(`select id from public.events_public where city_slug = '${c1}' order by slug`)).map((r) => r.id);
const n2 = (await rows(`select id from public.events_public where city_slug = '${c2}' order by slug`)).map((r) => r.id);
for (let i = 0; i < n1.length; i++) await db.exec(`update public.events set starts_at = '${iso(day(i === n1.length - 1 ? 40 : 10 + (i % 3)))}T22:00:00Z' where id = '${n1[i]}'`);
for (let i = 0; i < n2.length; i++) await db.exec(`update public.events set starts_at = '${iso(day(i === n2.length - 1 ? 41 : 13 + (i % 3)))}T22:00:00Z' where id = '${n2[i]}'`);

console.log("\n— a travel group —");
let g;
{
  await as(A);
  g = (await one(`select public.group_create('balkan nights', '🧳', 'gold', 'travel', null, null, null, array['${B}','${C}']::uuid[]) as g`)).g;
  check(Boolean(g), "a travel group is made like any group");
  const got = (await one(`select public.group_get('${g}') as j`)).j;
  check(got.kind === "travel" && Array.isArray(got.legs) && got.legs.length === 0, "group_get says travel, with no route yet");
  check(/friends, once or travel/.test(await fails(`select public.group_create('x', '🎧', 'red', 'cruise', null, null, null, null)`) ?? ""), "no other kind");
  const friends = (await one(`select public.group_create('cuma', '🎧', 'red', 'lasting', null, null, null, null) as g`)).g;
  check(/not a travel group/.test(await fails(`select public.group_legs_set('${friends}', '[{"city":"${c1}","from":"${iso(day(10))}","to":"${iso(day(12))}"}]')`) ?? ""), "a friends group has no route");
}

console.log("\n— the route —");
let legs;
{
  await as(A);
  check(/1 to 12/.test(await fails(`select public.group_legs_set('${g}', '[]')`) ?? ""), "at least one city");
  check(/unknown city/.test(await fails(`select public.group_legs_set('${g}', '[{"city":"atlantis","from":"${iso(day(10))}","to":"${iso(day(12))}"}]')`) ?? ""), "a city the app knows");
  check(/first and last day/.test(await fails(`select public.group_legs_set('${g}', '[{"city":"${c1}","from":"${iso(day(10))}"}]')`) ?? ""), "each city with both days");
  check(/last day comes after/.test(await fails(`select public.group_legs_set('${g}', '[{"city":"${c1}","from":"${iso(day(12))}","to":"${iso(day(10))}"}]')`) ?? ""), "the last day after the first");
  check(/order of travel/.test(await fails(`select public.group_legs_set('${g}', '[{"city":"${c2}","from":"${iso(day(13))}","to":"${iso(day(15))}"},{"city":"${c1}","from":"${iso(day(10))}","to":"${iso(day(12))}"}]')`) ?? ""), "in the order of travel");
  check(/yyyy-mm-dd/.test(await fails(`select public.group_legs_set('${g}', '[{"city":"${c1}","from":"soon","to":"later"}]')`) ?? ""), "days as dates");
  const n = (await one(`select public.group_legs_set('${g}', '[{"city":"${c1}","from":"${iso(day(10))}","to":"${iso(day(12))}"},{"city":"${c2}","from":"${iso(day(13))}","to":"${iso(day(15))}"}]') as n`)).n;
  check(n === 2, "two legs written");
  legs = await rows(`select * from public.group_legs('${g}')`);
  check(legs.length === 2 && legs[0].leg_no === 1 && legs[0].city_slug === c1 && legs[1].city_slug === c2, "group_legs in order with the city names", JSON.stringify(legs.map((l) => [l.leg_no, l.city_slug, l.city_name])));
  check(legs.every((l) => l.city_name && l.kept === 0 && l.photos === 0), "nothing kept, no photos yet");
  const got = (await one(`select public.group_get('${g}') as j`)).j;
  check(got.legs.length === 2 && got.legs[0].city === c1 && got.date_from === iso(day(10)) && got.date_to === iso(day(15)) && got.city_slug === null, "the group window follows the route");
  await as(B);
  check((await one(`select public.group_legs_set('${g}', '[{"city":"${c2}","from":"${iso(day(13))}","to":"${iso(day(15))}"}]') as n`)).n === 1, "any member may rewrite the route");
  await as(A);
  await db.exec(`select public.group_legs_set('${g}', '[{"city":"${c1}","from":"${iso(day(10))}","to":"${iso(day(12))}"},{"city":"${c2}","from":"${iso(day(13))}","to":"${iso(day(15))}"}]')`);
  legs = await rows(`select * from public.group_legs('${g}')`);
  await as(D);
  check(/not in this group/.test(await fails(`select * from public.group_legs('${g}')`) ?? ""), "a stranger sees no route");
  check(/not in this group/.test(await fails(`select public.group_legs_set('${g}', '[]')`) ?? ""), "nor writes one");
}

console.log("\n— the deck of a trip —");
{
  await as(A);
  const deck = await rows(`select id, city_slug, starts_at from public.group_deck('${g}', 100)`);
  const inLeg = (r) => {
    const d = r.starts_at.toISOString().slice(0, 10);
    return (r.city_slug === c1 && d >= iso(day(10)) && d <= iso(day(12))) || (r.city_slug === c2 && d >= iso(day(13)) && d <= iso(day(15)));
  };
  check(deck.length > 0 && deck.every(inLeg), "only nights of the legs on their days", JSON.stringify(deck.filter((r) => !inLeg(r)).slice(0, 2)));
  check(deck.some((r) => r.city_slug === c1) && deck.some((r) => r.city_slug === c2), "both cities in the deck");
  check(!deck.some((r) => r.id === n1.at(-1) || r.id === n2.at(-1)), "the nights after the trip are not");
}

console.log("\n— kept there, photos from there —");
{
  const first = (await one(`select id from public.events_public where city_slug = '${c1}' and starts_at::date = '${iso(day(10))}' order by slug limit 1`)).id;
  await as(A);
  await db.exec(`select public.group_swipe('${g}', '${first}', 'right')`);
  await as(B);
  await db.exec(`select public.group_swipe('${g}', '${first}', 'right')`);
  const kept = await rows(`select * from public.group_leg_nights('${g}', '${legs[0].id}')`);
  check(kept.length === 1 && kept[0].id === first && kept[0].yes === 2 && kept[0].members === 3 && kept[0].status === "most", "a night two of three kept, on the first leg", JSON.stringify(kept));
  check((await rows(`select * from public.group_leg_nights('${g}', '${legs[1].id}')`)).length === 0, "not on the second");
  check(/no such leg/.test(await fails(`select * from public.group_leg_nights('${g}', '${g}')`) ?? ""), "a leg of this group only");
  await asService();
  await db.exec(`insert into public.checkins (user_id, event_id) values ('${A}', '${first}'), ('${B}', '${first}')`);
  await as(B);
  await db.exec(`select public.group_photo_add('${g}', '${first}', '${B}/trip.jpg')`);
  const photos = await rows(`select * from public.group_leg_photos('${g}', '${legs[0].id}')`);
  check(photos.length === 1 && photos[0].mine === true && photos[0].event_id === first, "a photo from that night is on that leg");
  const again = await rows(`select * from public.group_legs('${g}')`);
  check(again[0].kept === 1 && again[0].photos === 1 && again[1].kept === 0, "group_legs counts them");
  // a night in the past stays on the passport
  await asService();
  await db.exec(`update public.events set starts_at = now() - interval '30 days' where id = '${first}'`);
  await as(A);
  await db.exec(`select public.group_legs_set('${g}', '[{"city":"${c1}","from":"${iso(day(-31))}","to":"${iso(day(-29))}"},{"city":"${c2}","from":"${iso(day(13))}","to":"${iso(day(15))}"}]')`);
  const past = await rows(`select * from public.group_legs('${g}')`);
  check(past[0].kept === 1, "a past leg keeps its nights (a trip is a memory)");
  check((await rows(`select * from public.group_matches('${g}')`)).every((m) => m.id !== first), "group_matches still looks ahead only");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
