/* kula — the gate: every check, then a proof bound to the tree it checked.

   "I ran the tests" used to be a sentence. Now it is a file: .qa/gate-proof.json at
   the repo root, with the tree hash of HEAD (the exact file contents of the commit),
   whether the working tree was clean, when, and how long each layer took. The
   pre-push hook (.githooks/pre-push) refuses a push to main whose commit has no
   passing proof; a proof over a dirty tree says so and counts for nothing there.
   Order: commit → npm run gate → push.

   Layers, in order: the sql stamps, the backend's checks on PGlite, the app's types, lint
   and unit tests, the passport core snapshot, the Mac passport script (web/passport/mac.sh)
   and the docs links. No pipes anywhere: a pipe's exit code is the last command's, not the
   gate's. */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const tree = git("rev-parse", "HEAD^{tree}");
const head = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain") !== "";

const layers = [
  ["sql stamps", "node", ["tools/stamp-sql.mjs", "--check"], "backend"],
  ["backend", "npm", ["test"], "backend"],
  ["app types", "npx", ["tsc", "--noEmit"], "app"],
  ["app lint", "npx", ["expo", "lint"], "app"],
  ["app tests", "npm", ["test", "--", "--ci"], "app"],
  ["passport core", "npm", ["run", "passport:check"], "app"],
  ["mac passport script", "python3", ["tools/passport-mac.py", "--check"], "."],
  ["docs links", "node", ["tools/docs-links.mjs"], "."],
];
const timings = {};
let ok = true;
for (const [name, cmd, args, dir] of layers) {
  const t0 = Date.now();
  console.log(`\n━━ ${name}`);
  const r = spawnSync(cmd, args, { cwd: resolve(root, dir), stdio: "inherit", env: { ...process.env, CI: "1" } });
  timings[name] = Date.now() - t0;
  if (r.status !== 0) {
    ok = false;
    console.log(`\n✗ ${name} failed (${r.status})`);
    break;
  }
}
mkdirSync(resolve(root, ".qa"), { recursive: true });
const proof = { ok, tree, head, dirty, at: new Date().toISOString(), ms: timings };
writeFileSync(resolve(root, ".qa/gate-proof.json"), JSON.stringify(proof, null, 2) + "\n");
console.log(ok ? `\nGATE PASS ${tree.slice(0, 12)}${dirty ? " (DIRTY: the proof is not valid for a push)" : ""}` : "\nGATE FAIL");
process.exit(ok ? 0 : 1);
