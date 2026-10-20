/* The whole set builds twice (a second paste changes nothing) and the three lists agree. */
import { build, check, read, finish } from "./lib.mjs";
import { EXPECTED_SQL } from "../tools/expected-sql.mjs";
import { readdir } from "node:fs/promises";

const db = await build("15_health.sql");
console.log("\n— pasting everything a second time —");
for (const f of EXPECTED_SQL) await db.exec(await read("../sql/" + f));
const r = await db.query(`select count(*)::int n from public.migrations`);
check(r.rows[0].n === EXPECTED_SQL.length, "every file stamped, once");
const files = (await readdir(new URL("../sql/", import.meta.url))).filter((f) => /^\d\d_.*\.sql$/.test(f)).sort();
check(files.join() === EXPECTED_SQL.join(), "every numbered file is in expected-sql.mjs, in order");
const app = await read("../../app/src/data/expectedSql.ts");
const inApp = [...app.matchAll(/'(\d\d_[a-z_]+\.sql)'/g)].map((m) => m[1]);
check(inApp.join() === EXPECTED_SQL.join(), "the app's copy (src/data/expectedSql.ts) agrees");
finish();
