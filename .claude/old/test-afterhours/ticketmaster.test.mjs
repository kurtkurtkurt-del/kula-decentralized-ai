/* afterhours — the Ticketmaster columns and the worldwide deck (15). */

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
                 "../sql/11_world.sql", "../sql/15_ticketmaster.sql",
                 "../sql/16_coverage.sql"]) {
  await db.exec(await read(d));
}
console.log("\n— schema + world + ticketmaster loaded —");

const ME = "11111111-1111-1111-1111-111111111111";
const FRIEND = "22222222-2222-2222-2222-222222222222";

await db.exec(`
  insert into auth.users (id, email) values
    ('${ME}', 'ben@example.com'), ('${FRIEND}', 'lena@example.com');
  update public.profiles set handle = 'ben'  where id = '${ME}';
  update public.profiles set handle = 'lena' where id = '${FRIEND}';
  insert into public.friendships (requester_id, addressee_id, status)
  values ('${ME}', '${FRIEND}', 'accepted');
`);

const asUser = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);

console.log("\n— the columns —");
{
  await asService();
  const r = await db.query(`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'events'
      and column_name in ('source', 'external_id', 'image_url', 'ticket_url')`);
  check(r.rows.length === 4, "events carries the four new columns", `got ${r.rows.length}`);

  const v = await db.query(`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'events_public'
      and column_name in ('source', 'image_url', 'ticket_url')`);
  check(v.rows.length === 3, "the view hands the screen what it needs", `got ${v.rows.length}`);

  const s = await db.query(`select count(*)::int as n from public.events where source = 'seed'`);
  const all = await db.query(`select count(*)::int as n from public.events`);
  check(s.rows[0].n === all.rows[0].n, "every existing night defaults to source = seed");
}

console.log("\n— the coverage —");
{
  await asService();
  const eu = await db.query(`select count(*)::int as n from public.cities where continent_slug = 'eu'`);
  check(eu.rows[0].n >= 59, "Europe is all there", `got ${eu.rows[0].n}`);

  const named = await db.query(`
    select count(*)::int as n from public.cities
    where slug in ('london', 'paris', 'amsterdam', 'singapore', 'dubai', 'los-angeles', 'miami')`);
  check(named.rows[0].n === 7, "the new coverage cities exist");

  const munchen = await db.query(`select sort_order from public.cities where slug = 'munchen'`);
  check(munchen.rows[0].sort_order === 1, "münchen still leads the list");
}

console.log("\n— a synced night —");
{
  await asService();
  await db.exec(`
    insert into public.events
      (slug, city_id, type_id, title, meta, body, starts_at, starts_at_estimated,
       source, external_id, image_url, ticket_url)
    select 'test-night-abc12345', c.id, t.id, 'Test Night',
           'Somewhere · 11.09.99 · 21:00', 'A synced night.',
           '2099-09-11T21:00:00', false,
           'ticketmaster', 'TMABC123', 'https://img.example/x.jpg',
           'https://tickets.example/x'
    from public.cities c, public.event_types t
    where c.slug = 'tokyo' and t.slug = 'rave';
  `);
  const r = await db.query(`select image_url, source from public.events_public where slug = 'test-night-abc12345'`);
  check(r.rows[0] && r.rows[0].image_url === "https://img.example/x.jpg",
    "a night without a drawn poster carries its photograph");

  let dup = null;
  try {
    await db.exec(`
      insert into public.events (slug, city_id, type_id, title, meta, source, external_id)
      select 'test-night-other', c.id, t.id, 'Same Night', 'x', 'ticketmaster', 'TMABC123'
      from public.cities c, public.event_types t
      where c.slug = 'tokyo' and t.slug = 'rave'`);
  } catch (e) { dup = e.message; }
  check(Boolean(dup), "one external_id, one row — the upsert can conflict on it");
}

console.log("\n— the deck serves the world —");
{
  await asAnon();
  const home = await db.query(`select count(*)::int as n from public.deck()`);
  check(home.rows[0].n === 36, "no arguments still means munchen (36)", `got ${home.rows[0].n}`);

  const world = await db.query(`select count(distinct city_slug)::int as n from public.deck(null, null, 500)`);
  check(world.rows[0].n > 50, "a null city deals every city", `got ${world.rows[0].n} cities`);

  const order = await db.query(`select slug, poster_no from public.deck(null, null, 500)`);
  const last = order.rows[order.rows.length - 1];
  check(order.rows[0].poster_no === 1 && last.poster_no === null,
    "drawn posters keep their order, synced nights follow them");

  const tokyo = await db.query(`select slug from public.deck('tokyo', 'rave', 500)`);
  check(tokyo.rows.some((x) => x.slug === "test-night-abc12345"),
    "city and kind still filter the synced night in");
}

console.log("\n— swiping and friends still work on it —");
{
  await asUser(FRIEND);
  await db.exec(`select public.swipe_set('test-night-abc12345', 'right')`);

  await asUser(ME);
  const r = await db.query(`select slug, image_url from public.friends_kept()`);
  check(r.rows.length === 1 && r.rows[0].image_url === "https://img.example/x.jpg",
    "friends_kept carries the photograph too");

  await asUser(FRIEND);
  const deck = await db.query(`select slug from public.deck('tokyo', null, 500)`);
  check(!deck.rows.some((x) => x.slug === "test-night-abc12345"),
    "a swiped synced night does not come back");
}

console.log("\n— the browser still cannot write events —");
{
  await asUser(ME);
  let err = null;
  try {
    await db.exec(`update public.events set title = 'hacked' where slug = 'test-night-abc12345'`);
    const r = await db.query(`select title from public.events where slug = 'test-night-abc12345'`);
    if (r.rows[0].title === "hacked") err = null; else err = "no-op";
  } catch (e) { err = e.message; }
  check(Boolean(err), "a signed-in non-admin cannot rewrite a synced night");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
