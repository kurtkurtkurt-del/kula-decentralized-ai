/* afterhours — the profile that appears after registration */

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
                 "../sql/03_seed_catalog.sql", "../sql/04_seed_events.sql",
                 "../sql/06_views.sql", "../sql/07_friends.sql", "../sql/12_profiles.sql"]) {
  await db.exec(await read(d));
}

const A = "aaaaaaaa-1111-1111-1111-111111111111";
const B = "bbbbbbbb-2222-2222-2222-222222222222";
const C = "cccccccc-3333-3333-3333-333333333333";

const asUser = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);

console.log("\n— signing up: the profile opens by itself —");
{
  await asService();
  await db.exec(`insert into auth.users (id, email) values ('${A}', 'a@x.com')`);

  const p = await db.query(`select display_name, handle, onboarded_at from public.profiles where id = '${A}'`);
  check(p.rows.length === 1, "opening an account creates a profile");
  check(p.rows[0].display_name === "a", "the display name comes from the front of the email");
  check(p.rows[0].handle === null, "handle empty: record henuz bitmedi");
  check(p.rows[0].onboarded_at === null, "onboarded_at empty");

  const s = await db.query(`select count(*)::int as n from public.profile_settings where user_id = '${A}'`);
  check(s.rows[0].n === 1, "the settings row is created too");
}

console.log("\n— when the sign-up form sends a handle and a city —");
{
  await asService();
  await db.exec(`insert into auth.users (id, email, raw_user_meta_data) values
    ('${B}', 'b@x.com', '{"name":"Lena","handle":"lena","city":"munchen"}'::jsonb)`);

  const p = await db.query(`
    select p.handle, p.display_name, c.slug as city, p.onboarded_at is not null as done
    from public.profiles p left join public.cities c on c.id = p.city_id
    where p.id = '${B}'`);
  check(p.rows[0].handle === "lena", "handle kayitta alindi");
  check(p.rows[0].display_name === "Lena", "the display name was taken at sign-up");
  check(p.rows[0].city === "munchen", "the city was linked");
  check(p.rows[0].done === true, "a handle at sign-up means registration is finished");

  /* A taken handle is dropped quietly; the account still opens */
  await db.exec(`insert into auth.users (id, email, raw_user_meta_data) values
    ('${C}', 'c@x.com', '{"handle":"lena"}'::jsonb)`);
  const c = await db.query(`select handle from public.profiles where id = '${C}'`);
  check(c.rows[0].handle === null, "a taken handle is refused but the account still opens");
}

console.log("\n— handle musait mi —");
{
  await asUser(A);
  const s = (h) => db.query(`select public.handle_status(${h}) as s`).then((r) => r.rows[0].s);
  check(await s("''") === "empty", "empty handle");
  check(await s("'AB'") === "format", "kisa/bicimsiz handle");
  check(await s("'Büyük'") === "format", "capitals and non-ascii letters are refused");
  check(await s("'lena'") === "taken", "alinmis handle");
  check(await s("'ada'") === "ok", "musait handle");
}

console.log("\n— finishing the registration —");
{
  await asUser(A);
  const r = await db.query(`select public.profile_setup('ada', 'owner', 'munchen', 'nights out, mostly') as s`);
  check(r.rows[0].s === "ok", "the profile was set up");

  const p = await db.query(`select handle, display_name, bio, onboarded_at is not null as done from public.profiles where id = '${A}'`);
  check(p.rows[0].handle === "ada" && p.rows[0].bio === "nights out, mostly", "the fields were written");
  check(p.rows[0].done === true, "registration counts as finished");

  const d = await db.query(`select public.profile_setup('lena') as s`);
  check(d.rows[0].s === "taken", "baskasinin handle'i alinamiyor");

  const y = await db.query(`select public.profile_setup('ada', null, 'yokboyle') as s`);
  check(y.rows[0].s === "nocity", "a city that does not exist is refused");

  const t = await db.query(`select public.profile_setup('ada', null, null, null) as s`);
  check(t.rows[0].s === "ok", "writing your own handle again is fine");
}

console.log("\n— your own profile —");
{
  await asUser(A);
  await db.exec(`select public.swipe_set('asap-rocky', 'right')`);
  await db.exec(`select public.swipe_set('blitz', 'left')`);
  const m = await db.query(`select * from public.profile_me()`);
  check(m.rows.length === 1, "profile_me tek row donuyor");
  check(m.rows[0].handle === "ada" && m.rows[0].city_slug === "munchen", "the handle and the city come back");
  check(m.rows[0].kept_count === 1, "only the ones swiped right are counted");
  check(m.rows[0].kept_visibility === "friends" && m.rows[0].notify_email === true,
    "the settings arrive with their defaults");
}

