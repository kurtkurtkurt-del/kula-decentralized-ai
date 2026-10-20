/* afterhours — a night that happened stays (66): retired, not deleted; pruned only when untouched */

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
await db.exec(await read("../sql/66_keep_past_nights.sql"));

const A = "aaaaaaaa-1111-1111-1111-111111111111";
const asUser = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
const city = (await rows(`select id, slug from public.cities order by sort_order limit 1`))[0];
const type = (await rows(`select id from public.event_types limit 1`))[0].id;
await db.exec(`
  insert into auth.users (id, email) values ('${A}', 'a@x.com');
  update public.profiles set handle = 'ada' where id = '${A}';
  insert into public.events (slug, city_id, type_id, title, meta, starts_at, image_url, source, external_id) values
    ('kept-old',    '${city.id}', '${type}', 'Kept, long ago',   'x', now() - interval '500 days', 'https://img/k.jpg', 'ticketmaster', 'tm-1'),
    ('untouched',   '${city.id}', '${type}', 'Nobody, long ago', 'x', now() - interval '500 days', 'https://img/u.jpg', 'ticketmaster', 'tm-2'),
    ('recent-past', '${city.id}', '${type}', 'Last week',        'x', now() - interval '7 days',   'https://img/r.jpg', 'ticketmaster', 'tm-3'),
    ('ours-old',    '${city.id}', '${type}', 'Our own, long ago','x', now() - interval '500 days', 'https://img/o.jpg', 'seed', null);
  insert into public.checkins (user_id, event_id) select '${A}', id from public.events where slug = 'kept-old';
`);

console.log("\n— retiring, as the sync does it now —");
{
  await asService();
  await db.exec(`update public.events set is_published = false where source = 'ticketmaster' and starts_at < now()`);
  const open = await rows(`select slug from public.events_public where is_published`);
  check(!open.some((r) => ["kept-old", "untouched", "recent-past"].includes(r.slug)) && open.some((r) => r.slug === "ours-old"), "a retired night is off the deck, our own stays on");
  await asUser(A);
  const mine = await rows(`select slug from public.my_cards()`);
  check(mine.some((r) => r.slug === "kept-old"), "the check-in card is still in the collection");
  const feed = await rows(`select slug from public.past_feed('${city.slug}', null, null, 30)`);
  check(feed.some((r) => r.slug === "recent-past"), "the past feed still shows last week");
}

console.log("\n— pruning, only what nobody touched —");
{
  await asService();
  const n = (await rows(`select public.events_prune_untouched(400) as n`))[0].n;
  check(n === 1, "exactly one row went", String(n));
  const left = (await rows(`select slug from public.events order by slug`)).map((r) => r.slug);
  check(!left.includes("untouched"), "the untouched old night is gone");
  check(left.includes("kept-old"), "the one with a card stays");
  check(left.includes("recent-past"), "last week stays, untouched or not");
  check(left.includes("ours-old"), "our own rows are never pruned");
  const again = (await rows(`select public.events_prune_untouched(400) as n`))[0].n;
  check(again === 0, "a second pass finds nothing");
  check((await rows(`select public.events_prune_untouched(30) as n`))[0].n === 0, "a window under a year is raised to a year");
}

console.log("\n— closed —");
{
  await asUser(A);
  check(Boolean(await fails(`select public.events_prune_untouched(400)`)), "a signed-in person cannot prune");
  await asAnon();
  check(Boolean(await fails(`select public.events_prune_untouched(400)`)), "nor anyone signed out");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
