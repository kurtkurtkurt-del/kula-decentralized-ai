/* afterhours — is the clock running (87) */

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
await db.exec(await read("../sql/87_cron_health.sql"));
const rows = async (sql) => (await db.query(sql)).rows;

await db.exec(`set role anon; set request.jwt.claims = '';`);
{
  const h = (await rows(`select * from public.cron_health()`))[0];
  check(h.jobs === 0 && h.last_ok === null && h.last_failed === null && h.failed_24h === 0, "without pg_cron: zero jobs, no runs, no error", JSON.stringify(h));
}
await db.exec(`reset role; set request.jwt.claims = '';`);
/* a bare stand-in for the cron schema Supabase has */
await db.exec(`create schema cron;
  create table cron.job (jobid serial primary key, jobname text, active boolean default true);
  create table cron.job_run_details (runid serial primary key, status text, end_time timestamptz);
  insert into cron.job (jobname) values ('afterhours-push-flush'), ('afterhours-push-hourly');
  insert into cron.job (jobname, active) values ('old', false);
  insert into cron.job_run_details (status, end_time) values ('succeeded', now() - interval '3 minutes'), ('failed', now() - interval '2 hours'), ('failed', now() - interval '3 days');`);
await db.exec(`set role anon; set request.jwt.claims = '';`);
{
  const h = (await rows(`select * from public.cron_health()`))[0];
  check(h.jobs === 2, "counts the active jobs", String(h.jobs));
  check(h.last_ok !== null && Date.now() - new Date(h.last_ok).getTime() < 10 * 60e3, "the last good run");
  check(h.failed_24h === 1, "failures of the last day", String(h.failed_24h));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
