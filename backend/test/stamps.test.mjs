/* Every numbered file carries a fresh hash (node tools/stamp-sql.mjs). */
import { spawnSync } from "node:child_process";
import { check, finish } from "./lib.mjs";
const r = spawnSync("node", ["tools/stamp-sql.mjs", "--check"], { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" });
console.log(r.stdout.trim() + (r.stderr ? "\n" + r.stderr.trim() : ""));
check(r.status === 0, "stamps fresh");
finish();
