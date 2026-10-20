/* afterhours — the views and functions.
   En kritik soru: gorunumler RLS'i sizdiriyor mu?  */

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
                 "../sql/05_seed_comments.sql", "../sql/06_views.sql"]) {
  await db.exec(await read(d));
}
console.log("\n— schema + seed + views loaded —");

const ME = "11111111-1111-1111-1111-111111111111";
const FRIEND = "22222222-2222-2222-2222-222222222222";
const STRANGER = "33333333-3333-3333-3333-333333333333";

await db.exec(`
  insert into auth.users (id, email) values
    ('${ME}', 'ben@example.com'),
    ('${FRIEND}', 'friend@example.com'),
    ('${STRANGER}', 'yabanci@example.com');
  insert into public.friendships (requester_id, addressee_id, status)
  values ('${ME}', '${FRIEND}', 'accepted'),
         ('${ME}', '${STRANGER}', 'pending');
  update public.profiles set handle = 'lena' where id = '${FRIEND}';
  update public.profiles set handle = 'yabanci' where id = '${STRANGER}';
`);

const asUser = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);

console.log("\n— the deck —");
{
  await asAnon();
  const r = await db.query(`select slug, type_name from public.deck()`);
  check(r.rows.length === 36, "anonime 36 kartin all geliyor", `got ${r.rows.length}`);
  check(r.rows[0].slug === "asap-rocky", "sort_order matches the poster order (first card A$AP Rocky)");

  const t = await db.query(`select count(*)::int as n from public.deck('munchen', 'rave')`);
  check(t.rows[0].n === 7, "the filter by kind works (7 rave)", `got ${t.rows[0].n}`);
}

console.log("\n— a swiped card does not come back —");
{
  await asUser(ME);
  const before = await db.query(`select count(*)::int as n from public.deck()`);
  await db.exec(`insert into public.swipes (user_id, event_id, direction)
                 select '${ME}', id, 'left' from public.events where slug = 'asap-rocky'`);
  await db.exec(`insert into public.swipes (user_id, event_id, direction)
                 select '${ME}', id, 'right' from public.events where slug = 'nick-cave'`);
  const after = await db.query(`select count(*)::int as n from public.deck()`);
  check(before.rows[0].n === 36 && after.rows[0].n === 34,
    "the two swiped cards left the deck", `${before.rows[0].n} → ${after.rows[0].n}`);
}

console.log("\n— kept —");
{
  await asUser(ME);
  const r = await db.query(`select slug from public.kept()`);
  check(r.rows.length === 1 && r.rows[0].slug === "nick-cave",
    "only what was swiped right is kept (nothing swiped left)");

  await asUser(STRANGER);
  const y = await db.query(`select count(*)::int as n from public.kept()`);
  check(y.rows[0].n === 0, "what someone else kept does not show in your list");
}

console.log("\n— what your friends kept —");
{
  await asUser(FRIEND);
  const r = await db.query(`select slug, friend from public.friends_kept()`);
  check(r.rows.length === 1 && r.rows[0].slug === "nick-cave",
    "what a confirmed friend swiped right is visible");
  check(r.rows[0].friend !== null, "it is clear who kept it (" + r.rows[0].friend + ")");

  await asUser(STRANGER);
  const y = await db.query(`select count(*)::int as n from public.friends_kept()`);
  check(y.rows[0].n === 0, "a pending (unconfirmed) friendship gives nothing away");
}

console.log("\n— do the views leak past RLS —");
{
  await asService();
  await db.exec(`update public.events set is_published = false where slug = 'strobo'`);

  await asAnon();
  const r = await db.query(`select count(*)::int as n from public.events_public where slug = 'strobo'`);
  check(r.rows[0].n === 0, "an unpublished event leaves the view too (security_invoker)");

  const g = await db.query(`select count(*)::int as n from public.comments_public`);
  check(g.rows[0].n > 0, "signed out, the comments can be read");

  await asService();
  const hidden = await db.query(`update public.comments set is_hidden = true
                                where id = (select id from public.comments limit 1)
                                returning id`);
  const hiddenId = hidden.rows[0].id;

  await asAnon();
  const h = await db.query(`select count(*)::int as n from public.comments_public where id = $1`,
                           [hiddenId]);
  check(h.rows[0].n === 0, "a hidden comment is not in the view");
  /* It must not show in the table either - the view is not the only line of defence */
  const d = await db.query(`select count(*)::int as n from public.comments where id = $1`, [hiddenId]);
  check(d.rows[0].n === 0, "a hidden comment is closed to anonymous in the table as well");
}

