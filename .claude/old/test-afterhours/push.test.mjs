/* afterhours — push notifications: the phones, the switches, the four events */

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
                 "../sql/07_friends.sql", "../sql/12_profiles.sql", "../sql/15_ticketmaster.sql", "../sql/19_checkins.sql",
                 "../sql/20_djs.sql", "../sql/26_push.sql"]) {
  await db.exec(await read(d));
}
/* a second run must not trip over the first */
await db.exec(await read("../sql/26_push.sql"));

const A = "aaaaaaaa-1111-1111-1111-111111111111";
const B = "bbbbbbbb-2222-2222-2222-222222222222";
const C = "cccccccc-3333-3333-3333-333333333333";
const TOKEN_A = "ExponentPushToken[aaaa]";
const D = "dddddddd-4444-4444-4444-444444444444";
const E = "eeeeeeee-5555-5555-5555-555555555555";

const asUser = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asAnon = () => db.exec(`set role anon; set request.jwt.claims = '';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const fails = async (sql) => { try { await db.exec(sql); return null; } catch (e) { return e.message; } };
const rows = async (sql) => (await db.query(sql)).rows;
const outbox = async (user, kind) => {
  await asService();
  return rows(`select key, data from public.push_outbox where user_id = '${user}' and kind = '${kind}'`);
};

await asService();
await db.exec(`
  insert into auth.users (id, email) values ('${A}', 'a@x.com'), ('${B}', 'b@x.com'), ('${C}', 'c@x.com');
  update public.profiles set handle = 'ada' where id = '${A}';
  update public.profiles set handle = 'berk'  where id = '${B}';
  update public.profiles set handle = 'cansu' where id = '${C}';
`);
const [night] = await rows(`select id, slug, title from public.events order by slug limit 1`);

console.log("\n— the phones —");
{
  await asUser(A);
  await db.exec(`select public.push_register('${TOKEN_A}', 'android', 'tr')`);
  const mine = await rows(`select token, lang from public.push_tokens`);
  check(mine.length === 1 && mine[0].lang === "tr", "a phone registers with its language");

  check(Boolean(await fails(`select public.push_register('not-a-token', 'android', 'en')`)), "a malformed token is refused");
  check(Boolean(await fails(`insert into public.push_tokens (token, user_id, platform) values ('ExpoPushToken[x]', '${A}', 'ios')`)),
        "the table cannot be written directly");

  await asUser(B);
  check((await rows(`select 1 from public.push_tokens`)).length === 0, "nobody else sees your phone");
  await db.exec(`select public.push_register('${TOKEN_A}', 'android', 'en')`);
  await asService();
  const moved = await rows(`select user_id from public.push_tokens where token = '${TOKEN_A}'`);
  check(moved[0].user_id === B, "signing in on the same phone moves the token");
  await asUser(B);
  await db.exec(`select public.push_unregister('${TOKEN_A}')`);
  await asService();
  check((await rows(`select 1 from public.push_tokens`)).length === 0, "signing out removes it");

  await asAnon();
  check(Boolean(await fails(`select public.push_register('${TOKEN_A}', 'ios', 'en')`)), "signed out, no registering");
}

console.log("\n— requests —");
{
  await asUser(A);
  await db.exec(`select public.friend_request('berk')`);
  const req = await outbox(B, "friend_request");
  check(req.length === 1 && req[0].data.name === "ada", "a request notifies the other side, with your name");
  check(req[0]?.data.url === `/friend/${A}`, "and opens your friend page");

  await asUser(B);
  await db.exec(`select public.friend_accept('${A}')`);
  const acc = await outbox(A, "friend_accepted");
  check(acc.length === 1 && acc[0].data.name === "berk", "accepting notifies the one who asked");

  await asUser(C);
  await db.exec(`update public.profile_settings set notify_requests = false where user_id = '${C}'`);
  await asUser(A);
  await db.exec(`select public.friend_request('cansu')`);
  check((await outbox(C, "friend_request")).length === 0, "switched off: no request notification");
}

console.log("\n— matches —");
{
  await asUser(A);
  await db.exec(`insert into public.swipes (event_id, direction) values ('${night.id}', 'right')`);
  check((await outbox(B, "match")).length === 0, "keeping alone notifies nobody");

  await asUser(B);
  await db.exec(`insert into public.swipes (event_id, direction) values ('${night.id}', 'right')`);
  const m = await outbox(A, "match");
  check(m.length === 1 && m[0].data.name === "berk" && m[0].data.title === night.title, "a friend keeping the same night notifies you");
  check(m[0]?.data.url === `/night/${night.slug}`, "and opens the night");

  await db.exec(`update public.swipes set direction = 'left' where event_id = '${night.id}' and user_id = '${B}';
                 update public.swipes set direction = 'right' where event_id = '${night.id}' and user_id = '${B}';`);
  check((await outbox(A, "match")).length === 1, "keeping it again does not notify twice");

  await asService();
  const [other] = await rows(`select id from public.events where id <> '${night.id}' order by slug limit 1`);
  await db.exec(`update public.profile_settings set kept_visibility = 'private' where user_id = '${B}'`);
  await asUser(A);
  await db.exec(`insert into public.swipes (event_id, direction) values ('${other.id}', 'right')`);
  await asUser(B);
  await db.exec(`insert into public.swipes (event_id, direction) values ('${other.id}', 'right')`);
  check((await outbox(A, "match")).length === 1, "private keeps never notify");
}

console.log("\n— out now —");
{
  await asService();
  await db.exec(`insert into public.checkins (user_id, event_id) values ('${B}', '${night.id}')`);
  const live = await outbox(A, "friend_live");
  check(live.length === 1 && live[0].data.name === "berk", "a check-in notifies confirmed friends");
  check((await outbox(C, "friend_live")).length === 0, "a pending request is not a friend");

  const [other] = await rows(`select id from public.events where id <> '${night.id}' order by slug desc limit 1`);
  await db.exec(`insert into public.checkins (user_id, event_id, show_friends) values ('${B}', '${other.id}', false)`);
  check((await outbox(A, "friend_live")).length === 1, "a hidden check-in notifies nobody");
}

console.log("\n— the words —");
{
  const tr = await rows(`select * from public.push_text('match', 'tr', '{"name":"berk","title":"Blitz"}')`);
  check(tr[0].title === "berk de gidiyor" && tr[0].body === "Blitz", "the text comes in the phone's language");
  const none = await rows(`select * from public.push_text('match', '', '{"name":"berk"}')`);
  check(none[0].title === "berk is going too", "english when the language is unknown");

  const unsent = await rows(`select count(*)::int as n from public.push_outbox where sent_at is not null`);
  check(unsent[0].n === 0, "without pg_net nothing is marked sent");

  await asUser(A);
  check(Boolean(await fails(`select * from public.push_outbox`)), "the outbox is closed to users");
}


console.log("\n— rooms and replies —");
{
  await asService();
  const opened = await rows(`select data from public.push_outbox where user_id = '${B}' and kind = 'room_open'`);
  check(opened.length === 2 && opened[0].data.url === `/room/${night.slug}`, "checking in opens your room, even when hidden from friends");

  await db.exec(`insert into public.checkins (user_id, event_id) values ('${A}', '${night.id}')`);
  await db.exec(`insert into public.room_posts (event_id, user_id, body) values ('${night.id}', '${B}', 'where are you')`);
  await db.exec(`insert into public.room_posts (event_id, user_id, body) values ('${night.id}', '${B}', 'by the bar')`);
  const said = await outbox(A, "room_message");
  check(said.length === 1 && said[0].data.text === "where are you", "a room line reaches the others, once per half hour");
  check((await outbox(B, "room_message")).length === 0, "not the one who wrote it");

  const [topic] = await rows(`insert into public.comments (event_id, author_id, body) values ('${night.id}', '${A}', 'who is going?') returning id`);
  await db.exec(`insert into public.comments (event_id, parent_id, author_id, body) values ('${night.id}', '${topic.id}', '${B}', 'me')`);
  const rep = await outbox(A, "reply");
  check(rep.length === 1 && rep[0].data.name === "berk" && rep[0].data.text === "me", "a reply reaches the author of the topic");
  await db.exec(`insert into public.comments (event_id, parent_id, author_id, body) values ('${night.id}', '${topic.id}', '${A}', 'nice')`);
  check((await outbox(A, "reply")).length === 1, "answering yourself is no news");
}

console.log("\n— second wave —");
{
  await asService();
  /* berk (private since above) is the friend in the middle here: open for now */
  await db.exec(`update public.profile_settings set kept_visibility = 'friends' where user_id = '${B}'`);
  await db.exec(`
    insert into auth.users (id, email) values ('${D}', 'd@x.com'), ('${E}', 'e@x.com');
    update public.profiles set handle = 'deniz' where id = '${D}';
    update public.profiles set handle = 'elif' where id = '${E}';
    insert into public.friendships (requester_id, addressee_id, status) values ('${B}', '${D}', 'accepted'), ('${B}', '${E}', 'accepted');
  `);
  const [third] = await rows(`select id, city_id from public.events where id not in (select event_id from public.swipes) order by slug limit 1`);
  await db.exec(`update public.profiles set city_id = '${third.city_id}' where id = '${D}'`);
  await asUser(A);
  await db.exec(`insert into public.swipes (event_id, direction) values ('${third.id}', 'right')`);
  const w = await outbox(D, "wave");
  check(w.length === 1 && w[0].data.via === "berk" && !("name" in w[0].data), "a friend of a friend in that city hears it, without your name");
  check((await outbox(E, "wave")).length === 0, "not in another city");
  check((await outbox(B, "wave")).length === 0, "not your own friends");

  await asService();
  const [fourth] = await rows(`select id from public.events where city_id = '${third.city_id}' and id not in (select event_id from public.swipes) order by slug limit 1`);
  if (fourth) {
    await asUser(A);
    await db.exec(`insert into public.swipes (event_id, direction) values ('${fourth.id}', 'right')`);
    check((await outbox(D, "wave")).length === 1, "at most one wave a week");
  }

  /* the friend in the middle keeps their keeps private: they are not named, so nothing goes */
  const H = "12121212-8888-8888-8888-888888888888";
  await asService();
  await db.exec(`
    insert into auth.users (id, email) values ('${H}', 'h@x.com');
    update public.profiles set handle = 'hale', city_id = '${third.city_id}' where id = '${H}';
    insert into public.friendships (requester_id, addressee_id, status) values ('${B}', '${H}', 'accepted');
    insert into public.profile_settings (user_id, kept_visibility) values ('${B}', 'private')
      on conflict (user_id) do update set kept_visibility = 'private';
  `);
  const [fifth] = await rows(`select id from public.events where city_id = '${third.city_id}' and id not in (select event_id from public.swipes) order by slug limit 1`);
  if (fifth) {
    await asUser(A);
    await db.exec(`insert into public.swipes (event_id, direction) values ('${fifth.id}', 'right')`);
    check((await outbox(H, "wave")).length === 0, "nobody is told via a friend whose keeps are private");
  }
  await asService();
  /* and private again, as the rest of the file expects */
  await db.exec(`update public.profile_settings set kept_visibility = 'private' where user_id = '${B}'`);
}

console.log("\n— quiet hours —");
{
  const utc = new Date().getUTCHours();
  const zoneAt = (hour) => {
    for (let o = -12; o <= 14; o++) if ((((utc + o) % 24) + 24) % 24 === hour) return o === 0 ? "Etc/GMT" : `Etc/GMT${o > 0 ? "-" : "+"}${Math.abs(o)}`;
  };
  await asUser(E);
  await db.exec(`select public.push_register('ExponentPushToken[eeee]', 'ios', 'en', '${zoneAt(3)}')`);
  await asUser(D);
  await db.exec(`select public.friend_request('elif')`);
  await asService();
  const [late] = await rows(`select send_after > now() as later from public.push_outbox where user_id = '${E}' and kind = 'friend_request'`);
  check(late?.later === true, "at 03:00 on the phone a request waits for the morning");

  await db.exec(`insert into public.checkins (user_id, event_id) values ('${B}', '${(await rows(`select id from public.events where id <> '${night.id}' order by slug limit 1 offset 2`))[0].id}')`);
  const [now] = await rows(`select send_after <= now() as now from public.push_outbox where user_id = '${E}' and kind = 'friend_live' order by id desc limit 1`);
  check(now?.now === true, "a friend out now goes at once, even at night");

  await asUser(D);
  check(Boolean(await fails(`select public.push_register('ExponentPushToken[dddd]', 'ios', 'en', 'Mars/Olympus')`)) === false,
        "an unknown time zone falls back instead of failing");
}

console.log("\n— the hourly job —");
{
  await asService();
  const at = new Date("2026-10-01T16:30:00Z"); /* thursday 18:30 in Berlin */
  const iso = (d) => d.toISOString();
  const [city] = await rows(`select city_id, type_id from public.events where id = '${night.id}'`);
  await db.exec(`
    update public.profiles set city_id = '${city.city_id}' where id = '${A}';
    insert into public.events (slug, city_id, type_id, title, meta, starts_at) values
      ('push-soon', '${city.city_id}', '${city.type_id}', 'Soon Night', 'x', '${iso(new Date(at.getTime() + 2.5 * 3600e3))}'),
      ('push-weekend', '${city.city_id}', '${city.type_id}', 'Weekend Night', 'x', '2026-10-03T20:00:00Z'),
      ('push-closing', '${city.city_id}', '${city.type_id}', 'Closing Night', 'x', '${iso(new Date(at.getTime() - 54.5 * 3600e3))}');
    insert into public.swipes (user_id, event_id, direction) select '${A}', id, 'right' from public.events where slug = 'push-soon';
    insert into public.swipes (user_id, event_id, direction) select '${B}', id, 'right' from public.events where slug = 'push-weekend';
    insert into public.checkins (user_id, event_id) select '${A}', id from public.events where slug = 'push-closing';
    insert into public.djs (slug, name, genre) values ('push-dj', 'Mara Volt', 'techno');
    insert into public.dj_sets (dj_id, venue, starts_at) select id, 'Blitz', '${iso(new Date(at.getTime() + 30 * 60e3))}' from public.djs where slug = 'push-dj';
    insert into public.dj_follows (user_id, dj_id) select '${A}', id from public.djs where slug = 'push-dj';
  `);
  await asUser(A);
  await db.exec(`select public.push_register('ExponentPushToken[aaaa2]', 'android', 'de', 'Europe/Berlin')`);
  await asService();
  await db.exec(`select public.push_hourly('${iso(at)}')`);

  const soon = await outbox(A, "night_soon");
  check(soon.length === 1 && soon[0].data.time === "21:00", "a kept night starting in two to three hours, in local time");
  const closing = await outbox(A, "room_closing");
  check(closing.length === 1, "a room about to freeze");
  const dj = await outbox(A, "dj_live");
  check(dj.length === 1 && dj[0].data.name === "Mara Volt" && dj[0].data.url === "/dj/push-dj", "a followed DJ within the hour");
  const digest = await outbox(A, "digest");
  check(digest.length === 1 && digest[0].data.n >= 1, "thursday evening: the weekend in your city", JSON.stringify(digest[0]?.data));
  check(digest[0]?.data.friends === 0, "a friend who keeps privately is not counted");

  await db.exec(`select public.push_hourly('${iso(at)}')`);
  check((await outbox(A, "digest")).length === 1 && (await outbox(A, "night_soon")).length === 1, "running it twice sends nothing twice");

  await db.exec(`update public.profile_settings set notify_djs = false where user_id = '${B}';
                 insert into public.dj_follows (user_id, dj_id) select '${B}', id from public.djs where slug = 'push-dj';`);
  await db.exec(`select public.push_hourly('${iso(at)}')`);
  check((await outbox(B, "dj_live")).length === 0, "switched off: no DJ notification");
}


console.log("\n— delivery (a stand-in for pg_net) —");
{
  await asService();
  await db.exec(`
    create schema net;
    create table net._http_response (id bigint primary key, status_code int, content text);
    create table net.sent (id bigserial primary key, url text, body jsonb);
    create function net.http_post(url text, body jsonb, headers jsonb) returns bigint
    language plpgsql as $$ declare i bigint; begin
      insert into net.sent (url, body) values (url, body) returning id into i; return i;
    end $$;
  `);
  const flushed = await rows(`select public.push_flush() as n`);
  check(flushed[0].n > 0, "the flush sends what waited while there was no pg_net");
  const early = await rows(`select count(*)::int as n from public.push_outbox where sent_at is null and send_after <= now()`);
  check(early[0].n === 0, "nothing due is left behind");
  const waiting = await rows(`select count(*)::int as n from public.push_outbox where user_id = '${E}' and kind = 'friend_request' and sent_at is null`);
  check(waiting[0].n === 1, "quiet hours still wait");

  await asUser(B);
  await db.exec(`select public.push_register('ExponentPushToken[bbbb]', 'android', 'tr', 'Europe/Istanbul')`);
  await asService();
  await db.exec(`insert into public.checkins (user_id, event_id) select '${A}', id from public.events where slug = 'push-weekend'`);
  const [req] = await rows(`select s.url, s.body from net.sent s order by s.id desc limit 1`);
  const msg = req.body.find((m) => m.to === "ExponentPushToken[bbbb]");
  check(req.url === "https://exp.host/--/api/v2/push/send", "it goes to the Expo push service");
  check(msg && msg.title === "ada şu an dışarıda" && msg.data.url.startsWith("/night/"), "in the phone's language, with where to open", JSON.stringify(msg));
  const [row] = await rows(`select request_id, tokens, sent_at from public.push_outbox where user_id = '${B}' and kind = 'friend_live' order by id desc limit 1`);
  check(row.sent_at && row.request_id && row.tokens.includes("ExponentPushToken[bbbb]"), "the outbox remembers the request and the phones");

  const errors = row.tokens.map((t) => (t === "ExponentPushToken[bbbb]"
    ? { status: "error", details: { error: "DeviceNotRegistered" } } : { status: "ok", id: "x" }));
  await db.exec(`insert into net._http_response (id, status_code, content) values (${row.request_id}, 200, '${JSON.stringify({ data: errors })}')`);
  await db.exec(`select public.push_flush()`);
  check((await rows(`select 1 from public.push_tokens where token = 'ExponentPushToken[bbbb]'`)).length === 0, "a phone Expo reports as gone is forgotten");
  check((await rows(`select checked from public.push_outbox where request_id = ${row.request_id}`))[0].checked === true, "and the answer is read once");
}

console.log("\n— upgrading an earlier install —");
{
  const old = new PGlite();
  for (const d of ["../test/supabase-shim.sql", "../sql/01_schema.sql", "../sql/02_rls.sql", "../sql/03_seed_catalog.sql",
                   "../sql/07_friends.sql", "../sql/12_profiles.sql"]) {
    await old.exec(await read(d));
  }
  /* the shape of the first version, with only the four friend kinds */
  await old.exec(`
    alter table public.profile_settings add column if not exists notify_requests boolean not null default true;
    create table public.push_tokens (token text primary key, user_id uuid not null references public.profiles on delete cascade,
      platform text not null, lang text not null default 'en', updated_at timestamptz not null default now());
    create table public.push_outbox (id bigserial primary key, user_id uuid not null references public.profiles on delete cascade,
      kind text not null check (kind in ('friend_request', 'friend_accepted', 'match', 'friend_live')),
      key text not null unique, data jsonb not null default '{}', created_at timestamptz not null default now(), sent_at timestamptz);
    create function public.push_register(p_token text, p_platform text, p_lang text default 'en') returns boolean language sql as $$ select true $$;
    create function public.push_text(p_kind text, p_lang text, p_data jsonb) returns table (title text, body text)
      language sql immutable as $$ select 'x'::text, 'y'::text $$;
    insert into auth.users (id, email) values ('${A}', 'a@x.com');
    insert into public.push_tokens (token, user_id, platform) values ('ExponentPushToken[old]', '${A}', 'ios');
  `);
  const upgrade = await (async () => { try { await old.exec(await read("../sql/26_push.sql")); return null; } catch (e) { return e.message; } })();
  check(upgrade === null, "the new file runs on top of the first one", upgrade ?? "");
  const kept = await old.query(`select tz from public.push_tokens where token = 'ExponentPushToken[old]'`);
  check(kept.rows[0]?.tz === "Europe/Berlin", "registered phones stay, with a default zone");
  const kinds = await old.query(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'push_outbox_kind_check'`);
  check(kinds.rows[0]?.def.includes("wave"), "the outbox accepts the new kinds");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
