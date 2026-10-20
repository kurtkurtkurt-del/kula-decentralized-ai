/* 09: a coop, its code, tonight's project, the night's numbers. */
import { build, check, mustBeRefused, asUser, asService, rpc, one, people, befriend, ADA, BERK, CAN, DILA, finish } from "./lib.mjs";

const db = await build("09_coops.sql");
await people(db);
await befriend(db, ADA, BERK);

await asUser(db, ADA);
await mustBeRefused(db, `select public.coop_create('night shift', '🌙', 'red', array['${CAN}']::uuid[])`, "a stranger cannot be added", /friends/);
const g = (await one(db, `select public.coop_create('night shift', '🌙', 'red', array['${BERK}']::uuid[]) id`)).id;
let got = (await one(db, `select public.coop_get('${g}') j`)).j;
check(got.members.length === 2 && got.members[0].role === "owner" && got.tonight === null, "two members, ada owns it, no plan yet");
await asUser(db, CAN);
await mustBeRefused(db, `select public.coop_get('${g}')`, "a non-member cannot read it", /not in/);

console.log("\n— the code —");
await asUser(db, ADA);
const code = (await one(db, `select public.coop_invite('${g}') c`)).c;
check(code.length === 8 && (await one(db, `select public.coop_invite('${g}') c`)).c === code, "one code while it is good");
await asUser(db, CAN);
const peek = (await rpc(db, "coop_peek", { p_code: code.toLowerCase() }))[0];
check(peek.name === "night shift" && peek.members === 2 && peek.mine === false && peek.open === true, "peek before joining");
check((await one(db, `select public.coop_join('${code}') id`)).id === g, "can joins by code");
check((await rpc(db, "my_coops")).length === 1, "my_coops lists it");
await asService(db);
await db.exec(`update public.coop_invites set uses = max_uses where code = '${code}'`);
await asUser(db, DILA);
await mustBeRefused(db, `select public.coop_join('${code}')`, "a used-up code is refused", /used up/);

console.log("\n— tonight —");
await asUser(db, BERK);
await mustBeRefused(db, `select public.coop_night_set('${g}', public.night_of() - 1, 'koy-okulu-ogretmen')`, "a past night cannot be planned", /passed/);
await db.exec(`select public.coop_night_set('${g}', public.night_of(), 'koy-okulu-ogretmen')`);
await asUser(db, CAN);
await db.exec(`select public.coop_night_set('${g}', public.night_of(), 'yerel-tarih-arsivi')`);
got = (await one(db, `select public.coop_get('${g}') j`)).j;
check(got.tonight.slug === "yerel-tarih-arsivi", "the last word wins");
check((await rpc(db, "my_coops"))[0].tonight_slug === "yerel-tarih-arsivi", "my_coops shows tonight");
for (const u of [ADA, BERK]) {
  await asUser(db, u);
  await db.exec(`select public.join_set('yerel-tarih-arsivi', 'right')`);
  const k = (await one(db, `select public.contribution_start('yerel-tarih-arsivi', gen_random_uuid()) id`)).id;
  await db.exec(`select public.contribution_end('${k}', 10000, 3600, 0.004)`);
}
await asUser(db, ADA);
const nights = await rpc(db, "coop_nights", { p_id: g });
check(nights.length === 1 && nights[0].phones === 2 && Number(nights[0].tokens) === 20000 && Number(nights[0].credits) === 20, "the night's numbers: two phones, their tokens, their credits");
check((await one(db, `select public.night_of('2026-10-21 03:00+00'::timestamptz)::text d`)).d === "2026-10-20", "03:00 still belongs to the night before");

console.log("\n— leaving —");
await asUser(db, ADA);
await db.exec(`select public.coop_leave('${g}')`);
await asUser(db, BERK);
got = (await one(db, `select public.coop_get('${g}') j`)).j;
check(got.members.length === 2 && got.members.find((m) => m.handle === "berk").role === "owner", "the oldest member becomes the owner");
await asUser(db, CAN);
await mustBeRefused(db, `select public.coop_delete('${g}')`, "only the owner deletes", /owner/);
await asUser(db, BERK);
await db.exec(`select public.coop_delete('${g}')`);
check((await rpc(db, "my_coops")).length === 0, "deleted");

finish();
