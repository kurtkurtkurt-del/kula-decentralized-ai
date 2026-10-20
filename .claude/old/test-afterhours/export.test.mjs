/* afterhours — taking your data with you.
   The GDPR calls it the right of access and the right to portability, and
   datenschutz says the site honours both. So export_me() has to hand a
   person everything about them — and nothing about anybody else.

   That second half is the one worth testing. A function that runs as its
   owner and reads five tables is exactly the shape that leaks.  */

import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

let passed = 0, failed = 0;
const check = (condition, name, extra = "") => {
  if (condition) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name + (extra ? "  → " + extra : "")); }
};
process.on("unhandledRejection", (e) => {
  console.error("\nERROR: " + (e && e.message ? e.message : e));
  process.exit(1);
});

const db = new PGlite();
for (const f of ["../test/supabase-shim.sql", "../sql/00_migrations.sql",
  "../sql/01_schema.sql", "../sql/02_rls.sql", "../sql/03_seed_catalog.sql",
  "../sql/04_seed_events.sql", "../sql/06_views.sql", "../sql/07_friends.sql",
  "../sql/09_jobs.sql", "../sql/12_profiles.sql", "../sql/13_feedback.sql",
  "../sql/14_export.sql"]) await db.exec(await read(f));

const ME = "aaaaaaaa-1111-1111-1111-111111111111";
const OTHER = "bbbbbbbb-2222-2222-2222-222222222222";
const asUser = (id) => db.exec(
  `set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);

await db.exec(`
  insert into auth.users (id, email) values
    ('${ME}', 'me@example.com'),
    ('${OTHER}', 'other@example.com');
  update public.profiles set handle = 'ada', display_name = 'owner',
         bio = 'one line about me',
         city_id = (select id from public.cities where slug = 'munchen')
   where id = '${ME}';
  update public.profiles set handle = 'lena', display_name = 'Lena'
   where id = '${OTHER}';`);

/* Something of mine in every table, and something of theirs beside it. */
await db.exec(`
  insert into public.swipes (user_id, event_id, direction)
  select '${ME}', id, 'right' from public.events where slug = 'asap-rocky';
  insert into public.swipes (user_id, event_id, direction)
  select '${OTHER}', id, 'right' from public.events where slug = 'blitz';

  insert into public.comments (event_id, author_id, body)
  select id, '${ME}', 'i will be there' from public.events where slug = 'asap-rocky';
  insert into public.comments (event_id, author_id, body)
  select id, '${OTHER}', 'so will i, apparently' from public.events where slug = 'blitz';

  insert into public.friendships (requester_id, addressee_id, status)
  values ('${ME}', '${OTHER}', 'accepted');

  insert into public.feedback (author_id, kind, body)
  values ('${ME}', 'idea', 'a thought i had about the deck and its filters');
  insert into public.feedback (author_id, kind, body)
  values ('${OTHER}', 'broken', 'something of theirs that is none of my business');`);

const exportFor = async (id) => {
  await asUser(id);
  const r = await db.query(`select public.export_me() as d`);
  return r.rows[0].d;
};

console.log("\n— what comes back —");
const mine = await exportFor(ME);
{
  check(Boolean(mine), "an account gets an answer at all");
  check(mine.profile && mine.profile.handle === "ada", "the profile is mine",
    JSON.stringify(mine.profile));
  check(mine.profile.city === "munchen", "the city is a slug, not an id");
  check(Boolean(mine.settings), "the settings came along");
  check(mine.swipes.length === 1 && mine.swipes[0].event === "asap-rocky",
    "my one swipe, named by its event", JSON.stringify(mine.swipes));
  check(mine.comments.length === 1 && mine.comments[0].body === "i will be there",
    "my one comment");
  check(mine.friendships.length === 1 && mine.friendships[0].handle === "lena"
        && mine.friendships[0].direction === "outgoing",
    "the friendship, with its direction", JSON.stringify(mine.friendships));
  check(mine.feedback.length === 1, "the feedback i wrote");
  check(typeof mine.taken_at === "string", "it says when it was taken");
}

console.log("\n— and nothing of anybody else —");
{
  const text = JSON.stringify(mine);
  check(!text.includes("so will i, apparently"), "not their comment");
  check(!text.includes("none of my business"), "not their feedback");
  check(!text.includes("blitz"), "not the night they swiped");
  check(!text.includes("other@example.com"), "not their email");
  /* Their handle is in there, and has to be: it is half of my friendship.
     Their display name and city are not. */
  check(!text.includes("Lena"), "not their display name");
}

console.log("\n— the other side of it —");
{
  const theirs = await exportFor(OTHER);
  check(theirs.profile.handle === "lena", "they get their own, not mine");
  check(theirs.comments.length === 1 && theirs.comments[0].body.includes("so will i"),
    "their comment is theirs");
  check(theirs.friendships[0].direction === "incoming",
    "the same friendship reads the other way round",
    JSON.stringify(theirs.friendships));
  check(!JSON.stringify(theirs).includes("i will be there"), "not my comment");
}

console.log("\n— signed out —");
{
  await asAnon();
  let refused = false, empty = false;
  try {
    const r = await db.query(`select public.export_me() as d`);
    empty = r.rows.length === 0 || r.rows[0].d === null;
  } catch (_) { refused = true; }
  check(refused || empty, "signed out there is nobody to describe");
}

console.log("\n— a deleted account leaves nothing to export —");
{
  await asUser(ME);
  await db.exec(`select public.delete_account()`);
  await asService();
  const left = await db.query(
    `select count(*)::int as n from public.swipes where user_id = '${ME}'`);
  check(left.rows[0].n === 0, "the swipes went with the account");
}

/* 64: the export again, on the whole database — direct messages (59) and ticket
   answers (60) came after 14 and now come along. My lines go out; theirs stay. */
console.log("\n— messages and tickets (64) —");
{
  const full = new PGlite();
  await full.exec(await read("../test/supabase-shim.sql"));
  await full.exec(await read("../sql/setup-1-structure.sql"));
  const as = (id) => full.exec(
    `set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
  await full.exec(`
    insert into auth.users (id, email) values
      ('${ME}', 'me@example.com'), ('${OTHER}', 'other@example.com');
    update public.profiles set handle = 'ada', display_name = 'owner' where id = '${ME}';
    update public.profiles set handle = 'lena', display_name = 'Lena' where id = '${OTHER}';
    insert into public.friendships (requester_id, addressee_id, status)
    values ('${ME}', '${OTHER}', 'accepted');`);
  const night = (await full.query(
    `select slug from public.events where is_published order by starts_at nulls last limit 1`)).rows[0].slug;

  await as(ME);
  const thread = (await full.query(`select public.dm_start('lena') as t`)).rows[0].t;
  await full.query(`select public.dm_send($1, 'see you at the door')`, [thread]);
  await full.query(`select public.ticket_mark($1, 'got')`, [night]);
  await as(OTHER);
  await full.query(`select public.dm_send($1, 'their reply, not mine to take')`, [thread]);
  await full.query(`select public.ticket_mark($1, 'no')`, [night]);

  await as(ME);
  const d = (await full.query(`select public.export_me() as d`)).rows[0].d;
  check(Array.isArray(d.messages) && d.messages.length === 1
        && d.messages[0].body === "see you at the door" && d.messages[0].to === "lena",
    "my message, with the friend it went to", JSON.stringify(d.messages));
  check(!JSON.stringify(d).includes("their reply"), "not their message");
  check(Array.isArray(d.tickets) && d.tickets.length === 1
        && d.tickets[0].event === night && d.tickets[0].answer === "got",
    "my ticket answer, named by its night", JSON.stringify(d.tickets));
  check(Array.isArray(d.swipes) && Array.isArray(d.friendships) && d.friendships.length === 1,
    "the older lists are still there");

  await as(OTHER);
  const t = (await full.query(`select public.export_me() as d`)).rows[0].d;
  check(t.messages.length === 1 && t.messages[0].to === "ada"
        && t.tickets.length === 1 && t.tickets[0].answer === "no",
    "they get their own message and answer");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
