/* pasaport — what every test needs: a PGlite with the shim and the files up to the one
   under test, three roles, and a check() that counts. Each test is still its own node
   script (npm test runs them one after another), as in the layout this came from. */
import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

export const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

let passed = 0, failed = 0;
export const check = (condition, name) => {
  if (condition) { passed++; console.log("  ✓ " + name); }
  else { failed++; console.log("  ✗ " + name); }
};
export async function mustBeRefused(db, sql, name, pattern) {
  try {
    await db.exec(sql);
    failed++; console.log("  ✗ " + name + " (it should not have gone through)");
  } catch (e) {
    if (pattern && !String(e.message).match(pattern)) { failed++; console.log("  ✗ " + name + " (refused, but: " + e.message + ")"); }
    else { passed++; console.log("  ✓ " + name); }
  }
}
export const asUser = (db, id) => db.exec(`set role authenticated; set request.jwt.claims = '{"sub":"${id}"}';`);
export const asAnon = (db) => db.exec(`set role anon; set request.jwt.claims = '';`);
export const asService = (db) => db.exec(`reset role; set request.jwt.claims = '';`);
export const rpc = async (db, fn, args = {}) => {
  const names = Object.keys(args);
  const r = await db.query(`select * from public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")})`, Object.values(args));
  return r.rows;
};
export const one = async (db, sql, params = []) => (await db.query(sql, params)).rows[0];

/* The numbered files, in order, up to and including `upTo` (a file name). */
export async function build(upTo) {
  const db = new PGlite();
  process.on("uncaughtException", (e) => { console.log("\nERROR: " + (e.message || e)); if (e.where) console.log("  " + e.where); process.exit(1); });
  process.on("unhandledRejection", (e) => { console.log("\nERROR: " + ((e && e.message) || e)); if (e && e.where) console.log("  " + e.where); process.exit(1); });
  const { EXPECTED_SQL } = await import("../tools/expected-sql.mjs");
  console.log("\n— building the schema —");
  await db.exec(await read("./supabase-shim.sql"));
  for (const f of EXPECTED_SQL) {
    await db.exec(await read("../sql/" + f));
    console.log("  · " + f);
    if (f === upTo) break;
  }
  return db;
}

export const ADA = "11111111-1111-1111-1111-111111111111";
export const BERK = "22222222-2222-2222-2222-222222222222";
export const CAN = "33333333-3333-3333-3333-333333333333";
export const DILA = "44444444-4444-4444-4444-444444444444";
/* Four accounts: ada (admin), berk, can, dila. No friendships yet. */
export async function people(db) {
  await asService(db);
  await db.exec(`
    insert into auth.users (id, email, raw_user_meta_data) values
      ('${ADA}', 'ada@example.com', '{"handle":"ada","name":"ada"}'),
      ('${BERK}', 'berk@example.com', '{"handle":"berk","name":"berk"}'),
      ('${CAN}', 'can@example.com', '{"handle":"can","name":"can"}'),
      ('${DILA}', 'dila@example.com', '{"handle":"dila","name":"dila"}');
    update public.profiles set is_admin = true where id = '${ADA}';
  `);
}
export async function befriend(db, a, b) {
  await asService(db);
  await db.exec(`insert into public.friendships (requester_id, addressee_id, status) values ('${a}', '${b}', 'accepted') on conflict do nothing`);
}

export function finish() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
