/* afterhours — the past feed: photos of past nights, newest first, page by page */

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
                 "../sql/03_seed_catalog.sql", "../sql/06_views.sql", "../sql/07_friends.sql",
                 "../sql/12_profiles.sql", "../sql/15_ticketmaster.sql", "../sql/19_checkins.sql",
                 "../sql/31_past_feed.sql"]) {
  await db.exec(await read(d));
}
await db.exec(await read("../sql/31_past_feed.sql"));

const A = "aaaaaaaa-1111-1111-1111-111111111111";   /* me */
const B = "bbbbbbbb-2222-2222-2222-222222222222";   /* friend */
const C = "cccccccc-3333-3333-3333-333333333333";   /* friend who hides kept nights */
const D = "dddddddd-4444-4444-4444-444444444444";   /* stranger */

const asUser = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
const [home, away] = (await rows(`select id, slug from public.cities order by sort_order limit 2`));
const type = (await rows(`select id from public.event_types limit 1`))[0].id;
const ago = (days) => `now() - interval '${days} days'`;
await db.exec(`
  insert into auth.users (id, email) values ('${A}', 'a@x.com'), ('${B}', 'b@x.com'), ('${C}', 'c@x.com'), ('${D}', 'd@x.com');
  update public.profiles set handle = 'ada' where id = '${A}';
  update public.profiles set handle = 'berk'  where id = '${B}';
  update public.profiles set handle = 'cansu' where id = '${C}';
  update public.profiles set handle = 'deniz' where id = '${D}';
  update public.profile_settings set kept_visibility = 'private' where user_id = '${C}';
  insert into public.friendships (requester_id, addressee_id, status) values ('${A}', '${B}', 'accepted'), ('${A}', '${C}', 'accepted');
  insert into public.events (slug, city_id, type_id, title, meta, starts_at, image_url, is_published) values
    ('p1', '${home.id}', '${type}', 'One',   'x', ${ago(1)},   'https://img/1.jpg', false),
    ('p2', '${home.id}', '${type}', 'Two',   'x', ${ago(2)},   'https://img/2.jpg', false),
    ('p3', '${home.id}', '${type}', 'Three', 'x', ${ago(3)},   'https://img/3.jpg', false),
    ('nophoto', '${home.id}', '${type}', 'No photo', 'x', ${ago(4)}, null, false),
    ('old', '${home.id}', '${type}', 'Too old', 'x', ${ago(400)}, 'https://img/o.jpg', false),
    ('future', '${home.id}', '${type}', 'Later', 'x', now() + interval '2 days', 'https://img/f.jpg', true),
    ('abroad', '${away.id}', '${type}', 'Abroad', 'x', ${ago(5)}, 'https://img/a.jpg', false),
    ('elsewhere', '${away.id}', '${type}', 'Elsewhere', 'x', ${ago(6)}, 'https://img/e.jpg', false);
  insert into public.checkins (user_id, event_id) select '${B}', id from public.events where slug = 'p2';
  insert into public.checkins (user_id, event_id) select '${D}', id from public.events where slug = 'p2';
  insert into public.swipes (user_id, event_id, direction) select '${A}', id, 'right' from public.events where slug = 'abroad';
  insert into public.swipes (user_id, event_id, direction) select '${C}', id, 'right' from public.events where slug = 'p3';
`);

console.log("\n— the feed —");
{
  await asUser(A);
  const all = await rows(`select slug, people, mine from public.past_feed('${home.slug}', null, null, 30)`);
  const slugs = all.map((r) => r.slug);
  check(JSON.stringify(slugs) === JSON.stringify(["p1", "p2", "p3", "abroad"]), "past nights with a photo, newest first, in your city plus where you went", JSON.stringify(slugs));
  check(!slugs.includes("nophoto") && !slugs.includes("old") && !slugs.includes("future") && !slugs.includes("elsewhere"),
        "no photo, older than a year, still to come, or far away and nobody of yours: left out");
  const p2 = all.find((r) => r.slug === "p2");
  check(JSON.stringify(p2.people) === JSON.stringify(["berk"]), "a friend who checked in is named, a stranger is not", JSON.stringify(p2.people));
  const p3 = all.find((r) => r.slug === "p3");
  check(p3.people.length === 0, "a friend who hides kept nights is not named");
  check(all.find((r) => r.slug === "abroad").mine === true, "your own night is marked as yours");
}

console.log("\n— page by page —");
{
  await asUser(A);
  const first = await rows(`select id, slug, starts_at from public.past_feed('${home.slug}', null, null, 2)`);
  check(first.length === 2 && first[0].slug === "p1", "the first page");
  const next = await rows(`select slug from public.past_feed('${home.slug}', '${first[1].starts_at.toISOString()}', '${first[1].id}', 2)`);
  check(next.length === 2 && next[0].slug === "p3", "the next page starts after the last card", JSON.stringify(next));
}

console.log("\n— same start time across a page edge —");
{
  await asService();
  await db.exec(`insert into public.events (slug, city_id, type_id, title, meta, starts_at, image_url, is_published)
                 select 'twin-' || g, '${home.id}', '${type}', 'Twin', 'x', date_trunc('hour', now()) - interval '10 days', 'https://img/t.jpg', false
                 from generate_series(1, 5) g`);
  await asUser(A);
  const seen = [];
  let cursor = null;
  for (let i = 0; i < 10; i++) {
    const page = await rows(`select id, slug, starts_at from public.past_feed('${home.slug}', ${cursor ? `'${cursor.starts_at.toISOString()}', '${cursor.id}'` : "null, null"}, 2)`);
    if (!page.length) break;
    seen.push(...page.map((r) => r.slug));
    cursor = page[page.length - 1];
  }
  check(seen.filter((s) => s.startsWith("twin-")).length === 5 && new Set(seen).size === seen.length, "nights starting at the same minute are neither skipped nor repeated", JSON.stringify(seen));
}

console.log("\n— signed out —");
{
  await asAnon();
  const anon = await rows(`select slug, people from public.past_feed('${home.slug}', null, null, 30)`);
  check(anon.length === 8 && !anon.some((r) => r.slug === "abroad") && anon.every((r) => r.people.length === 0), "the city's past nights, nobody named");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
