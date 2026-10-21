#!/usr/bin/env node
// npm run apk — a release apk that talks to kula's live server, in one command:
//   1. tools/release-env.mjs: refuse a build without a live server (stops here today,
//      until app/.env.production has kula's Supabase project)
//   2. expo prebuild --platform android --clean (android/ is generated, never edited)
//   3. android/local.properties (the SDK), resource validation off (react-native-screens)
//   4. gradlew assembleRelease with JDK 17 and the SDK
//   5. dist/kula-decentralized-ai-<version>.apk
// The recipe of 21.10.2026, when the same steps took a dozen tries by hand. After moving
// or renaming the repo folder, delete android/ and every node_modules/*/android/{build,.cxx}
// first: they keep absolute paths and break CMake in odd ways.
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const app = new URL("..", import.meta.url).pathname;
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: app, stdio: "inherit", ...opts });
const sdk = process.env.ANDROID_HOME ?? join(homedir(), "Library/Android/sdk");
const jdk = process.env.JAVA_HOME ?? join(homedir(), "Library/Java/JavaVirtualMachines/jdk-17.0.20.1+1/Contents/Home");
for (const [what, path] of [["Android SDK", sdk], ["JDK 17", jdk]]) {
  if (!existsSync(path)) { console.error(`✗ ${what} not found at ${path} (set ${what === "JDK 17" ? "JAVA_HOME" : "ANDROID_HOME"})`); process.exit(1); }
}

run("node", ["tools/release-env.mjs"]);
run("npx", ["expo", "prebuild", "--platform", "android", "--clean", "--no-install"]);
writeFileSync(join(app, "android/local.properties"), `sdk.dir=${sdk}\n`);
const props = join(app, "android/gradle.properties");
if (!readFileSync(props, "utf8").includes("android.disableResourceValidation")) appendFileSync(props, "\nandroid.disableResourceValidation=true\n");
run("./gradlew", ["assembleRelease", "--no-daemon"], { cwd: join(app, "android"), env: { ...process.env, JAVA_HOME: jdk, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk, NODE_ENV: "production" } });

const version = JSON.parse(readFileSync(join(app, "app.json"), "utf8")).expo.version;
mkdirSync(join(app, "../dist"), { recursive: true });
const out = join(app, `../dist/kula-decentralized-ai-${version}.apk`);
copyFileSync(join(app, "android/app/build/outputs/apk/release/app-release.apk"), out);
console.log(`✓ ${out}`);
