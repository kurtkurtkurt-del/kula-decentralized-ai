/* afterhours — can a database built before the rename take today's setup.
   The live project was set up while the code was still Turkish: its
   ordering column is `sira`, and its events_public view carries a column
   called `type_sira`. Running setup-1-structure.sql on a clean database
   proves nothing about that one.

   So this rebuilds the old shape from the last commit before the
   translation (5dabbd2) and runs today's setup on top of it — the exact
   thing a person does in the SQL editor.

   It exists because the first attempt failed in front of the user:
     42P16: cannot change name of view column "type_sira" to "type_sort_order"
   `create or replace view` can add a column but never rename one, and the
   same is true of a function's OUT parameters.  */

import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const root = new URL("../../", import.meta.url).pathname;
/* The old files carry their old names too; 5dabbd2 is the last commit
   before the code moved to English. */
const before = (path) => {
  try {
    return execFileSync("git", ["show", `5dabbd2:${path}`],
                        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (_) {
    /* A SHALLOW clone has only the tip commit, so this read fails and the
       raw crash says nothing about why. It cost a whole red CI run once:
       actions/checkout is shallow by default and the workflow now asks
       for fetch-depth: 0. */
    console.error(
      "\nThis test rebuilds the pre-rename database from commit 5dabbd2, " +
      "which is not in\nthis checkout — a shallow clone holds only the tip. " +
      "Fetch the history:\n  git fetch --unshallow      " +
      "(in CI: actions/checkout with fetch-depth: 0)\n");
    process.exit(1);
  }
};

let passed = 0, failed = 0;
const check = (condition, name, extra = "") => {
  if (condition) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
};
process.on("unhandledRejection", (e) => {
  console.error("\nERROR: " + (e && e.message ? e.message : e));
  process.exit(1);
});

const OLD = [
  "backend/sql/01_schema.sql", "backend/sql/02_rls.sql",
  "backend/sql/03_seed_katalog.sql", "backend/sql/04_seed_events.sql",
  "backend/sql/06_views.sql", "backend/sql/07_friends.sql",
  "backend/sql/09_jobs.sql", "backend/sql/11_dunya.sql",
];

const db = new PGlite();

console.log("\n— the database as it was before the rename —");
{
  await db.exec(await read("../test/supabase-shim.sql"));
  for (const f of OLD) await db.exec(before(f));

  const col = await db.query(`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'cities' and column_name = 'sira'`);
  check(col.rows.length === 1, "the ordering column is still called sira");

  const view = await db.query(`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'events_public'
      and column_name = 'type_sira'`);
  check(view.rows.length === 1, "the view still exposes type_sira");

  const n = await db.query(`select count(*)::int as n from public.events`);
  check(n.rows[0].n > 100, "it has its content", String(n.rows[0].n));
}

/* Something of a person's, so the upgrade can be shown not to touch it. */
console.log("\n— with somebody's data in it —");
{
  await db.exec(`
    insert into auth.users (id, email)
    values ('12121212-1212-1212-1212-121212121212', 'someone@example.com');
    insert into public.swipes (user_id, event_id, direction)
    select '12121212-1212-1212-1212-121212121212', id, 'right'
    from public.events where slug = 'asap-rocky';
    insert into public.comments (event_id, author_name, body)
    select id, 'someone', 'i was here before the rename'
    from public.events where slug = 'asap-rocky';`);
  const s = await db.query(`select count(*)::int as n from public.swipes`);
  check(s.rows[0].n === 1, "one swipe on the old database");
}

console.log("\n— today's setup, pasted on top —");
{
  let ok = true, message = "";
  try { await db.exec(await read("../sql/setup-1-structure.sql")); }
  catch (e) { ok = false; message = String(e.message).slice(0, 130); }
  check(ok, "setup-1-structure.sql runs on the old database", message);
}

console.log("\n— what the upgrade did —");
{
  const renamed = await db.query(`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'cities'
      and column_name in ('sira', 'sort_order') order by 1`);
  check(renamed.rows.length === 1 && renamed.rows[0].column_name === "sort_order",
    "sira became sort_order", renamed.rows.map((r) => r.column_name).join(", "));

  const view = await db.query(`
    select column_name from information_schema.columns
    where table_schema = 'public' and table_name = 'events_public'
      and column_name in ('type_sira', 'type_sort_order') order by 1`);
  check(view.rows.length === 1 && view.rows[0].column_name === "type_sort_order",
    "the view came back with type_sort_order", view.rows.map((r) => r.column_name).join(", "));

  const fn = await db.query(`
    select column_name from information_schema.columns
    where table_schema='public' and table_name='friends_list'`);
  const dir = await db.query(`select direction from public.friends_list() limit 1`)
    .then(() => true).catch(() => false);
  check(dir, "friends_list() answers with 'direction'");
}

console.log("\n— and did not touch what was already there —");
{
  const s = await db.query(`select count(*)::int as n from public.swipes`);
  check(s.rows[0].n === 1, "the swipe survived", String(s.rows[0].n));
  const c = await db.query(
    `select count(*)::int as n from public.comments where body = 'i was here before the rename'`);
  check(c.rows[0].n === 1, "the comment survived");
  const u = await db.query(`select count(*)::int as n from auth.users`);
  check(u.rows[0].n === 1, "the account survived");
}

console.log("\n— everything new is in —");
{
  const rows = await db.query(`select name from public.migrations_applied()`);
  const applied = rows.rows.map((r) => r.name);
  check(applied.includes("12_profiles.sql"), "12_profiles.sql is in");
  check(applied.includes("13_feedback.sql"), "13_feedback.sql is in");
  check(applied.includes("14_export.sql"), "14_export.sql is in");
  check(applied.length >= 13, `${applied.length} files stamped`);

  /* The three the site needs and could not reach before. */
  for (const fn of ["profile_me", "handle_status", "export_me", "feedback_list"]) {
    const found = await db.query(
      `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = $1`, [fn]);
    check(found.rows.length > 0, `${fn}() exists`);
  }
}

console.log("\n— and it can be pasted twice —");
{
  let ok = true, message = "";
  try { await db.exec(await read("../sql/setup-1-structure.sql")); }
  catch (e) { ok = false; message = String(e.message).slice(0, 130); }
  check(ok, "a second run changes nothing and raises nothing", message);
  const s = await db.query(`select count(*)::int as n from public.swipes`);
  check(s.rows[0].n === 1, "the swipe is still there after the second run");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
