/* kula — apply the numbered SQL files the live database has not run yet.

   Until 12.10.2026 every file was pasted into the Supabase SQL editor by hand, and
   a project could sit a file behind while everything looked fine (the panel said
   "39, 40 not confirmed" for days). This asks public.migrations which files are in,
   and applies the missing ones from tools/expected-sql.mjs in order, each in its own
   transaction: a file that fails is rolled back and stops the run, the ones before
   it stay in.

     SUPABASE_DB_URL=postgres://… node tools/migrate.mjs           what would run (dry)
     SUPABASE_DB_URL=postgres://… node tools/migrate.mjs --write   run it

   The address: Supabase → Settings → Database → Connection string, "session" mode
   (the direct one, not the transaction pooler: a migration needs a plain session).
   Writing is never automatic: no CI job calls --write; it is a word from a terminal. */

import { readFile } from "node:fs/promises";
import pg from "pg";
import { EXPECTED_SQL } from "./expected-sql.mjs";

const url = process.env.SUPABASE_DB_URL;
const write = process.argv.includes("--write");
if (!url) {
  console.error("SUPABASE_DB_URL is not set (Supabase → Settings → Database → Connection string, session mode).");
  process.exit(2);
}

const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await db.connect();
let done = new Set();
try {
  done = new Set((await db.query("select name from public.migrations")).rows.map((r) => r.name));
} catch {
  console.log("no public.migrations table yet: everything counts as missing (00_migrations.sql goes first).");
}
const missing = EXPECTED_SQL.filter((f) => !done.has(f));
console.log(`${done.size} in, ${missing.length} missing${missing.length ? ": " + missing.join(", ") : "."}`);
if (!missing.length) { await db.end(); process.exit(0); }
if (!write) {
  console.log("dry run. add --write to apply them in this order.");
  await db.end();
  process.exit(0);
}
for (const f of missing) {
  const sql = await readFile(new URL("../sql/" + f, import.meta.url), "utf8");
  process.stdout.write(`applying ${f} … `);
  await db.query("begin");
  try {
    await db.query(sql);
    await db.query("commit");
    console.log("ok");
  } catch (e) {
    await db.query("rollback");
    console.log("FAILED");
    console.error(e.message);
    console.error("stopped; the files before it are in, this one and the rest are not.");
    await db.end();
    process.exit(1);
  }
}
await db.end();
