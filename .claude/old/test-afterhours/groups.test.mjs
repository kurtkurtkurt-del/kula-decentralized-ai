/* afterhours — groups: friends who find a night together (44) */

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
                 "../sql/12_profiles.sql", "../sql/15_ticketmaster.sql", "../sql/18_geo.sql"]) {
  await db.exec(await read(d));
}
await db.exec(`create or replace function public.is_guest() returns boolean language sql stable as $$
  select coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'is_anonymous')::boolean, false); $$;`);
await db.exec(await read("../sql/44_groups.sql"));
await db.exec(await read("../sql/44_groups.sql"));

const [A, B, C, D, S] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222",
  "cccccccc-3333-3333-3333-333333333333", "dddddddd-4444-4444-4444-444444444444", "eeeeeeee-5555-5555-5555-555555555555"];
const as = (id, guest = false) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"${guest ? ',"is_anonymous":true' : ""}}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const one = async (sql) => (await db.query(sql)).rows[0];
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x'),('${C}','c@x'),('${D}','d@x'),('${S}','s@x')`);
for (const x of [B, C]) await db.exec(`insert into public.friendships (requester_id, addressee_id, status) values ('${A}', '${x}', 'accepted')`);
// The nights are in the past in the seed; move them ahead so the window shows them.
await db.exec(`update public.events set starts_at = now() + (row_number_hack.n || ' days')::interval
  from (select id, row_number() over (order by slug) as n from public.events) row_number_hack where row_number_hack.id = events.id`);
const city = (await one(`select city_slug from public.events_public group by city_slug order by count(*) desc limit 1`)).city_slug;
const nights = (await rows(`select id from public.events_public where city_slug = '${city}' order by slug`)).map((r) => r.id);
// B already kept the last one on their own: the group should see it first.
await db.exec(`insert into public.swipes (user_id, event_id, direction) values ('${B}', '${nights.at(-1)}', 'right')`);

console.log("\n— making a group —");
let g;
{
  await as(A);
  check(/friends/.test(await fails(`select public.group_create('x', '🎧', 'red', 'lasting', null, null, null, array['${D}']::uuid[])`) ?? ""), "only friends can be put in directly");
  g = (await one(`select public.group_create('Cuma ekibi', '🪩', 'gold', 'lasting', '${city}', null, null, array['${B}','${C}']::uuid[]) as g`)).g;
  check(Boolean(g), "a lasting group with two friends");
  check(/last day/.test(await fails(`select public.group_create('Bu cumartesi', '🎉', 'red', 'once', null, null, null, null)`) ?? ""), "a once group needs its last day");
  check(Boolean(await fails(`select * from public.groups`)), "the table itself is closed");
  await as(D);
  check(/not in this group/.test(await fails(`select public.group_get('${g}')`) ?? ""), "a stranger cannot read it");
  check(Boolean(await fails(`select * from public.group_deck('${g}', 10)`)), "nor its deck");
  await as(S, true);
  check(/account/.test(await fails(`select public.group_create('g', '🎧', 'red', 'lasting', null, null, null, null)`) ?? ""), "a guest makes an account first");
  await as(B);
  const got = (await one(`select public.group_get('${g}') as j`)).j;
  check(got.members.length === 3 && got.members[0].role === "owner", "members see the group, the maker as owner");
}

console.log("\n— the link —");
let code;
{
  await as(B);
  code = (await one(`select public.group_invite('${g}') as c`)).c;
  check(/^[A-HJ-NP-Z2-9]{8}$/.test(code), "an 8-letter code", code);
  check((await one(`select public.group_invite('${g}') as c`)).c === code, "the same code while it is good");
  await as(D);
  const peek = await one(`select * from public.group_peek('${code.toLowerCase()}')`);
  check(peek && peek.name === "Cuma ekibi" && peek.members === 3 && !peek.mine, "a stranger with the code sees what it is");
  check((await one(`select public.group_join(' ${code} ') as g`)).g === g, "and joins");
  check((await one(`select public.group_join('${code}') as g`)).g === g, "joining twice is harmless");
  check(/no group/.test(await fails(`select public.group_join('ZZZZZZZZ')`) ?? ""), "a wrong code");
  await asService();
  await db.exec(`update public.group_invites set expires_at = now() - interval '1 minute' where code = '${code}'`);
  await as(S, true);
  check(/account/.test(await fails(`select public.group_join('${code}')`) ?? ""), "a guest cannot join");
}

