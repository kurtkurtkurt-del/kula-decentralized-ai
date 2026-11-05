/* kula — every numbered SQL file carries the hash of its own text.
     node tools/stamp-sql.mjs           rewrite the stamp lines, write tools/sql-hashes.json
     node tools/stamp-sql.mjs --check   fail when a file is unstamped or stale (the gate runs this)
   The hash is sha256 of the file with its stamp block in the bare one-argument form, so the
   stamp itself does not change the hash. 00_migrations.sql stores it in public.migrations;
   tools/health.mjs says which applied file was edited after it was pasted. */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { EXPECTED_SQL } from "./expected-sql.mjs";

const check = process.argv.includes("--check");
const dir = new URL("../sql/", import.meta.url);
const block = (name, hash) => `do $$ begin
  if to_regprocedure('public.migration_done(text, text)') is not null then
    perform public.migration_done('${name}', '${hash}');
  elsif to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('${name}');
  end if;
end $$;`;
const bare = (name) => `do $$ begin
  if to_regprocedure('public.migration_done(text)') is not null then
    perform public.migration_done('${name}');
  end if;
end $$;`;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const anyBlock = (name) => new RegExp(
  `do \\$\\$ begin\\n  if to_regprocedure\\('public\\.migration_done\\(text(?:, text)?\\)'\\) is not null then\\n    perform public\\.migration_done\\('${esc(name)}'(?:, '[0-9a-f]{64}')?\\);\\n(?:  elsif to_regprocedure\\('public\\.migration_done\\(text\\)'\\) is not null then\\n    perform public\\.migration_done\\('${esc(name)}'\\);\\n)?  end if;\\nend \\$\\$;`);

/* Files kept with the bare stamp (none today). */
const GENERATED = new Set();
const hashes = {};
let changed = 0, stale = [], unstamped = [];
for (const name of EXPECTED_SQL) {
  let text;
  try { text = await readFile(new URL(name, dir), "utf8"); } catch { continue; }
  const re = anyBlock(name);
  if (!re.test(text)) { unstamped.push(name); continue; }
  const plain = text.replace(re, () => bare(name)); // a function: '$$' in a plain replacement would collapse
  if (GENERATED.has(name)) {
    if (plain !== text) {
      stale.push(name);
      if (!check) { await writeFile(new URL(name, dir), plain); changed++; }
    }
    continue;
  }
  const hash = createHash("sha256").update(plain).digest("hex");
  hashes[name] = hash;
  const next = text.replace(re, () => block(name, hash));
  if (next !== text) {
    stale.push(name);
    if (!check) { await writeFile(new URL(name, dir), next); changed++; }
  }
}
if (!check) await writeFile(new URL("./sql-hashes.json", import.meta.url), JSON.stringify(hashes, null, 2) + "\n");
if (unstamped.length) console.log("no stamp block (left alone): " + unstamped.join(", "));
if (check) {
  if (stale.length) { console.error("stale stamp — run node tools/stamp-sql.mjs: " + stale.join(", ")); process.exit(1); }
  console.log("stamps fresh (" + Object.keys(hashes).length + " files)");
} else {
  console.log(`${changed} file(s) restamped, ${Object.keys(hashes).length} hashes written`);
}
