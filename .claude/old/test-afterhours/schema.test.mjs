/* afterhours — runs the schema on a real Postgres and checks it.
   PGlite = Postgres compiled to WASM; no Docker, no psql needed.
   Let it break here, before anything is sent to Supabase.  */

import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

let passed = 0, failed = 0;
const check = (condition, name) => {
  if (condition) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name); }
};

/* Expect a statement to be refused because of RLS */
async function mustBeRefused(db, sql, name) {
  try {
    await db.exec(sql);
    failed++; console.log("  ✗ " + name + " (it should not have gone through)");
  } catch (e) {
    passed++; console.log("  ✓ " + name);
  }
}

async function asUser(db, userId) {
  await db.exec(`set role authenticated;
                 set request.jwt.claims = '{"sub":"${userId}"}';`);
}
async function asAnon(db) {
  await db.exec(`set role anon; set request.jwt.claims = '';`);
}
async function asService(db) {
  await db.exec(`reset role; set request.jwt.claims = '';`);
}

const db = new PGlite();

/* PGlite errors print the whole bundle; show only the message. */
process.on("uncaughtException", (e) => {
  console.log("\nERROR: " + (e.message || e));
  if (e.where) console.log("  " + e.where);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  console.log("\nERROR: " + ((e && e.message) || e));
  if (e && e.where) console.log("  " + e.where);
  process.exit(1);
});

console.log("\n— building the schema —");
for (const file of ["../test/supabase-shim.sql", "../sql/01_schema.sql", "../sql/02_rls.sql"]) {
  await db.exec(await read(file));
  console.log("  · " + file.split("/").pop());
}

/* ---------------------------------------------------------- fikstur */

await db.exec(`
  insert into public.cities (slug, name, status, sort_order)
  values ('munchen', 'münchen', 'live', 1), ('istanbul', 'istanbul', 'live', 2);

  insert into public.event_types (slug, name, sort_order) values
    ('rave', 'Rave', 1), ('club-night', 'Club Night', 2), ('konzert', 'Konzert', 3);

  insert into public.venues (city_id, slug, name, opens_hour, open_hours)
  select id, 'olympiahalle', 'OLYMPIAHALLE', 18.5, 4 from public.cities where slug = 'munchen';

  insert into public.events (slug, city_id, type_id, title, meta, body, poster_no)
  select 'asap-rocky', c.id, t.id, 'A$AP Rocky',
         'Olympiahalle · 11.09.26 · 18:30', 'An arena show.', 1
  from public.cities c, public.event_types t
  where c.slug = 'munchen' and t.slug = 'konzert';

  insert into public.events (slug, city_id, type_id, title, meta, is_published, poster_no)
  select 'hidden-night', c.id, t.id, 'Hidden', 'x', false, 2
  from public.cities c, public.event_types t
  where c.slug = 'munchen' and t.slug = 'rave';

  insert into auth.users (id, email) values
    ('11111111-1111-1111-1111-111111111111', 'ada@example.com'),
    ('22222222-2222-2222-2222-222222222222', 'friend@example.com'),
    ('33333333-3333-3333-3333-333333333333', 'yabanci@example.com');

  update public.profiles set is_admin = true, handle = 'ada'
  where id = '11111111-1111-1111-1111-111111111111';
`);

const ADMIN = "11111111-1111-1111-1111-111111111111";
const FRIEND = "22222222-2222-2222-2222-222222222222";
const STRANGER = "33333333-3333-3333-3333-333333333333";

console.log("\n— does a new user get a profile —");
{
  const r = await db.query(`select id, is_admin from public.profiles order by created_at`);
  check(r.rows.length === 3, "all three users got a profile (trigger)");
  check(r.rows.filter((s) => s.is_admin).length === 1, "there is exactly one admin");
}

console.log("\n— looking around signed out —");
{
  await asAnon(db);
  const r = await db.query(`select slug from public.events`);
  check(r.rows.length === 1 && r.rows[0].slug === "asap-rocky",
    "signed out, only the published event is visible");

  const y = await db.query(`select count(*)::int as n from public.venues`);
  check(y.rows[0].n === 1, "signed out, the venues can be read");

  await mustBeRefused(db,
    `insert into public.events (slug, city_id, type_id, title, meta)
     select 'korsan', c.id, t.id, 'Korsan', 'x' from public.cities c, public.event_types t limit 1`,
    "signed out, no event can be added");
}

console.log("\n— a signed-in user —");
{
  await asUser(db, FRIEND);
  await mustBeRefused(db,
    `insert into public.events (slug, city_id, type_id, title, meta)
     select 'korsan2', c.id, t.id, 'Korsan', 'x' from public.cities c, public.event_types t limit 1`,
    "an ordinary user cannot add an event");

  await mustBeRefused(db,
    `update public.profiles set is_admin = true where id = '${FRIEND}'`,
    "a user cannot make themselves an admin");

  /* user_id is not sent: it defaults to auth.uid(). The browser never
     has to say who it is writing as. */
  await db.exec(`insert into public.swipes (event_id, direction)
                 select id, 'right' from public.events where slug = 'asap-rocky'`);
  const r = await db.query(`select user_id from public.swipes`);
  check(r.rows.length === 1, "you can record your own swipe");
  check(r.rows[0].user_id === FRIEND, "user_id was filled in from the session");

  await mustBeRefused(db,
    `insert into public.swipes (user_id, event_id, direction)
     select '${STRANGER}', id, 'right' from public.events where slug = 'asap-rocky'`,
    "you cannot swipe in someone else's name");
}