console.log("\n— swiping together —");
{
  await as(A);
  const deck = await rows(`select id from public.group_deck('${g}', 100)`);
  check(deck.length === nights.length, "the deck is the group's city", `${deck.length} vs ${nights.length}`);
  check(deck[0].id === nights.at(-1), "a night a member kept alone comes first");
  for (const who of [A, B, C, D]) { await as(who); await db.exec(`select public.group_swipe('${g}', '${nights[0]}', 'right')`); }
  await as(A); await db.exec(`select public.group_swipe('${g}', '${nights[1]}', 'right')`);
  await as(B); await db.exec(`select public.group_swipe('${g}', '${nights[1]}', 'right')`);
  await as(C); await db.exec(`select public.group_swipe('${g}', '${nights[1]}', 'right')`);
  await as(D); await db.exec(`select public.group_swipe('${g}', '${nights[1]}', 'left')`);
  await as(A); await db.exec(`select public.group_swipe('${g}', '${nights[2]}', 'right')`);
  await as(A);
  const m = await rows(`select id, status, yes, no from public.group_matches('${g}')`);
  check(m[0].id === nights[0] && m[0].status === "match", "everyone said yes: a match");
  check(m[1].status === "most" && m[1].yes === 3 && m[1].no === 1, "three of four: most");
  check(m[2].status === "some", "one of four: some");
  check((await rows(`select * from public.group_deck('${g}', 100)`)).length === nights.length - 3, "answered nights leave your deck");
  await db.exec(`select public.group_unswipe('${g}', '${nights[2]}')`);
  check((await rows(`select * from public.group_matches('${g}')`)).length === 2, "undo takes the answer back");
  const votes = await rows(`select * from public.group_votes('${g}', '${nights[1]}')`);
  check(votes.find((v) => v.user_id === D).direction === "left", "members see who said what");
  await asService();
  check((await one(`select count(*)::int as n from public.swipes where user_id = '${A}'`)).n === 0, "the personal deck is not touched");
  await as(A);
  const mine = await one(`select * from public.my_groups()`);
  check(mine.members === 4 && mine.matches === 1 && mine.to_swipe === nights.length - 2, "the list counts members, matches and what is left", JSON.stringify(mine));
}

console.log("\n— live —");
{
  await as(A); await db.exec(`select public.group_live_here('${g}')`);
  await as(B); await db.exec(`select public.group_live_here('${g}')`);
  let st = (await one(`select public.group_live_state('${g}') as s`)).s;
  const first = st.card.id;
  check(st.people.length === 2 && first !== nights[0] && first !== nights[1], "two are there; the card is one not both answered", JSON.stringify(st.people));
  await as(A); await db.exec(`select public.group_swipe('${g}', '${first}', 'right')`);
  st = (await one(`select public.group_live_state('${g}') as s`)).s;
  check(st.card.id === first && st.people.find((p) => p.id === A).answer === "right", "one answered: the card waits, the answer shows");
  await as(B); await db.exec(`select public.group_swipe('${g}', '${first}', 'left')`);
  st = (await one(`select public.group_live_state('${g}') as s`)).s;
  check(st.card.id !== first, "both answered: the next card");
  const second = st.card.id;
  await db.exec(`select public.group_live_skip('${g}', '${second}')`);
  st = (await one(`select public.group_live_state('${g}') as s`)).s;
  check(st.card.id !== second, "a skip moves everyone on");
  await asService();
  await db.exec(`update public.group_live set seen_at = now() - interval '2 minutes' where user_id = '${B}'`);
  await as(A);
  st = (await one(`select public.group_live_state('${g}') as s`)).s;
  check(st.people.length === 1, "who stopped calling is no longer counted");
  check((await one(`select live from public.my_groups()`)).live === 1, "the list shows someone is live");
}

console.log("\n— leaving, the owner, once groups —");
{
  await as(B);
  check(/owner/.test(await fails(`select public.group_remove('${g}', '${C}')`) ?? ""), "only the owner takes someone out");
  await as(A);
  await db.exec(`select public.group_remove('${g}', '${D}')`);
  check((await one(`select public.group_get('${g}') as j`)).j.members.length === 3, "the owner takes someone out");
  check((await rows(`select * from public.group_matches('${g}')`))[0].status === "match", "their answers leave the counts");
  await db.exec(`select public.group_leave('${g}')`);
  await as(B);
  const after = (await one(`select public.group_get('${g}') as j`)).j.members;
  check(after.find((m) => m.id === B).role === "owner", "the owner leaves: the oldest becomes owner", JSON.stringify(after));
  const once = (await one(`select public.group_create('Bu cumartesi', '🎉', 'red', 'once', null, current_date, current_date + 1, null) as g`)).g;
  await asService();
  await db.exec(`update public.groups set date_to = current_date - 1, date_from = current_date - 2 where id = '${once}'`);
  await as(B);
  const list = await rows(`select id, archived from public.my_groups()`);
  check(list.at(-1).id === once && list.at(-1).archived, "a once group whose days are over is archived, at the end");
  await db.exec(`select public.group_leave('${once}')`);
  await asService();
  check(!(await one(`select 1 as x from public.groups where id = '${once}'`)), "the last one out takes the group along");
  await as(B);
  check(/your file/.test(await fails(`select public.group_set_cover('${g}', '${A}/x.jpg')`) ?? ""), "a cover only from your own folder");
  check((await fails(`select public.group_set_cover('${g}', '${B}/cover.jpg')`)) === null, "your own photo as the cover");
}

console.log("\n— a group to make —");
{
  await asService();
  await db.exec(`insert into public.swipes (user_id, event_id, direction) values ('${A}', '${nights[3]}', 'right'), ('${A}', '${nights.at(-1)}', 'right'), ('${B}', '${nights[3]}', 'right')`);
  await as(A);
  const s = await rows(`select * from public.group_suggest()`);
  check(s.length === 1 && s[0].user_id === B && s[0].shared === 2, "a friend who kept the same nights", JSON.stringify(s));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
