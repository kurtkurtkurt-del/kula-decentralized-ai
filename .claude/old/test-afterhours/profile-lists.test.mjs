/* afterhours — WhatsApp among the links, and the lists under a profile (38) */

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
                 "../sql/07_friends.sql", "../sql/12_profiles.sql", "../sql/29_profile_more.sql",
                 "../sql/38_profile_lists.sql"]) {
  await db.exec(await read(d));
}
await db.exec(await read("../sql/38_profile_lists.sql"));

const A = "aaaaaaaa-1111-1111-1111-111111111111";   /* me */
const B = "bbbbbbbb-2222-2222-2222-222222222222";   /* my friend */
const C = "cccccccc-3333-3333-3333-333333333333";   /* a stranger */
const E = "eeeeeeee-5555-5555-5555-555555555555";   /* a friend who keeps nights private */

const asUser = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const rows = async (sql) => (await db.query(sql)).rows;
const one = async (sql) => (await rows(sql))[0];

await asService();
await db.exec(`
  insert into auth.users (id, email) values ('${A}', 'a@x.com'), ('${B}', 'b@x.com'), ('${C}', 'c@x.com'), ('${E}', 'e@x.com');
  update public.profiles set handle = 'ada' where id = '${A}';
  update public.profiles set handle = 'berk'  where id = '${B}';
  update public.profiles set handle = 'cansu' where id = '${C}';
  update public.profiles set handle = 'ece'   where id = '${E}';
  update public.profile_settings set kept_visibility = 'private' where user_id = '${E}';
  insert into public.friendships (requester_id, addressee_id, status) values
    ('${A}', '${B}', 'accepted'), ('${E}', '${A}', 'accepted'), ('${B}', '${C}', 'accepted');
`);
const evs = (await rows(`select id from public.events where is_published order by slug limit 3`)).map((r) => r.id);
await db.exec(`
  insert into public.swipes (user_id, event_id, direction) values
    ('${B}', '${evs[0]}', 'right'), ('${B}', '${evs[1]}', 'left'), ('${E}', '${evs[2]}', 'right'), ('${A}', '${evs[2]}', 'right');
`);

console.log("\n— whatsapp —");
{
  await asUser(A);
  const r = await one(`select public.profile_links_set('{"whatsapp": "+49 151-234 5678"}') as r`);
  check(r.r === "ok", "a number with +, spaces and dashes is taken", r.r);
  const x = await one(`select links from public.profile_extra(null)`);
  check(x.links.whatsapp === "491512345678", "and stored as digits", JSON.stringify(x.links));
  const bad = await one(`select public.profile_links_set('{"whatsapp": "call me"}') as r`);
  check(bad.r === "format:whatsapp", "words are not a number");
  const old = await one(`select public.profile_links_set('{"instagram": "@ada"}') as r`);
  check(old.r === "ok", "the other kinds still work");
}

console.log("\n— kept nights —");
{
  await asUser(A);
  check((await rows(`select id from public.person_kept('berk')`)).length === 1, "a friend: their right swipes only");
  check((await rows(`select id from public.person_kept('ece')`)).length === 0, "a friend who keeps them private: nothing");
  check((await rows(`select id from public.person_kept('ada')`)).length === 1, "mine");
  check((await rows(`select id from public.person_kept('cansu')`)).length === 0, "a stranger: nothing");
}

console.log("\n— their people —");
{
  await asUser(A);
  const b = (await rows(`select handle from public.person_people('berk')`)).map((r) => r.handle);
  check(b.join(",") === "ada,cansu", "a friend: their confirmed friends", b.join(","));
  const me = (await rows(`select handle from public.person_people('ada')`)).map((r) => r.handle);
  check(me.join(",") === "berk,ece", "mine, both directions", me.join(","));
  check((await rows(`select handle from public.person_people('cansu')`)).length === 0, "a stranger: nothing");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
