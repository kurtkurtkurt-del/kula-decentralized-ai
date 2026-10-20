/* afterhours — the export, whole (89) */

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
for (const d of ["../test/supabase-shim.sql", "../sql/setup-1-structure.sql"]) {
  await db.exec(await read(d));
}
/* a second run must not trip over the first */
await db.exec(await read("../sql/89_export_all.sql"));

const [A, B] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222"];
const as = (id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
const asService = () => db.exec(`reset role; set request.jwt.claims = '';`);
const rows = async (sql) => (await db.query(sql)).rows;

await asService();
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x')`);
await db.exec(`update public.profiles set handle = 'ada' where id = '${A}'`);
await db.exec(`update public.profiles set handle = 'berk' where id = '${B}'`);
const night = (await rows(`select id, slug from public.events where is_published limit 1`))[0];
await db.exec(`insert into public.checkins (user_id, event_id, lat, lng) values ('${A}', '${night.id}', 48.1, 11.5)`);
await db.exec(`insert into public.room_posts (event_id, user_id, body) values ('${night.id}', '${A}', 'mine'), ('${night.id}', '${B}', 'theirs')`);
await db.exec(`insert into public.rsvps (user_id, event_id, answer) values ('${A}', '${night.id}', 'in')`);
const g = (await rows(`insert into public.groups (name, created_by) values ('us', '${A}') returning id`))[0].id;
await db.exec(`insert into public.group_members (group_id, user_id, role) values ('${g}', '${A}', 'owner'), ('${g}', '${B}', 'member') on conflict do nothing`);
await db.exec(`insert into public.group_messages (group_id, user_id, body) values ('${g}', '${A}', 'hi all'), ('${g}', '${B}', 'hi back')`);
await db.exec(`insert into public.blocks (blocker_id, blocked_id) values ('${A}', '${B}')`);
await db.exec(`insert into public.profile_links (user_id, kind, value) values ('${A}', 'instagram', 'ada.k')`);

await as(A);
const d = (await rows(`select public.export_me() as d`))[0].d;
check(d.checkins.length === 1 && Math.abs(d.checkins[0].lat - 48.1) < 1e-6, "check-ins, with the position");
check(d.room_lines.length === 1 && d.room_lines[0].body === "mine", "my room lines only");
check(d.rsvps.length === 1 && d.rsvps[0].answer === "in", "rsvps");
check(d.groups.length === 1 && d.groups[0].messages.length === 1 && d.groups[0].messages[0].body === "hi all", "groups with my own messages only");
check(d.blocked.length === 1 && d.blocked[0].handle === "berk", "who i blocked");
check(d.links.length === 1 && d.links[0].value === "ada.k", "profile links");
check(d.notifications && d.notifications.notify_dms === true, "every notification switch");
check(Array.isArray(d.posts) && Array.isArray(d.sparks) && Array.isArray(d.appeals) && Array.isArray(d.nights_sent) && d.dj_page === null, "the empty shelves are there, empty");
await as(B);
const b = (await rows(`select public.export_me() as d`))[0].d;
check(b.room_lines.length === 1 && b.room_lines[0].body === "theirs" && b.blocked.length === 0, "berk gets his own, and not that he was blocked");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
