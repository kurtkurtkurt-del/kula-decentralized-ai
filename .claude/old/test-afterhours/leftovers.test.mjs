/* afterhours — a file goes with its row (82) */

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
/* Supabase has this; here a bare table stands in for it */
await db.exec(`create schema if not exists storage;
  create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text not null, name text not null);`);
/* a second run must not trip over the first */
await db.exec(await read("../sql/82_leftovers.sql"));

const [A, B] = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222"];
const rows = async (sql) => (await db.query(sql)).rows;
const has = async (p) => (await rows(`select 1 from storage.objects where bucket_id = 'photos' and name = '${p}'`)).length === 1;
const put = (p) => db.exec(`insert into storage.objects (bucket_id, name) values ('photos', '${p}')`);

await db.exec(`reset role; set request.jwt.claims = '';`);
await db.exec(`insert into auth.users (id, email) values ('${A}','a@x'),('${B}','b@x')`);
const night = (await rows(`select id from public.events where is_published limit 1`))[0].id;
for (const p of [`${A}/post1.jpg`, `${A}/post2.jpg`, `${A}/1.jpg`, `${A}/2.jpg`, `${B}/cover.jpg`, `${B}/cover2.jpg`, `${B}/night.jpg`, `${B}/stray.jpg`, `someone/else.jpg`]) await put(p);

console.log("\n— a post —");
{
  const p1 = (await rows(`insert into public.posts (author_id, body, photo_path) values ('${A}', 'one', '${A}/post1.jpg') returning id`))[0].id;
  const p2 = (await rows(`insert into public.posts (author_id, body, photo_path) values ('${A}', 'two', '${A}/post2.jpg') returning id`))[0].id;
  await db.exec(`delete from public.posts where id = '${p1}'`);
  check(!(await has(`${A}/post1.jpg`)), "deleting the row deletes the file");
  await db.exec(`update public.posts set body = 'two, edited' where id = '${p2}'`);
  check(await has(`${A}/post2.jpg`), "an edit of the text leaves the file");
  await db.exec(`update public.posts set is_hidden = true where id = '${p2}'`);
  check(!(await has(`${A}/post2.jpg`)), "hiding it deletes the file at once");
  check((await rows(`select body from public.posts where id = '${p2}'`))[0].body === 'two, edited', "the text stays as the record");
}

console.log("\n— a face, a cover —");
{
  await db.exec(`insert into public.profile_photos (user_id, path) values ('${A}', '${A}/1.jpg')`);
  await db.exec(`update public.profile_photos set path = '${A}/2.jpg' where user_id = '${A}'`);
  check(!(await has(`${A}/1.jpg`)) && await has(`${A}/2.jpg`), "a replaced face loses the old file, keeps the new");
  const g = (await rows(`insert into public.groups (name, created_by, cover_path) values ('us', '${B}', '${B}/cover.jpg') returning id`))[0].id;
  await db.exec(`update public.groups set cover_path = '${B}/cover2.jpg' where id = '${g}'`);
  check(!(await has(`${B}/cover.jpg`)), "a replaced cover too");
  await db.exec(`insert into public.group_photos (group_id, event_id, user_id, path) values ('${g}', '${night}', '${B}', '${B}/night.jpg')`);
  await db.exec(`delete from public.groups where id = '${g}'`);
  check(!(await has(`${B}/cover2.jpg`)) && !(await has(`${B}/night.jpg`)), "a group gone takes its cover and its photos");
}

console.log("\n— a person gone —");
{
  await db.exec(`delete from auth.users where id = '${B}'`);
  check(!(await has(`${B}/stray.jpg`)), "the whole folder goes with the account");
  check(await has(`someone/else.jpg`) && await has(`${A}/2.jpg`), "nobody else's files are touched");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
