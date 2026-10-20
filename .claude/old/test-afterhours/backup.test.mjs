/* afterhours — can the backup actually be restored.
   A backup nobody has ever put back is not a backup, it is a file. So this
   builds a full database, takes a backup in exactly the shape
   tools/backup.mjs produces, wipes the content into a fresh database that
   has only the structure, restores from that backup, and compares the two
   line by line.

   What it does NOT claim: that accounts, swipes or friendships come back.
   They are not in the backup and are not meant to be — a backup taken with
   the public key never saw them.  */

import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { restoreSql } from "../tools/restore.mjs";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

let passed = 0, failed = 0;
const check = (condition, name, extra = "") => {
  if (condition) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
};
process.on("unhandledRejection", (e) => {
  console.error("\nERROR: " + (e && e.message ? e.message : e));
  process.exit(1);
});

const STRUCTURE = [
  "../test/supabase-shim.sql", "../sql/00_migrations.sql", "../sql/01_schema.sql",
  "../sql/02_rls.sql", "../sql/06_views.sql", "../sql/07_friends.sql",
  "../sql/09_jobs.sql", "../sql/12_profiles.sql", "../sql/13_feedback.sql",
];
const CONTENT = [
  "../sql/03_seed_catalog.sql", "../sql/04_seed_events.sql",
  "../sql/05_seed_comments.sql", "../sql/11_world.sql",
];

async function build(withContent) {
  const db = new PGlite();
  for (const f of STRUCTURE) await db.exec(await read(f));
  if (withContent) for (const f of CONTENT) await db.exec(await read(f));
  return db;
}

/* The same five collections tools/backup.mjs pulls over REST, in the same
   shape. It reads the two _public views, so this does too. */
async function takeBackup(db) {
  const all = async (sql) => (await db.query(sql)).rows;
  return {
    taken_at: new Date().toISOString(),
    source: "the test",
    cities: await all("select * from public.cities order by sort_order"),
    event_types: await all("select * from public.event_types order by sort_order"),
    venues: await all("select * from public.venues order by name"),
    events: await all("select * from public.events_public order by poster_no"),
    comments: await all("select * from public.comments_public order by created_at"),
  };
}

console.log("\n— a full database, and a backup of it —");
const live = await build(true);
const backup = await takeBackup(live);
check(backup.cities.length === 54, "54 cities in the backup", String(backup.cities.length));
check(backup.events.length === 142, "142 events in the backup", String(backup.events.length));
check(backup.comments.length === 311, "311 comments in the backup", String(backup.comments.length));
check(backup.venues.length === 20, "20 venues in the backup", String(backup.venues.length));

console.log("\n— restoring it into an empty structure —");
const fresh = await build(false);
{
  const before = await fresh.query(`select count(*)::int as n from public.events`);
  check(before.rows[0].n === 0, "the fresh database starts with no events");

  let ok = true;
  try { await fresh.exec(restoreSql(backup)); }
  catch (e) { ok = false; console.log("     " + e.message.slice(0, 140)); }
  check(ok, "the restore SQL runs through");
}

console.log("\n— is it the same content —");
{
  const same = async (sql, name) => {
    const a = (await live.query(sql)).rows;
    const b = (await fresh.query(sql)).rows;
    check(JSON.stringify(a) === JSON.stringify(b), name,
      `${JSON.stringify(a).length} vs ${JSON.stringify(b).length} bytes`);
  };
  await same("select slug, name, status, sort_order, country from public.cities order by slug",
             "every city came back, field for field");
  await same("select slug, name, sort_order from public.event_types order by slug",
             "every kind came back");
  await same("select slug, name, map_x, map_y, opens_hour, open_hours from public.venues order by slug",
             "every venue came back");
  await same(`select slug, title, meta, body, poster_no, is_published,
                     starts_at, starts_at_estimated, date_text
              from public.events order by slug`,
             "every event came back, text for text");
  await same("select body, time_text, author_name from public.comments order by id",
             "every comment came back");
}

console.log("\n— the shape of it —");
{
  const q = async (sql) => (await fresh.query(sql)).rows[0].n;
  check(await q("select count(*)::int as n from public.events where venue_id is not null") ===
        await (async () => (await live.query("select count(*)::int as n from public.events where venue_id is not null")).rows[0].n)(),
        "the events kept their venue");
  check(await q("select count(*)::int as n from public.comments where parent_id is not null") === 131,
        "the 131 replies are still attached to their topics",
        String(await q("select count(*)::int as n from public.comments where parent_id is not null")));
  check(await q(`select count(*)::int as n from public.comments c
                 left join public.comments p on p.id = c.parent_id
                 where c.parent_id is not null and p.id is null`) === 0,
        "no reply lost its topic");
  check(await q(`select count(*)::int as n from public.events e
                 left join public.cities c on c.id = e.city_id where c.id is null`) === 0,
        "no event lost its city");
}

console.log("\n— running the restore twice changes nothing —");
{
  const before = await fresh.query(
    `select (select count(*) from public.events) as e,
            (select count(*) from public.comments) as c,
            (select count(*) from public.cities) as s`);
  let twice = true;
  try { await fresh.exec(restoreSql(backup)); }
  catch (e) { twice = false; console.log("     " + String(e.message).slice(0, 120)); }
  check(twice, "the restore runs a second time without error");
  const after = await fresh.query(
    `select (select count(*) from public.events) as e,
            (select count(*) from public.comments) as c,
            (select count(*) from public.cities) as s`);
  check(JSON.stringify(before.rows) === JSON.stringify(after.rows),
    "the counts did not move", JSON.stringify(after.rows));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
