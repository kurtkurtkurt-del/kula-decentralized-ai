/* 00–03: the log, the tables, the door, the seed. */
import { build, check, mustBeRefused, asUser, asAnon, asService, rpc, one, people, befriend, ADA, BERK, CAN, DILA, finish } from "./lib.mjs";

const db = await build("03_seed_projects.sql");
await people(db);

console.log("\n— the log —");
{
  const r = await db.query(`select name from public.migrations order by name`);
  check(r.rows.map((x) => x.name).join() === "00_migrations.sql,01_schema.sql,02_doors.sql,03_seed_projects.sql", "four files stamped");
  await asAnon(db);
  check((await rpc(db, "migrations_applied")).length === 4, "anonymous may read the list");
  await mustBeRefused(db, `select public.migration_done('x')`, "anonymous may not stamp");
}

console.log("\n— the seed —");
{
  await asService(db);
  check((await one(db, `select count(*)::int n from public.projects`)).n === 10, "ten projects");
  check((await one(db, `select count(*)::int n from public.cities`)).n === 10, "ten cities");
  const p = await one(db, `select est_kwh, est_eur, params_b from public.projects where slug = 'koy-okulu-ogretmen'`);
  check(Number(p.est_kwh) === 163.2 && Number(p.est_eur) === 48.96, "energy estimate: 400 phones × 12 nights × 4 W × 8.5 h");
  await db.exec(await (await import("./lib.mjs")).read("../sql/03_seed_projects.sql"));
  check((await one(db, `select count(*)::int n from public.projects`)).n === 10, "pasting the seed again changes nothing");
}

console.log("\n— profiles appear by themselves —");
{
  const r = await db.query(`select handle, is_admin from public.profiles order by handle`);
  check(r.rows.length === 4 && r.rows[0].handle === "ada" && r.rows[0].is_admin, "four profiles, one admin");
  check((await one(db, `select count(*)::int n from public.profile_settings`)).n === 4, "four settings rows");
  await db.exec(`insert into auth.users (id, email, raw_user_meta_data) values ('55555555-5555-5555-5555-555555555555', 'x@example.com', '{"handle":"ada"}')`);
  check((await one(db, `select handle from public.profiles where id = '55555555-5555-5555-5555-555555555555'`)).handle === null, "a taken handle is left empty");
}

console.log("\n— every table is closed —");
{
  await asUser(db, BERK);
  for (const t of ["cities", "projects", "profiles", "profile_settings", "joins", "friendships", "bans", "blocks", "contributions", "credits", "passports"]) {
    await mustBeRefused(db, `select * from public.${t}`, `signed in, ${t} cannot be read directly`);
  }
  await asAnon(db);
  await mustBeRefused(db, `select * from public.projects`, "anonymous, projects cannot be read directly");
}

console.log("\n— the door —");
{
  await asAnon(db);
  await mustBeRefused(db, `select public.assert_member()`, "signed out, assert_member refuses", /sign in|permission/);
  await asUser(db, BERK);
  check((await one(db, `select public.assert_member() u`)).u === BERK, "signed in, assert_member answers the id");
  check((await one(db, `select public.is_admin() a`)).a === false, "berk is not an admin");
  await asUser(db, ADA);
  check((await one(db, `select public.is_admin() a`)).a === true, "ada is");
  await mustBeRefused(db, `update public.profiles set is_admin = true where id = '${BERK}'`, "nobody writes profiles directly");

  await asUser(db, ADA);
  await db.exec(`select public.staff_ban('${BERK}', 'spam')`);
  await asUser(db, BERK);
  await mustBeRefused(db, `select public.assert_member()`, "a banned account is refused at the door", /closed/);
  const s = (await rpc(db, "account_status"))[0];
  check(s.banned === true && s.reason === "spam", "account_status says why");
  await asUser(db, CAN);
  await mustBeRefused(db, `select public.staff_ban('${DILA}', 'x')`, "only the admin bans", /admins/);
  await asUser(db, ADA);
  await db.exec(`select public.staff_unban('${BERK}')`);
  await asUser(db, BERK);
  check((await one(db, `select public.assert_member() u`)).u === BERK, "unbanned, berk is back");
}

console.log("\n— friends, blocks, waves —");
{
  await befriend(db, ADA, BERK);
  await befriend(db, BERK, CAN);
  await befriend(db, CAN, DILA);
  await asService(db);
  const w = (await db.query(`select person, hops from public.waves('${ADA}') order by hops`)).rows;
  check(w.length === 3 && w[0].person === BERK && w[0].hops === 1 && w[1].hops === 2 && w[2].hops === 3, "ada's waves: berk 1, can 2, dila 3");
  check((await one(db, `select public.visible_to('${ADA}', '${DILA}') v`)).v === true, "a discoverable stranger is visible");
  await db.exec(`update public.profile_settings set discoverable = false where user_id = '${DILA}'`);
  check((await one(db, `select public.visible_to('${ADA}', '${DILA}') v`)).v === false, "…unless they turned it off");
  check((await one(db, `select public.visible_to('${CAN}', '${DILA}') v`)).v === true, "a friend still sees them");

  await asUser(db, ADA);
  check((await one(db, `select public.block_user('${CAN}') b`)).b === true, "ada blocks can");
  check((await rpc(db, "my_blocks")).length === 1, "my_blocks lists one");
  await asService(db);
  const w2 = (await db.query(`select person from public.waves('${ADA}')`)).rows.map((x) => x.person);
  check(w2.length === 1 && w2[0] === BERK, "the wave stops at a block (can and dila are gone)");
  await asUser(db, ADA);
  await db.exec(`select public.unblock_user('${CAN}')`);
  await asService(db);
  check((await db.query(`select person from public.waves('${ADA}')`)).rows.length === 3, "unblocked, the wave runs again");
  await asUser(db, ADA);
  await mustBeRefused(db, `select * from public.waves('${ADA}')`, "waves() is not an API");
}

finish();
