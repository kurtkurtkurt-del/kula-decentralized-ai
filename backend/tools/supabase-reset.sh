#!/usr/bin/env bash
# kula — do the numbered SQL files apply from nothing, in order, twice?
#
#   bash tools/supabase-reset.sh            with the Supabase CLI and Docker: lays the files out
#                                           as supabase/migrations/ in a scratch folder (plus the
#                                           edge functions) and runs `supabase db reset`
#   bash tools/supabase-reset.sh --pglite   without them: the same files on PGlite, every file
#                                           then every file again (what the tests do, in one go)
#
# Without an argument it takes the CLI when it is there and falls back to PGlite, saying which.
# Nothing here touches a live project: db reset is the local Docker database only.
set -euo pipefail
cd "$(dirname "$0")/.."

mode="${1:-auto}"
have_cli() { command -v supabase >/dev/null 2>&1 && docker info >/dev/null 2>&1; }

if [ "$mode" != "--pglite" ] && have_cli; then
  work="$(mktemp -d)"
  echo "supabase cli: laying the files out in $work"
  mkdir -p "$work/supabase/migrations" "$work/supabase/functions"
  i=0
  for f in $(node -e 'import("./tools/expected-sql.mjs").then(m => console.log(m.EXPECTED_SQL.join("\n")))'); do
    i=$((i + 1))
    cp "sql/$f" "$work/supabase/migrations/$(printf '2026110500%04d' "$i")_${f%.sql}.sql"
  done
  cp -r functions/_shared functions/night-report functions/project-summary functions/apple-revoke "$work/supabase/functions/"
  # the auth schema, the roles and auth.uid() are Supabase's own: test/supabase-shim.sql is for PGlite only
  (cd "$work" && supabase init --force >/dev/null 2>&1 || true && supabase db reset)
  echo "supabase db reset: every file applied"
  exit 0
fi

[ "$mode" = "--pglite" ] || echo "no supabase cli with docker here: PGlite instead"
node --input-type=module -e '
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { EXPECTED_SQL } from "./tools/expected-sql.mjs";
const db = new PGlite();
await db.exec(await readFile("test/supabase-shim.sql", "utf8"));
for (const pass of [1, 2]) {
  for (const f of EXPECTED_SQL) {
    try { await db.exec(await readFile("sql/" + f, "utf8")); }
    catch (e) { console.log(`✗ pass ${pass}: ${f}: ${e.message}`); process.exit(1); }
    if (pass === 1) console.log("  · " + f);
  }
}
const n = (await db.query("select count(*)::int n from public.migrations")).rows[0].n;
if (n !== EXPECTED_SQL.length) { console.log(`✗ ${n} stamped, ${EXPECTED_SQL.length} expected`); process.exit(1); }
console.log(`✓ ${EXPECTED_SQL.length} files applied from nothing, then again; ${n} stamped`);
'
