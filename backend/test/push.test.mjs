/* 13: pushes carry a sentence and a name, never the words; the switches; quiet hours. */
import { build, check, mustBeRefused, asUser, asService, rpc, one, people, befriend, ADA, BERK, CAN, finish } from "./lib.mjs";

const db = await build("13_push.sql");
await people(db);

const outbox = async () => { await asService(db); return (await db.query(`select user_id, kind, key, data, send_after, sent_at from public.push_outbox order by id`)).rows; };

await asUser(db, ADA);
await mustBeRefused(db, `select public.push_register('nope', 'android')`, "a token looks like ExponentPushToken[…]");
check((await one(db, `select public.push_register('ExponentPushToken[ada1]', 'android', 'tr', 'Europe/Istanbul') ok`)).ok, "ada registers her phone");
await asUser(db, BERK);
await db.exec(`select public.push_register('ExponentPushToken[berk1]', 'android', 'de', 'Europe/Berlin')`);

console.log("\n— friends —");
await asUser(db, ADA);
await db.exec(`select public.friend_request('berk')`);
let o = await outbox();
check(o.length === 1 && o[0].user_id === BERK && o[0].kind === "friend_request" && o[0].data.name === "ada", "berk is told ada asked (the name, nothing else)");
await asUser(db, BERK);
await db.exec(`select public.friend_accept('${ADA}')`);
o = await outbox();
check(o.length === 2 && o[1].user_id === ADA && o[1].kind === "friend_accepted", "ada is told berk accepted");
check(o[1].sent_at === null, "without pg_net the rows wait, unsent");

console.log("\n— the words —");
const w = (await rpc(db, "push_text", { p_kind: "call", p_lang: "tr", p_data: JSON.stringify({ name: "Ayşe", url: "/x" }) }))[0];
check(w.body === "Ayşe bir proje gecesi başlattı", "tr: Ayşe bir proje gecesi başlattı");
const w2 = (await rpc(db, "push_text", { p_kind: "dm", p_lang: "en", p_data: JSON.stringify({ name: "berk", body: "secret" }) }))[0];
check(w2.body === "berk wrote to you" && !w2.body.includes("secret"), "a dm push never carries the message");

console.log("\n— calls, coops, cards, dms —");
await befriend(db, BERK, CAN);
await asUser(db, ADA);
const c = (await one(db, `select public.call_create('koy-okulu-ogretmen', public.night_of(), 2) id`)).id;
o = await outbox();
check(o.filter((x) => x.kind === "call").length === 2, "a call with reach 2 reaches berk and can");
await asUser(db, CAN);
await db.exec(`select public.call_answer('${c}', 'in')`);
o = await outbox();
check(o.some((x) => x.kind === "call_in" && x.user_id === ADA && x.data.name === "can"), "the host hears can is in");
await asUser(db, BERK);
const g = (await one(db, `select public.coop_create('night shift', '🌙', 'red', array['${ADA}']::uuid[]) id`)).id;
await db.exec(`select public.coop_night_set('${g}', public.night_of(), 'koy-okulu-ogretmen')`);
o = await outbox();
check(o.some((x) => x.kind === "coop_night" && x.user_id === ADA && x.data.title === "offline teacher for village schools"), "ada hears the coop chose tonight");
await asUser(db, BERK);
const t = (await one(db, `select public.dm_start('ada') id`)).id;
await db.exec(`select public.dm_send('${t}', 'hi')`);
o = await outbox();
check(o.some((x) => x.kind === "dm" && x.user_id === ADA), "a dm pushes");
await asUser(db, ADA);
await asUser(db, ADA);
await db.exec(`select public.join_set('koy-okulu-ogretmen', 'right')`);
const k = (await one(db, `select public.contribution_start('koy-okulu-ogretmen', gen_random_uuid()) id`)).id;
await db.exec(`select public.contribution_end('${k}', 1000, 600, 0.001)`);
o = await outbox();
const card = o.find((x) => x.kind === "card");
check(card && card.user_id === ADA && card.data.url === "/passport", "the card pushes in the morning");

console.log("\n— switches and quiet hours —");
await asUser(db, ADA);
await db.exec(`select public.settings_set('{"notify_dms": false}')`);
await asUser(db, BERK);
await db.exec(`select public.dm_send('${t}', 'again')`);
o = await outbox();
check(o.filter((x) => x.kind === "dm").length === 1, "dms off: no second push");
await asService(db);
const hour = (await one(db, `select extract(hour from now() at time zone 'Europe/Istanbul')::int h`)).h;
const dm = o.find((x) => x.kind === "dm");
check(hour < 9 ? new Date(dm.send_after) > new Date() : new Date(dm.send_after) <= new Date(), "quiet hours: before 09:00 on the phone it waits (checked for the hour it is now)");
check(new Date(card.send_after) <= new Date(), "a card never waits");

finish();
