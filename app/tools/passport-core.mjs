#!/usr/bin/env node
// passport-core: keeps kula's snapshot of device-passport's measurement in step.
//
//   node tools/passport-core.mjs sync    copy ../device-passport/passport-core (the Kotlin
//                                        sources and contract/) into
//                                        modules/passport-measure/vendor
//   node tools/passport-core.mjs check   fail when the snapshot differs from device-passport
//                                        (or was edited by hand); part of npm run gate
//
// The Expo module builds from device-passport's folder itself when it is there
// (modules/passport-measure/android/build.gradle); the snapshot is for builds without it.
// Never edit vendor/ by hand: change device-passport, then sync.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const live = resolve(process.env.PASSPORT_CORE_DIR ?? join(app, "../../device-passport/passport-core"));
const vendor = join(app, "modules/passport-measure/vendor");
const PARTS = [["src/main/java", "src"], ["contract", "contract"]]; // device-passport → vendor

const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex").slice(0, 16);
function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
// { "src/com/pasaport/Measure.kt": hash, "contract/contract.json": hash, … }
function liveFiles() {
  const out = {};
  for (const [from, to] of PARTS) for (const f of walk(join(live, from))) out[join(to, relative(join(live, from), f))] = sha(f);
  return out;
}
function vendorFiles() {
  const out = {};
  for (const [, to] of PARTS) for (const f of walk(join(vendor, to))) out[relative(vendor, f)] = sha(f);
  return out;
}
const source = () => (existsSync(join(vendor, "SOURCE.json")) ? JSON.parse(readFileSync(join(vendor, "SOURCE.json"), "utf8")) : null);
function gitOf(dir) {
  try {
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "."], { cwd: dir, encoding: "utf8" }).trim() !== "";
    return { commit: head, dirty };
  } catch {
    return { commit: null, dirty: null };
  }
}
function diff(a, b) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.filter((k) => a[k] !== b[k]).map((k) => `${!b[k] ? "+" : !a[k] ? "-" : "~"} ${k}`);
}

const cmd = process.argv[2];
if (cmd === "sync") {
  if (!existsSync(join(live, "src/main/java"))) {
    console.error(`passport-core: nothing to sync, ${live} is not there`);
    process.exit(1);
  }
  for (const [from, to] of PARTS) {
    rmSync(join(vendor, to), { recursive: true, force: true });
    mkdirSync(join(vendor, to), { recursive: true });
    cpSync(join(live, from), join(vendor, to), { recursive: true });
  }
  const files = vendorFiles();
  const g = gitOf(live);
  writeFileSync(join(vendor, "SOURCE.json"), JSON.stringify({ from: "device-passport/passport-core", ...g, synced_at: new Date().toISOString(), files }, null, 2) + "\n");
  console.log(`passport-core: ${Object.keys(files).length} files from device-passport ${g.commit ?? "?"}${g.dirty ? " (with uncommitted changes)" : ""} → ${relative(app, vendor)}`);
} else if (cmd === "check") {
  const src = source();
  if (!src) {
    console.error("passport-core: no snapshot yet; run npm run passport:sync");
    process.exit(1);
  }
  const edited = diff(src.files, vendorFiles());
  if (edited.length) {
    console.error(`passport-core: vendor/ was edited by hand (change device-passport, then npm run passport:sync):\n  ${edited.join("\n  ")}`);
    process.exit(1);
  }
  if (!existsSync(join(live, "src/main/java"))) {
    console.log(`passport-core: device-passport is not beside kula; builds use the snapshot (${src.commit ?? "?"}, ${src.synced_at})`);
    process.exit(0);
  }
  const behind = diff(liveFiles(), src.files);
  if (behind.length) {
    console.error(`passport-core: kula's snapshot is behind device-passport — run npm run passport:sync and commit:\n  ${behind.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`passport-core: the snapshot matches device-passport (${Object.keys(src.files).length} files, ${gitOf(live).commit ?? "?"})`);
} else {
  console.error("usage: node tools/passport-core.mjs sync|check");
  process.exit(2);
}