console.log("\n— the settings are private to the person —");
{
  await asUser(B);
  const o = await db.query(`select count(*)::int as n from public.profile_settings`);
  check(o.rows[0].n === 1, "a person sees only their own settings");

  let err = null;
  try { await db.exec(`update public.profile_settings set notify_email = false where user_id = '${A}'`); }
  catch (e) { err = e.message; }
  const remaining = await db.query(`select notify_email from public.profile_settings where user_id = '${A}'`);
  check(err !== null || remaining.rows.length === 0, "someone else's settings cannot be changed");
}

console.log("\n— someone else's profile —");
{
  await asUser(B);
  const k = await db.query(`select * from public.profile_card('ada')`);
  check(k.rows.length === 1 && k.rows[0].handle === "ada", "the card comes back");
  check(k.rows[0].is_friend === false, "we are not friends");
  check(k.rows[0].kept_count === null, "the counts are closed to a non-friend");

  await db.exec(`select public.friend_request('ada')`);
  await asUser(A);
  await db.exec(`select public.friend_request('lena')`);
  await asUser(B);
  const a = await db.query(`select is_friend, kept_count from public.profile_card('ada')`);
  check(a.rows[0].is_friend === true && a.rows[0].kept_count === 1,
    "once you are friends the counts open up");
}

console.log("\n— set to private, not even a friend sees it —");
{
  await asUser(A);
  await db.exec(`update public.profile_settings set kept_visibility = 'private' where user_id = '${A}'`);

  await asUser(B);
  const k = await db.query(`select kept_count from public.profile_card('ada')`);
  check(k.rows[0].kept_count === null, "the counts closed on the card");

  const f = await db.query(`select count(*)::int as n from public.friends_kept()`);
  check(f.rows[0].n === 0, "it does not show in a friend's deck either");

  await asUser(A);
  await db.exec(`update public.profile_settings set kept_visibility = 'friends' where user_id = '${A}'`);
  await asUser(B);
  const g = await db.query(`select count(*)::int as n from public.friends_kept()`);
  check(g.rows[0].n === 1, "turning it back on makes it visible again");
}

console.log("\n— list gezilemiyor —");
{
  await asUser(C);   /* someone with no link to anyone */
  const t = await db.query(`select count(*)::int as n from public.profiles`);
  check(t.rows[0].n === 1, "a stranger sees only their own row", "it saw " + t.rows[0].n);

  await db.exec(`set role anon; set request.jwt.claims = '';`);
  const a = await db.query(`select count(*)::int as n from public.profiles`);
  check(a.rows[0].n === 0, "signed out, no profile is visible", "it saw " + a.rows[0].n);

  await asUser(B);   /* a friend of A */
  const f = await db.query(`select count(*)::int as n from public.profiles`);
  check(f.rows[0].n === 2, "you can see a friend's row", "it saw " + f.rows[0].n);
}

console.log("\n— whoever knows the handle sees the card —");
{
  await asUser(C);
  const k = await db.query(`select * from public.profile_card('ada')`);
  check(k.rows.length === 1 && k.rows[0].display_name === "owner",
    "a stranger finds the card by handle");
  check(k.rows[0].kept_count === null, "the counts are closed to a stranger");
  check(k.rows[0].last_seen_day === null, "last seen is closed to a stranger");

  const y = await db.query(`select count(*)::int as n from public.profile_card('yokboyle')`);
  check(y.rows[0].n === 0, "olmayan name empty donuyor");
}

console.log("\n— switching it off in settings hides the card —");
{
  await asUser(A);
  await db.exec(`update public.profile_settings set discoverable = false where user_id = '${A}'`);

  await asUser(C);
  const k = await db.query(`select count(*)::int as n from public.profile_card('ada')`);
  check(k.rows[0].n === 0, "a stranger can no longer see the card");

  /* Ama adini bilen yine req gonderebiliyor: yoksa kimse ekleyemezdi */
  const i = await db.query(`select public.friend_request('ada') as s`);
  check(i.rows[0].s === "sent", "sending a request still works");

  await asUser(B);   /* arkadasi */
  const f = await db.query(`select count(*)::int as n from public.profile_card('ada')`);
  check(f.rows[0].n === 1, "a friend keeps seeing it");

  await asUser(A);
  const mine = await db.query(`select count(*)::int as n from public.profile_card('ada')`);
  check(mine.rows[0].n === 1, "you always see your own card");
  await db.exec(`update public.profile_settings set discoverable = true where user_id = '${A}'`);
}

