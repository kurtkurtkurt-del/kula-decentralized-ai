/* afterhours — the waves: nights kept by friends of friends, and one step further */

import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

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
for (const d of ["../test/supabase-shim.sql", "../sql/01_schema.sql", "../sql/02_rls.sql",
                 "../sql/03_seed_catalog.sql", "../sql/04_seed_events.sql", "../sql/06_views.sql",
                 "../sql/07_friends.sql", "../sql/12_profiles.sql", "../sql/15_ticketmaster.sql",
                 "../sql/33_waves.sql"]) {
  await db.exec(await read(d));
}
/* a second run must not trip over the first */
await db.exec(await read("../sql/33_waves.sql"));

/* A — B — C — D — E, plus B — X (a second way to C: X — C), F pending with A, G alone */
const A = "aaaaaaaa-1111-1111-1111-111111111111";
const B = "bbbbbbbb-2222-2222-2222-222222222222";
const C = "cccccccc-3333-3333-3333-333333333333";
const D = "dddddddd-4444-4444-4444-444444444444";
const E = "eeeeeeee-5555-5555-5555-555555555555";
const F = "ffffffff-6666-6666-6666-666666666666";
const G = "99999999-7777-7777-7777-777777777777";
const X = "12121212-8888-8888-8888-888888888888";

const asUser = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
await db.exec(`
  insert into auth.users (id, email) values
    ('${A}', 'a@x.com'), ('${B}', 'b@x.com'), ('${C}', 'c@x.com'), ('${D}', 'd@x.com'),
    ('${E}', 'e@x.com'), ('${F}', 'f@x.com'), ('${G}', 'g@x.com'), ('${X}', 'x@x.com');
  update public.profiles set handle = 'ada' where id = '${A}';
  update public.profiles set handle = 'berk'  where id = '${B}';
  update public.profiles set handle = 'cansu' where id = '${C}';
  update public.profiles set handle = 'deniz' where id = '${D}';
  update public.profiles set handle = 'ece'   where id = '${E}';
  update public.profiles set handle = 'fatma' where id = '${F}';
  update public.profiles set handle = 'xavi'  where id = '${X}';
  insert into public.friendships (requester_id, addressee_id, status) values
    ('${A}', '${B}', 'accepted'),
    ('${C}', '${B}', 'accepted'),
    ('${B}', '${X}', 'accepted'),
    ('${X}', '${C}', 'accepted'),
    ('${C}', '${D}', 'accepted'),
    ('${D}', '${E}', 'accepted'),
    ('${F}', '${A}', 'pending');
`);
/* three nights: two to come, one past */
const ev = (await rows(`select id from public.events order by slug limit 3`)).map((r) => r.id);
await db.exec(`
  update public.events set starts_at = now() + interval '2 days' where id = '${ev[0]}';
  update public.events set starts_at = now() + interval '3 days' where id = '${ev[1]}';
  update public.events set starts_at = now() - interval '3 days' where id = '${ev[2]}';
  insert into public.swipes (user_id, event_id, direction) values
    ('${B}', '${ev[0]}', 'right'),
    ('${C}', '${ev[0]}', 'right'),
    ('${D}', '${ev[1]}', 'right'),
    ('${D}', '${ev[2]}', 'right'),
    ('${E}', '${ev[1]}', 'right'),
    ('${E}', '${ev[0]}', 'left'),
    ('${F}', '${ev[1]}', 'right');
`);

const waves = async (who) => { await asUser(who); return rows(`select wave, via, id from public.waves_kept()`); };

console.log("\n— the waves —");
{
  const w = await waves(A);
  const by = (who) => w.filter((r) => r.via[r.via.length - 1] === who);
  check(by("berk").length === 0, "my friend's keeps are not in the waves (that is friends' deck)");
  check(by("cansu").length === 1 && by("cansu")[0].wave === 2, "a friend of a friend is the 2nd wave", JSON.stringify(by("cansu")));
  check(JSON.stringify(by("cansu")[0]?.via) === JSON.stringify(["berk", "cansu"]), "the chain is the shortest one, starting with my friend");
  check(by("deniz").length === 1 && by("deniz")[0].wave === 3, "one step further is the 3rd wave");
  check(JSON.stringify(by("deniz")[0]?.via) === JSON.stringify(["berk", "cansu", "deniz"]), "the 3rd wave names the whole chain");
  check(by("ece").length === 0, "four steps away is out of reach");
  check(by("fatma").length === 0, "a pending request carries nothing");
  check(!w.some((r) => r.id === ev[2]), "a night that is over is not shown");
  check(w.length === 2 && w[0].id === ev[0], "soonest first", JSON.stringify(w.map((r) => r.id)));
  check(by("xavi").length === 0, "someone who kept nothing is not shown");
}

console.log("\n— a closed keeper —");
{
  await asService();
  await db.exec(`insert into public.profile_settings (user_id, kept_visibility) values ('${C}', 'private')
                 on conflict (user_id) do update set kept_visibility = 'private'`);
  const w = await waves(A);
  check(!w.some((r) => r.via.includes("cansu")), "someone with private keeps is not shown, nor named on a chain");
  check(w.length === 0, "and the 3rd wave behind them goes quiet too (no other open chain)", JSON.stringify(w));
  await asService();
  await db.exec(`update public.profile_settings set kept_visibility = 'friends' where user_id = '${C}'`);
}

console.log("\n— nobody —");
{
  check((await waves(G)).length === 0, "someone without friends has empty waves");
}

console.log("\n— closed —");
{
  await asUser(A);
  check(Boolean(await fails(`select * from public.wave_paths('${A}')`)), "the walk itself cannot be called from the app");
  await asAnon();
  check(Boolean(await fails(`select * from public.waves_kept()`)), "signed out, closed");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
