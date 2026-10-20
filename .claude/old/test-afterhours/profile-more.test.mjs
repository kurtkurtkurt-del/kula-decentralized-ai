/* afterhours — a longer bio, a text about you, links to other networks */

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
                 "../sql/03_seed_catalog.sql", "../sql/06_views.sql", "../sql/07_friends.sql",
                 "../sql/12_profiles.sql", "../sql/29_profile_more.sql"]) {
  await db.exec(await read(d));
}
await db.exec(await read("../sql/29_profile_more.sql"));

const A = "aaaaaaaa-1111-1111-1111-111111111111";   /* me */
const B = "bbbbbbbb-2222-2222-2222-222222222222";   /* my friend */
const C = "cccccccc-3333-3333-3333-333333333333";   /* a stranger who knows my handle */
const D = "dddddddd-4444-4444-4444-444444444444";   /* hidden: discoverable off */

const asUser = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const rows = async (sql) => (await db.query(sql)).rows;
const one = async (sql) => (await rows(sql))[0];

await asService();
await db.exec(`
  insert into auth.users (id, email) values ('${A}', 'a@x.com'), ('${B}', 'b@x.com'), ('${C}', 'c@x.com'), ('${D}', 'd@x.com');
  update public.profiles set handle = 'ada' where id = '${A}';
  update public.profiles set handle = 'berk'  where id = '${B}';
  update public.profiles set handle = 'cansu' where id = '${C}';
  update public.profiles set handle = 'deniz' where id = '${D}';
  update public.profile_settings set discoverable = false where user_id = '${D}';
  insert into public.friendships (requester_id, addressee_id, status) values ('${A}', '${B}', 'accepted');
`);

console.log("\n— bio and about —");
{
  await asUser(A);
  check(!(await fails(`update public.profiles set bio = repeat('x', 300) where id = '${A}'`)), "a bio of 300 characters fits now");
  check(Boolean(await fails(`update public.profiles set bio = repeat('x', 301) where id = '${A}'`)), "301 does not");
  await db.exec(`select public.profile_about_set('  nights out, records, long walks home.  ')`);
  const me = await one(`select about from public.profile_extra()`);
  check(me.about === "nights out, records, long walks home.", "the text about you is saved, trimmed");
  check(Boolean(await fails(`select public.profile_about_set(repeat('x', 1501))`)), "1500 characters at most");
  await db.exec(`select public.profile_about_set('')`);
  check((await one(`select about from public.profile_extra()`)).about === null, "an empty text clears it");
  await db.exec(`select public.profile_about_set('nights out.')`);
}

console.log("\n— links —");
{
  await asUser(A);
  const ok = await one(`select public.profile_links_set('{"instagram":"@ada.k","spotify":"adak","website":"https://ada.example"}') as r`);
  check(ok.r === "ok", "links are saved");
  const mine = (await one(`select links from public.profile_extra()`)).links;
  check(mine.instagram === "ada.k" && mine.spotify === "adak" && mine.website === "https://ada.example", "a leading @ is dropped", JSON.stringify(mine));

  const bad = await one(`select public.profile_links_set('{"tiktok":"two words","x":"fine"}') as r`);
  check(bad.r === "format:tiktok", "a name with a space is refused, by its kind");
  check(!(await one(`select links from public.profile_extra()`)).links.x, "and nothing of that call is written");
  check((await one(`select public.profile_links_set('{"website":"javascript:alert(1)"}') as r`)).r === "format:website", "a website must be http(s)");
  check((await one(`select public.profile_links_set('{"myspace":"x"}') as r`)).r === "format:myspace", "unknown networks are refused");

  await db.exec(`select public.profile_links_set('{"spotify":""}')`);
  const after = (await one(`select links from public.profile_extra()`)).links;
  check(!after.spotify && after.instagram === "ada.k", "an empty value clears that one, the others stay");
}

console.log("\n— who sees what —");
{
  await asUser(B);
  const b = await one(`select about, links from public.profile_extra('ada')`);
  check(b.about === "nights out." && b.links.instagram === "ada.k", "a friend sees the text and the links");

  await asUser(C);
  const c = await one(`select about, links from public.profile_extra('@ada')`);
  check(c.about === "nights out." && Object.keys(c.links).length === 0, "a stranger sees the text but no links");
  check((await rows(`select 1 from public.profile_extra('deniz')`)).length === 0, "a hidden person shows nothing");

  check(Boolean(await fails(`select * from public.profile_links`)), "the links table cannot be read directly");
  check(Boolean(await fails(`insert into public.profile_links (user_id, kind, value) values ('${A}', 'x', 'hacked')`)), "nor written directly");

  await asAnon();
  check(Boolean(await fails(`select * from public.profile_extra('ada')`)), "signed out, closed");
}

console.log("\n— leaving —");
{
  await asService();
  await db.exec(`delete from auth.users where id = '${A}'`);
  check((await rows(`select 1 from public.profile_links where user_id = '${A}'`)).length === 0, "deleting the account removes the links");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
