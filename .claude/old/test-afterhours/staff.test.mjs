/* afterhours — the staff: admin, community managers, djs (42) */

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
                 "../sql/03_seed_catalog.sql", "../sql/06_views.sql", "../sql/12_profiles.sql",
                 "../sql/13_feedback.sql", "../sql/15_ticketmaster.sql", "../sql/18_geo.sql",
                 "../sql/20_djs.sql", "../sql/41_account_types.sql", "../sql/42_staff.sql"]) {
  await db.exec(await read(d));
}

const ADMIN = "aaaaaaaa-1111-1111-1111-111111111111";
const CM = "bbbbbbbb-2222-2222-2222-222222222222";
const DJ = "cccccccc-3333-3333-3333-333333333333";
const U = "dddddddd-4444-4444-4444-444444444444";
const SNEAK = "eeeeeeee-5555-5555-5555-555555555555";
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const one = async (sql) => (await db.query(sql)).rows[0];
const rows = async (sql) => (await db.query(sql)).rows;
const role = async (id) => { await asService(); const r = await one(`select account_type from public.profiles where id = '${id}'`); return r.account_type; };

await asService();
await db.exec(`insert into auth.users (id, email) values ('${ADMIN}', 'a@x.com'), ('${CM}', 'b@x.com'),
  ('${DJ}', 'c@x.com'), ('${U}', 'd@x.com'), ('${SNEAK}', 'e@x.com')`);
// One who used the 41 code to become "admin" before 42 arrived.
await db.exec(`update public.profiles set account_type = 'admin' where id = '${SNEAK}'`);
await db.exec(await read("../sql/42_staff.sql"));
await db.exec(`update public.profiles set is_admin = true where id = '${ADMIN}'`);
await db.exec(await read("../sql/42_staff.sql"));
const city = (await one(`select slug from public.cities order by sort_order limit 1`)).slug;
const other = (await one(`select slug from public.cities order by sort_order offset 1 limit 1`)).slug;
const kind = (await one(`select slug from public.event_types order by sort_order limit 1`)).slug;
const soon = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);

console.log("\n— who is who —");
{
  check((await role(SNEAK)) === "user", "an admin by code under 41 is a normal user again");
  check((await role(ADMIN)) === "admin", "the real admin shows as admin");
  await as(U);
  check((await one(`select public.set_account_type('admin', 'admin') as r`)).r === "locked", "the code no longer reaches admin");
  check((await one(`select public.set_account_type('community_manager', 'community manager') as r`)).r === "locked", "nor community manager");
  await as(DJ);
  check((await one(`select public.set_account_type('dj', 'dj') as r`)).r === "ok", "dj still comes with its code");
  await as(CM);
  check(Boolean(await fails(`select public.admin_set_type('${CM}', 'community_manager')`)), "only the admin gives types");
  await as(ADMIN);
  check((await one(`select public.admin_set_type('${CM}', 'community_manager') as r`)).r === "ok", "the admin makes a community manager");
  check((await one(`select public.admin_set_type('${ADMIN}', 'user') as r`)).r === "admin", "an admin cannot be changed from the panel");
  check((await one(`select public.admin_set_type('${U}', 'admin') as r`)).r === "type", "nor can the panel make admins");
  check((await rows(`select * from public.admin_people('')`))[0].role !== "user", "people: the staff come first");
  await as(CM);
  check((await one(`select public.my_role() as r`)).r === "community_manager" && (await one(`select public.is_staff() as s`)).s, "the manager is staff");
  check((await one(`select public.set_account_type('user', 'normal user') as r`)).r === "locked", "and cannot code their way out of it");
}

