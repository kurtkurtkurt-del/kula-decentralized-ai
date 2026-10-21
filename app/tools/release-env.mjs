#!/usr/bin/env node
// Before a release build: which server will the build be baked with? Loads the env files
// exactly as Expo does for a production bundle (@expo/env, mode production) and refuses
// when the address is missing, the Mac's local server (a private address, localhost) or
// not https, or when it is afterhours' project. Run by npm run apk; also on its own:
//   npm run release:check
// Why: Expo loads .env.local in production too, so the 21.10.2026 apk was baked with the
// Mac's Wi-Fi address and was offline everywhere else (app/.env says more).
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const app = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(app, "package.json"));
const env = require("@expo/env");
const files = env.getEnvFiles({ mode: "production", silent: true }).map((f) => join(app, f));
const { env: values, files: loaded } = env.parseEnvFiles(files, { systemEnv: process.env });
const v = { ...values, ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("EXPO_PUBLIC_"))) };
const url = v.EXPO_PUBLIC_SUPABASE_URL ?? "";
const key = v.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "";
const AFTERHOURS = ["elmnnyxgavwjxvwjgjcu"]; // afterhours' live project: kula must never use it

console.log(`release env: ${loaded.map((f) => f.replace(app + "/", "")).join(", ") || "no env files"} → ${url || "(none)"}`);
if (!url) {
  // no server at all: the app runs on the example world in src/demo (lib/supabase.ts, DEMO)
  console.log("✓ demo build: no server, the example world on the phone (src/demo); nothing leaves the phone");
  process.exit(0);
}
const problems = [];
let host = "";
try {
  const u = new URL(url);
  host = u.hostname;
  if (u.protocol !== "https:") problems.push(`the server is not https (${url})`);
} catch {
  problems.push("no server address (EXPO_PUBLIC_SUPABASE_URL is empty)");
}
if (host && /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|.*\.local$|.*\.localhost$)/i.test(host)) problems.push(`the server is a development computer (${host}): the build would only work on that network`);
if (AFTERHOURS.some((id) => url.includes(id))) problems.push("the server is afterhours' project; kula has its own");
if (!key || key === "local") problems.push("no publishable key (EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY)");

if (problems.length) {
  console.error(`✗ not releasable:\n  - ${problems.join("\n  - ")}\nFill app/.env.production with kula's own Supabase project (README: "a live server").`);
  process.exit(1);
}
console.log("✓ the build will talk to a live server");
