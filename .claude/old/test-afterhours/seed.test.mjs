/* afterhours — is the seed data right.
   The real question: is what went into the database the same thing the
   site shows TODAY? Every line that appears on screen is compared. */

import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const readRoot = (path) => readFile(new URL("../../" + path, import.meta.url), "utf8");

let passed = 0, failed = 0;
const check = (condition, name, extra = "") => {
  if (condition) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
};

process.on("unhandledRejection", (e) => {
  console.log("\nERROR: " + ((e && e.message) || e));
  if (e && e.where) console.log("  " + e.where);
  process.exit(1);
});

const db = new PGlite();
console.log("\n— schema + seed —");
for (const d of ["../test/supabase-shim.sql", "../sql/01_schema.sql", "../sql/02_rls.sql",
                 "../sql/03_seed_catalog.sql", "../sql/04_seed_events.sql",
                 "../sql/05_seed_comments.sql"]) {
  await db.exec(await read(d));
  console.log("  · " + d.split("/").pop());
}

/* the source data from the front end */
const { POSTERS } = new Function(await readRoot("events-data.js") + ";return { POSTERS };")();

console.log("\n— counts —");
{
  const count = async (t) => (await db.query(`select count(*)::int as n from public.${t}`)).rows[0].n;
  check(await count("events") === POSTERS.length, `${POSTERS.length} events loaded`);
  check(await count("cities") === 11, "11 cities (three countries)");
  check(await count("event_types") === 6, "6 kinds");
  check(await count("venues") === 20, "20 venues");

  const k = await db.query(`select count(*) filter (where parent_id is null)::int as topic,
                                   count(*) filter (where parent_id is not null)::int as reply
                            from public.comments`);
  check(k.rows[0].topic === 180, "180 comment topics", `found ${k.rows[0].topic}`);
  check(k.rows[0].reply === 131, "131 replies", `found ${k.rows[0].reply}`);
}

console.log("\n— do the lines on screen match exactly —");
{
  const r = await db.query(`
    select e.slug, e.title, e.meta, e.body, e.poster_no, t.name as kind
    from public.events e join public.event_types t on t.id = e.type_id
    order by e.poster_no`);

  const different = [];
  r.rows.forEach((row, i) => {
    const source = POSTERS[i];
    if (row.slug !== source.slug) different.push(`${i}: slug ${row.slug} ≠ ${source.slug}`);
    if (row.title !== source.title) different.push(`${source.slug}: heading`);
    if (row.meta !== source.meta) different.push(`${source.slug}: meta "${row.meta}" ≠ "${source.meta}"`);
    if (row.body !== source.body) different.push(`${source.slug}: text`);
    if (row.kind !== source.kind) different.push(`${source.slug}: kind ${row.kind} ≠ ${source.kind}`);
    if (row.poster_no !== i + 1) different.push(`${source.slug}: poster no`);
  });

  check(r.rows.length === POSTERS.length, "sort_order matches the poster number");
  check(different.length === 0, "all 36 records match on slug/title/meta/body/kind/poster",
    different.slice(0, 3).join(" | "));
}

console.log("\n— the comments match the selection the site makes —");
{
  const { COMMENTS_FOR } = new Function(
    await readRoot("explore/comment-pools.js") + ";return { COMMENTS_FOR };")();

  const sample = POSTERS[0];
  const { older, recent } = COMMENTS_FOR(sample);
  const r = await db.query(`
    select c.body, c.author_name, c.time_text
    from public.comments c join public.events e on e.id = c.event_id
    where e.slug = $1 and c.parent_id is null
    order by c.created_at desc`, [sample.slug]);

  const expected = [...recent, ...older].map((k) => k.body).sort();
  const got = r.rows.map((x) => x.body).sort();
  check(JSON.stringify(expected) === JSON.stringify(got),
    `${sample.slug}: the topics match the site (${got.length} topics)`);

  const z = await db.query(`select count(*)::int as n from public.comments where time_text is null`);
  check(z.rows[0].n === 0, "every sample comment kept its on-screen time");

  const orphans = await db.query(`
    select count(*)::int as n from public.comments c
    where c.parent_id is not null
      and not exists (select 1 from public.comments p
                      where p.id = c.parent_id and p.parent_id is null)`);
  check(orphans.rows[0].n === 0, "every reply hangs off exactly one topic");
}

console.log("— can the SQL editors parse it —");
{
  /* This was the real trap: the Supabase panel parser walks along
     counting quotes, and it counts the apostrophe inside COMMENTS too.
     A single mark, as in "the database of Supabase", flips the count, and
     a later "...condensed into one night..." is then read as CODE, giving
     "relation \"one\" does not exist".
     No ASCII apostrophe in a comment; use the typographic ’ instead. */
  for (const d of ["../sql/setup-1-structure.sql", "../sql/setup-2-comments.sql"]) {
    const text = await read(d);

    const withApostrophe = text.split("\n").filter((r) => {
      const i = r.indexOf("--");
      return i >= 0 && r.slice(i).includes("'");
    });
    check(withApostrophe.length === 0,
      d.split("/").pop() + ": no apostrophe in the comments",
      withApostrophe[0] && withApostrophe[0].trim().slice(0, 60));

    /* Imitate the naive parser: it must not still be inside a string at the end */
    let inString = false;
    for (const c of text) if (c === "'") inString = !inString;
    check(!inString, d.split("/").pop() + ": the quote count ends balanced");
  }
}

console.log("\n— the relations —");
{
  const missing = await db.query(`
    select count(*)::int as n from public.events
    where city_id is null or type_id is null`);
  check(missing.rows[0].n === 0, "every event has a city and a kind");

  const noVenue = await db.query(`select count(*)::int as n from public.events where venue_id is null`);
  check(noVenue.rows[0].n === 8,
    "8 events have no venue (their meta names a district or a city)", `found ${noVenue.rows[0].n}`);

  const estimated = await db.query(`select count(*)::int as n from public.events where starts_at_estimated`);
  check(estimated.rows[0].n === 24, "24 dates are marked as unconfirmed", `found ${estimated.rows[0].n}`);

  /* Are the country fields filled in: the filter splits by country first */
  const noCountry = await db.query(
    `select count(*)::int as n from public.cities where country_slug is null`);
  check(noCountry.rows[0].n === 0, "every city has a country");

  const countries = await db.query(
    `select count(distinct country_slug)::int as n from public.cities`);
  check(countries.rows[0].n === 3, "three countries", "found " + countries.rows[0].n);

  const kindSpread = await db.query(`
    select t.name, count(*)::int as n from public.events e
    join public.event_types t on t.id = e.type_id group by t.name order by t.name`);
  const expected = { "Club Night": 7, "Festival": 5, "Hausparty": 6, "Konzert": 5, "Meetup": 6, "Rave": 7 };
  const got = Object.fromEntries(kindSpread.rows.map((r) => [r.name, r.n]));
  check(JSON.stringify(got) === JSON.stringify(expected),
    "the spread of kinds matches the counter on the landing page", JSON.stringify(got));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