console.log("\n— a community manager makes a room and a night —");
let venue, slug, nightId;
{
  await as(CM);
  venue = (await one(`select public.staff_venue_save(null, '${city}', 'Blitz Club', 48.13, 11.58) as v`)).v;
  check(Boolean(venue), "a room");
  check(/city/.test(await fails(`select public.staff_venue_save(null, 'nowhere', 'X Club', null, null)`)), "an unknown city is refused");
  slug = (await one(`select public.staff_event_save(null, 'Klub Nacht', '${city}', '${kind}', '${venue}', '${soon}', '23:30', 'all night', 'https://tickets.example/1', null, true) as s`)).s;
  check(/^klub-nacht-[0-9a-f]{6}$/.test(slug), "a night, with its slug", slug);
  await asAnon();
  const pub = await one(`select title, meta, source from public.events where slug = '${slug}'`);
  check(pub && pub.meta.startsWith("Blitz Club · ") && pub.source === "staff", "anyone sees it, with the room in its line", JSON.stringify(pub));
  await as(CM);
  check(/room/.test(await fails(`select public.staff_event_save(null, 'Xy', '${other}', '${kind}', '${venue}', '${soon}', '23:00', '', null, null, true)`) ?? ""), "a room from another city is refused");
  check(/https/.test(await fails(`select public.staff_event_save(null, 'Xy', '${city}', '${kind}', null, '${soon}', '23:00', '', 'javascript:alert(1)', null, true)`) ?? ""), "only https links");
  check(/over/.test(await fails(`select public.staff_event_save(null, 'Xy', '${city}', '${kind}', null, '2020-01-01', '23:00', '', null, null, true)`) ?? ""), "not a night in the past");
  nightId = (await one(`select id from public.staff_events(10) where slug = '${slug}'`)).id;
  check((await one(`select public.staff_event_save('${nightId}', 'Klub Nacht II', '${city}', '${kind}', null, '${soon}', '22:00', '', null, null, false) as s`)).s === slug, "editing keeps the slug");
  await asAnon();
  check(!(await one(`select 1 as x from public.events where slug = '${slug}'`)), "unpublished: gone for everyone");
  await as(CM);
  const ticketmaster = (await one(`select id from public.events where source <> 'staff' limit 1`));
  if (ticketmaster) check(Boolean(await fails(`select public.staff_event_delete('${ticketmaster.id}')`)), "nights from elsewhere are not touched");
}

console.log("\n— a normal user is not staff —");
{
  await as(U);
  check(Boolean(await fails(`select public.staff_venue_save(null, '${city}', 'Mine', null, null)`)), "no rooms");
  check(Boolean(await fails(`select public.staff_event_save(null, 'Mine', '${city}', '${kind}', null, '${soon}', '23:00', '', null, null, true)`)), "no nights");
  check(Boolean(await fails(`select public.staff_dj_save(null, 'Me', 'house', 'house', null, null, null)`)), "no djs");
  check((await rows(`select * from public.staff_events(10)`)).length === 0, "and sees no list");
  check(Boolean(await fails(`select public.admin_overview()`)), "nor the numbers");
  check(Boolean(await fails(`insert into public.events (slug, city_id, type_id, title, meta) select 'x', c.id, t.id, 'x', 'x' from public.cities c, public.event_types t limit 1`)), "nor straight into the table");
  await asAnon();
  check(Boolean(await fails(`select public.staff_events(10)`)), "signed out: nothing");
}

