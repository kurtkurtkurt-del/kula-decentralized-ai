/* pasaport — the status check.
   Is the database up, is the content in place, which of the SQL files have
   actually been run, and what wants attention.
   A non-zero exit code means something is wrong; a scheduled job can hook onto it.

     node tools/health.mjs [address] [key]  */

import { readFile } from "node:fs/promises";
import { EXPECTED_SQL } from "./expected-sql.mjs";

const text = await readFile(new URL("../../config.js", import.meta.url), "utf8");
const box = {};
new Function("window", text)(box);
const config = box.PP_CONFIG || box.AH_CONFIG || {};

const address = (process.argv[2] || config.url || "").replace(/\/$/, "");
const key = process.argv[3] || config.anonKey || "local";
if (!address) { console.error("No address."); process.exit(1); }

const headers = {
  apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json",
};
const call = async (fn) => {
  const c = await fetch(`${address}/rest/v1/rpc/${fn}`, {
    method: "POST", headers, body: "{}",
  });
  if (!c.ok) throw new Error(c.status + " " + (await c.text()).slice(0, 120));
  return c.json();
};

const started = Date.now();
let reply;
try {
  reply = (await call("health"))[0];
} catch (e) {
  console.error("UNREACHABLE: " + e.message);
  process.exit(1);
}

const took = Date.now() - started;
const count = (a) => Number(a || 0);

console.log(`\npasaport · ${address}`);
console.log(`response time       ${took} ms\n`);
console.log(`projects            ${count(reply.projects)} (${count(reply.open_projects)} open)`);
console.log(`people              ${count(reply.people)} · ${count(reply.passports)} with a passport`);
console.log(`keeps               ${count(reply.joins)}`);
console.log(`friendships         ${count(reply.friendships)}`);
console.log(`nights              ${count(reply.nights)} done · ${count(reply.nights_tonight)} running · ${count(reply.tokens)} tokens · ${count(reply.kwh)} kWh · ${count(reply.credits)} credits`);
console.log(`coops · calls       ${count(reply.coops)} · ${count(reply.calls_open)} open`);
console.log(`pushes stuck        ${count(reply.outbox_stuck)}`);

const warnings = [];
const failures = [];
if (count(reply.projects) === 0) failures.push("no projects at all — the seed (03) did not run or the data is gone");
if (count(reply.nights_stuck)) warnings.push(`${count(reply.nights_stuck)} night(s) open for more than a day — the phone died; retention_prune closes them`);
if (count(reply.outbox_stuck)) warnings.push(`${count(reply.outbox_stuck)} pushes older than six hours are still unsent — pg_net / pg_cron?`);

/* --- which SQL files have been run -------------------------------------
   The setup is pasted in by hand, so a project can sit a file behind
   without anything looking broken: a page just answers PGRST202 because
   the function it wanted was never created. This is the one place that
   says so out loud. The list itself lives in tools/expected-sql.mjs. */


let missing = [], behind = false;
try {
  const rows = await call("migrations_applied");
  const applied = new Set(rows.map((r) => r.name));
  missing = EXPECTED_SQL.filter((f) => !applied.has(f));
  /* Since 91: a file edited after it was pasted, or an old copy pasted over a newer one. */
  try {
    const hashes = JSON.parse(await readFile(new URL("./sql-hashes.json", import.meta.url), "utf8"));
    const edited = rows.filter((r) => r.hash && hashes[r.name] && hashes[r.name] !== r.hash).map((r) => r.name);
    if (edited.length) warnings.push("applied but no longer the same text — paste again: " + edited.join(", "));
  } catch {}
  console.log(`\nSQL applied         ${applied.size} of ${EXPECTED_SQL.length}`);
  if (missing.length) {
    console.log("\nnot run yet:");
    missing.forEach((f) => console.log("  · " + f));
    console.log("  → paste backend/sql/setup.sql in the SQL editor");
  }
} catch (e) {
  /* The log itself is one of the files. Before it is run there is nothing
     to ask, and that is the loudest answer of all. */
  if (/PGRST202|does not exist|Searched for the function/i.test(e.message)) {
    behind = true;
    warnings.push("the migration log is missing — this project predates it; " +
                  "run backend/sql/setup.sql to find out what else is behind");
  } else {
    warnings.push("could not read the migration log: " + e.message);
  }
}

if (failures.length) {
  console.log("\nRED:");
  failures.forEach((u) => console.log("  · " + u));
}
if (warnings.length) {
  console.log("\nwants attention:");
  warnings.forEach((u) => console.log("  · " + u));
}

/* No events at all is a real fault, and so is a file that never ran — both
   mean the site is not serving what it should. The rest is maintenance. */
process.exit(failures.length || missing.length || behind ? 1 : 0);
