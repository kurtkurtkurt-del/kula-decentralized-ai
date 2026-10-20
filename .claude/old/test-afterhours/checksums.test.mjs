/* afterhours — a file remembers its own text (91) */

import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

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
await db.exec(await read("../sql/91_checksums.sql"));
const rows = async (sql) => (await db.query(sql)).rows;

console.log("\n— in the database —");
{
  const applied = await rows(`select name, hash from public.migrations_applied()`);
  const stamped = applied.filter((r) => r.hash);
  check(applied.length >= 90, "every file stamped itself", String(applied.length));
  /* on a fresh database the files before 91 ran before the two-argument form existed;
     pasted again now, a file brings its hash */
  await db.exec(await read("../sql/77_reserved_handles.sql"));
  const again = (await rows(`select hash from public.migrations_applied() where name = '77_reserved_handles.sql'`))[0].hash;
  check(stamped.length >= 1 && /^[0-9a-f]{64}$/.test(again ?? ""), "a file pasted after 91 brings its hash", String(again));
  await db.exec(`select public.migration_done('zz_test.sql', 'abc')`);
  check((await rows(`select hash from public.migrations where name = 'zz_test.sql'`))[0].hash === "abc", "the two-argument form keeps the hash");
  await db.exec(`select public.migration_done('zz_test.sql')`);
  check((await rows(`select hash from public.migrations where name = 'zz_test.sql'`))[0].hash === "abc", "the one-argument form leaves it in place");
}

console.log("\n— the stamps in the repository —");
{
  const r = spawnSync("node", ["tools/stamp-sql.mjs", "--check"], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" });
  check(r.status === 0, "every stamp is fresh", (r.stdout + r.stderr).trim().slice(0, 200));
  const hashes = JSON.parse(await read("../tools/sql-hashes.json"));
  check(Object.keys(hashes).length >= 90 && /^[0-9a-f]{64}$/.test(hashes["91_checksums.sql"] ?? ""), "the hash list is written");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