console.log("\n— a dj runs their own page —");
let mine;
{
  await as(U);
  check(/dj first/.test(await fails(`select public.dj_save_mine('Me', 'house', 'house', null, null, null)`) ?? ""), "a normal user must switch to dj first");
  await as(DJ);
  const s1 = (await one(`select public.dj_save_mine('Nova', 'deep house', 'house', '${city}', 'from the basement', null) as s`)).s;
  const s2 = (await one(`select public.dj_save_mine('Nova K', 'deep house', 'techno', '${city}', null, null) as s`)).s;
  check(s1 === s2, "one page per dj: saving again edits it");
  mine = (await one(`select * from public.dj_mine()`));
  check(mine.name === "Nova K" && mine.sound === "techno", "and it reads back");
  await asAnon();
  check(Boolean(await one(`select 1 as x from public.djs where slug = '${s1}'`)), "it is on the djs page for everyone");
  await as(DJ);
  const set = (await one(`select public.dj_set_add('${mine.id}', 'Blitz Club', '${city}', '${soon}', '01:00', 4) as s`)).s;
  check(Boolean(set), "the dj lists a night they play");
  await as(CM);
  const theirs = (await one(`select public.staff_dj_save(null, 'Resident', 'techno', 'techno', '${city}', null, 'https://x/y.jpg') as s`)).s;
  const theirsId = (await one(`select id from public.djs where slug = '${theirs}'`)).id;
  await as(DJ);
  check(Boolean(await fails(`select public.dj_set_add('${theirsId}', 'Blitz', '${city}', '${soon}', '01:00', 4)`)), "but not on someone else's page");
  await as(U);
  check(Boolean(await fails(`select public.dj_set_delete('${set}')`)), "nobody else deletes the set");
  await as(DJ);
  await db.exec(`select public.dj_set_delete('${set}')`);
  check((await rows(`select * from public.dj_sets_of('${mine.id}')`)).length === 0, "the dj deletes it");
}

console.log("\n— deleting, comments, the log —");
{
  await as(ADMIN);
  const adminNight = (await one(`select public.staff_event_save(null, 'Admin Nacht', '${city}', '${kind}', null, '${soon}', '23:00', '', null, null, true) as s`)).s;
  const adminId = (await one(`select id from public.events where slug = '${adminNight}'`)).id;
  await as(CM);
  check(Boolean(await fails(`select public.staff_event_delete('${adminId}')`)), "a manager cannot delete what someone else made");
  await db.exec(`select public.staff_event_delete('${nightId}')`);
  await asService();
  check(!(await one(`select 1 as x from public.events where id = '${nightId}'`)), "but deletes their own");
  await as(ADMIN);
  await db.exec(`select public.staff_event_delete('${adminId}')`);
  check(!(await one(`select 1 as x from public.events where id = '${adminId}'`)), "the admin deletes any");

  const kept = (await one(`select public.staff_event_save(null, 'Talk Nacht', '${city}', '${kind}', null, '${soon}', '23:00', '', null, null, true) as s`)).s;
  await asService();
  const ev = (await one(`select id from public.events where slug = '${kept}'`));
  {
    await db.exec(`insert into public.comments (event_id, author_id, body) values ('${ev.id}', '${U}', 'rude words')`);
    await as(CM);
    const c = (await rows(`select * from public.staff_comments(10)`))[0];
    check(c && c.body === "rude words", "staff see the newest comments");
    await db.exec(`select public.staff_comment_hide('${c.id}', true)`);
    await as(U);
    check(!(await one(`select 1 as x from public.comments where id = '${c.id}' and author_id <> '${U}'`)), "a hidden comment");
    await as(U);
    check(Boolean(await fails(`select public.staff_comment_hide('${c.id}', false)`)), "users cannot hide or show");
  }

  await as(ADMIN);
  const log = await rows(`select * from public.admin_log(100)`);
  check(log.some((l) => l.action === "role" && /community_manager/.test(l.note)), "the log has the role change");
  check(log.some((l) => l.action === "create" && l.target === "night"), "and the nights");
  const o = (await one(`select public.admin_overview() as o`)).o;
  check(o.managers === 1 && o.feedback_open === 0, "the numbers", JSON.stringify(o));
  await as(CM);
  check(Boolean(await fails(`select public.admin_log(10)`)), "the log is the admin's");
  check((await one(`select public.admin_overview() as o`)).o.feedback_open === null, "and so is the feedback count");
  check(Boolean(await fails(`select * from public.staff_log`)), "the log table is closed");
  await as(U);
  check(Boolean(await fails(`select public.staff_note('x', 'x', null, null)`)), "nobody writes the log by hand");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