console.log("\n— are the swipes private —");
{
  await asUser(db, STRANGER);
  const r = await db.query(`select count(*)::int as n from public.swipes`);
  check(r.rows[0].n === 0, "a stranger cannot see anyone else's swipes");

  await asService(db);
  await db.exec(`insert into public.friendships (requester_id, addressee_id, status)
                 values ('${FRIEND}', '${STRANGER}', 'accepted')`);

  await asUser(db, STRANGER);
  const s = await db.query(`select direction from public.swipes`);
  check(s.rows.length === 1 && s.rows[0].direction === "right",
    "you see what a confirmed friend swiped RIGHT");

  await asService(db);
  await db.exec(`insert into public.swipes (user_id, event_id, direction)
                 select '${FRIEND}', id, 'left' from public.events where slug = 'hidden-night'`);
  await asUser(db, STRANGER);
  const l = await db.query(`select count(*)::int as n from public.swipes where direction = 'left'`);
  check(l.rows[0].n === 0, "what a friend swiped LEFT stays hidden");
}

console.log("\n— the comments —");
{
  await asService(db);
  const e = await db.query(`select id from public.events where slug = 'asap-rocky'`);
  const eid = e.rows[0].id;
  const k = await db.query(
    `insert into public.comments (event_id, author_name, body) values ($1, 'lena_k', 'sample topic') returning id`,
    [eid]);
  const topicId = k.rows[0].id;
  await db.exec(`insert into public.comments (event_id, parent_id, author_name, body)
                 values ('${eid}', '${topicId}', 'tobi', 'sample reply')`);

  await mustBeRefused(db,
    `insert into public.comments (event_id, parent_id, author_name, body)
     select '${eid}', id, 'x', 'reply to a reply'
     from public.comments where parent_id = '${topicId}' limit 1`,
    "a reply cannot be replied to (two levels)");

  await mustBeRefused(db,
    `insert into public.comments (event_id, parent_id, author_name, body)
     select id, '${topicId}', 'x', 'reply on another event' from public.events where slug = 'hidden-night'`,
    "a reply cannot hang off another event");

  await asUser(db, STRANGER);
  await mustBeRefused(db,
    `insert into public.comments (event_id, author_id, body) values ('${eid}', '${FRIEND}', 'forged')`,
    "you cannot comment in someone else's name");

  await db.exec(`insert into public.comments (event_id, author_id, body)
                 values ('${eid}', '${STRANGER}', 'my own comment')`);
  const c = await db.query(`select count(*)::int as n from public.comments`);
  check(c.rows[0].n === 3, "you can comment in your own name");

  /* Under RLS a DELETE does not error, it simply removes no rows.
     So the right measurement is: is the comment still there. */
  await db.exec(`delete from public.comments where author_name = 'lena_k'`);
  await asService(db);
  const stillThere = await db.query(
    `select count(*)::int as n from public.comments where author_name = 'lena_k'`);
  check(stillThere.rows[0].n === 1, "someone else's comment was not deleted (RLS blocked it quietly)");
}

console.log("\n— the admin —");
{
  await asUser(db, ADMIN);
  const r = await db.query(`select count(*)::int as n from public.events`);
  check(r.rows[0].n === 2, "the admin sees the unpublished one too");

  await db.exec(`insert into public.events (slug, city_id, type_id, title, meta)
                 select 'new-night', c.id, t.id, 'New', 'Venue · 01.01' 
                 from public.cities c, public.event_types t
                 where c.slug = 'munchen' and t.slug = 'rave'`);
  const s = await db.query(`select count(*)::int as n from public.events`);
  check(s.rows[0].n === 3, "the admin can add an event");

  const g = await db.query(`select count(*)::int as n from public.swipes`);
  check(g.rows[0].n === 0, "not even the admin can see who swiped what");
}

console.log("\n— the constraints —");
{
  await asService(db);
  await mustBeRefused(db,
    `insert into public.swipes (user_id, event_id, direction)
     select '${FRIEND}', id, 'up' from public.events limit 1`,
    "an invalid direction is refused");

  await mustBeRefused(db,
    `insert into public.friendships (requester_id, addressee_id) values ('${ADMIN}', '${ADMIN}')`,
    "you cannot befriend yourself");

  await mustBeRefused(db,
    `insert into public.swipes (user_id, event_id, direction)
     select '${FRIEND}', id, 'left' from public.events where slug = 'asap-rocky'`,
    "the same card cannot be swiped twice");

  await mustBeRefused(db, `insert into public.comments (event_id, body)
     select id, 'no author' from public.events limit 1`,
    "a comment with no author is refused");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