console.log("\n— the counters —");
{
  await asAnon();
  const r = await db.query(`select type_name, n::int from public.event_counts()`);
  const got = Object.fromEntries(r.rows.map((x) => [x.type_name, x.n]));
  // strobo yukarida yayindan kaldirildi: rave 7 → 6
  check(got["Rave"] === 6 && got["Konzert"] === 5,
    "the counter counts the published ones", JSON.stringify(got));

  /* keep_counts serves the admin panel alone; anonymous lost EXECUTE. */
  let countsError = false;
  try { await db.query(`select count(*)::int as n from public.keep_counts()`); }
  catch (e) { countsError = /permission denied/i.test(e.message); }
  check(countsError, "the keep counts are closed to anonymous");

  await asUser(ME);
  const k = await db.query(`select count(*)::int as n from public.keep_counts()`);
  check(k.rows[0].n === 1, "signed in they answer (the count, never who)");
  await asAnon();

  /* Anonymous has no privilege on the swipes table at all: not an empty
     dogrudan yetki hatasi almali. */
  let gotError = false;
  try { await db.query(`select count(*) from public.swipes`); }
  catch (e) { gotError = /permission denied/i.test(e.message); }
  check(gotError, "but the swipes themselves are entirely closed to anonymous");
}

console.log("\n— moderation sticks —");
{
  /* FRIEND writes a comment and the admin hides it. The writer may still
     edit their own row (the body is theirs), but the flag is not: without
     the guard they could quietly write is_hidden back to false. */
  await asService();
  await db.exec(`update public.profiles set is_admin = true where id = '${ME}'`);

  await asUser(FRIEND);
  await db.exec(`insert into public.comments (event_id, body)
                 select id, 'the queue was the whole night' from public.events where slug = 'blitz'`);

  await asUser(ME);
  const hid = await db.query(`update public.comments set is_hidden = true
                              where author_id = '${FRIEND}' returning id`);
  check(hid.rows.length === 1, "an admin can hide a comment");
  const target = hid.rows.length ? hid.rows[0].id : null;

  await asUser(FRIEND);
  /* A hidden row is invisible to its writer, so an update that has to
     READ it (a WHERE on its id) already finds nothing. The one road in
     is a bare UPDATE — no WHERE reads no row values, so it reaches every
     row the update rule allows, hidden included. The trigger closes it. */
  const blind = await db.query(`update public.comments set is_hidden = false
                                where id = '${target}' returning id`);
  check(blind.rows.length === 0, "a hidden comment cannot even be aimed at by its writer");

  let lifted = null;
  try { await db.exec(`update public.comments set is_hidden = false`); }
  catch (e) { lifted = e.message; }
  check(Boolean(lifted), "the writer cannot lift the flag back off");

  let forgedTime = null;
  try { await db.exec(`update public.comments set time_text = '4 days ago'
                       where author_id = '${FRIEND}'`); }
  catch (e) { forgedTime = e.message; }
  check(Boolean(forgedTime), "the shown time is not the writer's to change");

  let tooLong = null;
  try {
    await db.exec(`insert into public.comments (event_id, body)
                   select id, repeat('x', 2001) from public.events where slug = 'blitz'`);
  } catch (e) { tooLong = e.message; }
  check(Boolean(tooLong), "a comment past 2000 characters is refused");

  /* The depth check runs a SELECT, and under the caller's read rule a
     HIDDEN parent came back as no row: both checks passed on NULL and a
     reply could land on a hidden reply — a third level. The trigger is
     definer now, so it sees every parent. */
  await asService();
  const t2 = await db.query(`insert into public.comments (event_id, author_name, body)
                             select id, 'someone', 'a topic for the depth test'
                             from public.events where slug = 'blitz' returning id`);
  await asUser(STRANGER);
  const r2 = await db.query(`insert into public.comments (event_id, parent_id, body)
                             select event_id, id, 'a reply that will be hidden'
                             from public.comments where id = '${t2.rows[0].id}' returning id`);
  await asUser(ME);
  await db.exec(`update public.comments set is_hidden = true where id = '${r2.rows[0].id}'`);

  await asUser(STRANGER);
  let third = null;
  try {
    await db.exec(`insert into public.comments (event_id, parent_id, body)
                   select id, '${r2.rows[0].id}', 'a reply to the hidden reply'
                   from public.events where slug = 'blitz'`);
  } catch (e) { third = e.message; }
  check(/cannot be replied to/i.test(third || ""),
    "a hidden reply still refuses a third level");
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