console.log("\n— last seen, as a day —");
{
  await asUser(A);
  await db.exec(`select public.seen()`);
  await asUser(B);
  /* We ask for it as text: the driver would turn a date into a JS Date and
     invent a clock time, and we want to measure what LEAVES the database. */
  const f = await db.query(`select last_seen_day::text as g from public.profile_card('ada')`);
  check(f.rows[0].g !== null, "a friend sees the day");
  check(/^\d{4}-\d{2}-\d{2}$/.test(f.rows[0].g),
    "only the day travels, never the clock", String(f.rows[0].g));
}

console.log("\n— older paths the new rule must not break —");
{
  await asService();
  await db.exec(`
    insert into public.comments (event_id, author_id, body)
    select id, '${A}', 'i will be there' from public.events where slug = 'blitz';
  `);
  await db.exec(`set role anon; set request.jwt.claims = '';`);
  const c = await db.query(`select author from public.comments_public where body = 'i will be there'`);
  check(c.rows[0].author === "ada", "a signed-out reader still sees who wrote a comment", String(c.rows[0].author));

  await asUser(C);
  const h = await db.query(`select public.handle_status('ada') as s`);
  check(h.rows[0].s === "taken", "the handle availability check still works");
}

console.log("\n— the seen stamp —");
{
  await asUser(A);
  await db.exec(`select public.seen()`);
  const s = await db.query(`select last_seen_at is not null as v from public.profiles where id = '${A}'`);
  check(s.rows[0].v === true, "it stamps your own row");

  await asUser(B);
  await db.exec(`select public.seen()`);
  const b = await db.query(`select last_seen_at from public.profiles where id = '${A}'`);
  check(b.rows.length === 1, "someone else's row is untouched (the rule stops it)");
}

console.log("\n— the limits —");
{
  await asUser(A);
  let err = null;
  try { await db.exec(`update public.profiles set bio = repeat('x', 200) where id = '${A}'`); }
  catch (e) { err = e.message; }
  check(Boolean(err), "a line longer than 160 characters is refused");
}

console.log("\n— the record's own truth is not editable —");
{
  /* The direct UPDATE grant covers the four fields a person edits about
     themselves. joined, last seen and onboarded are what the record SAYS
     about them — writable only through seen() and profile_setup(). */
  await asUser(A);
  let joined = null;
  try { await db.exec(`update public.profiles set created_at = '2020-01-01' where id = '${A}'`); }
  catch (e) { joined = e.message; }
  check(/permission denied/i.test(joined || ""), "\"here since\" cannot be backdated");

  let lastSeen = null;
  try { await db.exec(`update public.profiles set last_seen_at = now() where id = '${A}'`); }
  catch (e) { lastSeen = e.message; }
  check(/permission denied/i.test(lastSeen || ""), "last seen only moves through seen()");

  let onboarded = null;
  try { await db.exec(`update public.profiles set onboarded_at = now() where id = '${A}'`); }
  catch (e) { onboarded = e.message; }
  check(/permission denied/i.test(onboarded || ""),
    "onboarded_at only moves through profile_setup()");
}

console.log("\n— deleting the account —");
{
  await asService();
  const D = "dddddddd-4444-4444-4444-444444444444";
  await db.exec(`insert into auth.users (id, email) values ('${D}', 'd@x.com')`);
  await db.exec(`update public.profiles set handle = 'silinecek' where id = '${D}'`);

  await asUser(D);
  await db.exec(`select public.swipe_set('blitz', 'right')`);
  await db.exec(`
    insert into public.comments (event_id, author_id, body)
    select id, '${D}', 'ben de geliyorum' from public.events where slug = 'blitz';
  `);

  await db.exec(`select public.delete_account()`);

  await asService();
  const h = await db.query(`select count(*)::int as n from auth.users where id = '${D}'`);
  check(h.rows[0].n === 0, "the account is gone");

  const pr = await db.query(`select count(*)::int as n from public.profiles where id = '${D}'`);
  check(pr.rows[0].n === 0, "the profile went with it");

  const ay = await db.query(`select count(*)::int as n from public.profile_settings where user_id = '${D}'`);
  check(ay.rows[0].n === 0, "the settings went with it");

  const at = await db.query(`select count(*)::int as n from public.swipes where user_id = '${D}'`);
  check(at.rows[0].n === 0, "their swipes went with it");

  const y = await db.query(`select author_id, author_name from public.comments where body = 'ben de geliyorum'`);
  check(y.rows.length === 1 && y.rows[0].author_id === null && y.rows[0].author_name === "someone",
    "the comment text stays, the name fell away");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
