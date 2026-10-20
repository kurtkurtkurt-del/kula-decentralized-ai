/* 10: a call travels in waves; answers; the host's view. */
import { build, check, mustBeRefused, asUser, rpc, one, people, befriend, ADA, BERK, CAN, DILA, finish } from "./lib.mjs";

const db = await build("10_calls.sql");
await people(db);
await befriend(db, ADA, BERK);
await befriend(db, BERK, CAN);
await befriend(db, CAN, DILA);

await asUser(db, ADA);
const au = (await rpc(db, "call_audience"))[0];
check(au.wave1 === 1 && au.wave2 === 2 && au.wave3 === 3, "audience: 1, 2, 3");
await mustBeRefused(db, `select public.call_create('koy-okulu-ogretmen', public.night_of() - 1, 2)`, "a past night is refused", /passed/);
await mustBeRefused(db, `select public.call_create('koy-okulu-ogretmen', public.night_of(), 4)`, "the wave is 1, 2 or 3", /wave/);
const c = (await one(db, `select public.call_create('koy-okulu-ogretmen', public.night_of(), 2, 'bring a charger') id`)).id;
check((await rpc(db, "kept")).length === 1, "a call keeps the project for the host");
check((await rpc(db, "call_mine")).length === 1, "call_mine lists it");

await asUser(db, BERK);
let inbox = await rpc(db, "call_inbox");
check(inbox.length === 1 && inbox[0].wave === 1 && inbox[0].host_handle === "ada" && inbox[0].note === "bring a charger", "berk (wave 1) sees it");
await asUser(db, CAN);
inbox = await rpc(db, "call_inbox");
check(inbox.length === 1 && inbox[0].wave === 2, "can (wave 2) sees it");
await asUser(db, DILA);
check((await rpc(db, "call_inbox")).length === 0, "dila (wave 3) does not: reach is 2");
await mustBeRefused(db, `select public.call_answer('${c}', 'in')`, "nor can she answer", /no such call/);

await asUser(db, CAN);
await db.exec(`select public.call_answer('${c}', 'in')`);
check((await rpc(db, "call_inbox")).length === 0, "answered, it leaves the inbox");
check((await rpc(db, "kept")).length === 1, "saying in keeps the project");
await db.exec(`select public.call_answer('${c}', 'waiting')`);
check((await rpc(db, "call_inbox")).length === 1, "undo brings it back");
await db.exec(`select public.call_answer('${c}', 'in')`);
await asUser(db, BERK);
await db.exec(`select public.call_answer('${c}', 'out')`);
await asUser(db, ADA);
const mine = (await rpc(db, "call_mine"))[0];
check(mine.going === 1 && mine.not_going === 1, "the host sees 1 in, 1 out");
const ppl = await rpc(db, "call_people", { p_call: c });
check(ppl.length === 2 && ppl[0].host && ppl[1].handle === "can", "call_people: the host and can");
await asUser(db, BERK);
check((await rpc(db, "call_people", { p_call: c })).length === 0, "someone who said out sees nobody");
await asUser(db, CAN);
check((await rpc(db, "call_people", { p_call: c })).length === 1, "someone who is in sees the host (and the others who are in)");
await mustBeRefused(db, `select public.call_cancel('${c}')`, "only the host cancels", /not yours/);
await asUser(db, ADA);
await db.exec(`select public.call_cancel('${c}')`);
check((await rpc(db, "call_mine")).length === 0, "cancelled");

finish();
