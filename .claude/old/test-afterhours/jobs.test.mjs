/* afterhours — arka plan isleri */

import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

const read = (y) => readFile(new URL(y, import.meta.url), "utf8");
let passed = 0, failed = 0;
const check = (k, name, extra = "") => {
  if (k) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
};
process.on("unhandledRejection", (e) => {
  console.log("\nERROR: " + ((e && e.message) || e)); process.exit(1);
});

const db = new PGlite();
for (const d of ["../test/supabase-shim.sql", "../sql/01_schema.sql", "../sql/02_rls.sql",
                 "../sql/03_seed_catalog.sql", "../sql/04_seed_events.sql",
                 "../sql/06_views.sql", "../sql/09_jobs.sql"]) {
  await db.exec(await read(d));
}

console.log("\n— dropping what is past —");
{
  /* First push the whole seed into the future. Otherwise the test hangs
     on the calendar: before a night in the seed really does go past
     (29.08.26, rote-sonne-bahnwarter) the job drops that one too and the
     counts shift. What this test measures is the rule, not the date. */
  await db.exec(`
    update public.events set starts_at = now() + interval '30 days'
      where starts_at is not null;
  `);

  /* Four situations: past+confirmed, past+guessed, future, and one
     whose night is not over yet */
  await db.exec(`
    update public.events set starts_at = now() - interval '3 days',
                             starts_at_estimated = false
      where slug = 'asap-rocky';
    update public.events set starts_at = now() - interval '3 days',
                             starts_at_estimated = true
      where slug = 'nick-cave';
    update public.events set starts_at = now() + interval '3 days',
                             starts_at_estimated = false
      where slug = 'blitz';
    update public.events set starts_at = now() - interval '2 hours',
                             starts_at_estimated = false
      where slug = 'strobo';
  `);

  const n = await db.query(`select public.hide_past_events() as n`);
  check(n.rows[0].n === 1, "exactly one event was dropped", "dropped " + n.rows[0].n);

  const d = await db.query(`select slug, is_published from public.events
                            where slug in ('asap-rocky','nick-cave','blitz','strobo')
                            order by slug`);
  const status = Object.fromEntries(d.rows.map((r) => [r.slug, r.is_published]));
  check(status["asap-rocky"] === false, "past + confirmed date → dropped");
  check(status["nick-cave"] === true,
    "past but UNCONFIRMED date → left alone (it could be wrong)");
  check(status["blitz"] === true, "a future event stays");
  check(status["strobo"] === true, "one that started 2 hours ago stays (the night is not over)");

  const again = await db.query(`select public.hide_past_events() as n`);
  check(again.rows[0].n === 0, "ikinci calisma one sey degistirmiyor");
}

console.log("\n— the health summary —");
{
  const h = await db.query(`select * from public.health()`);
  const s = h.rows[0];
  check(Number(s.events) === 36, "36 events counted");
  check(Number(s.published) === 35, "one shows as dropped");
  check(Number(s.unverified_date) > 0, "unconfirmed dates are reported");
  check(Number(s.missing_venue) === 8, "the ones with no venue are reported");
  check(Number(s.friendships) === 0, "friend connections are counted (none yet)");
}

console.log("\n— who may run the job —");
{
  /* The drop is pg_cron's to run (as the owner). Postgres hands EXECUTE
     on a new function to everyone; the revoke in 09 takes it back, or any
     browser could fire it through the API. */
  await db.exec(`set role authenticated;
                 set request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111"}';`);
  let refused = null;
  try { await db.query(`select public.hide_past_events()`); }
  catch (e) { refused = e.message; }
  check(/permission denied/i.test(refused || ""), "a signed-in browser cannot trigger the drop");

  await db.exec(`set role anon; set request.jwt.claims = '';`);
  let anonRefused = null;
  try { await db.query(`select public.hide_past_events()`); }
  catch (e) { anonRefused = e.message; }
  check(/permission denied/i.test(anonRefused || ""), "anonymous cannot either");
  await db.exec(`reset role; set request.jwt.claims = '';`);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
