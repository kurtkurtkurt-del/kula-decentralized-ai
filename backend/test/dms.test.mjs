/* 11: direct messages between friends; the outbox's second try; seen. */
import { build, check, mustBeRefused, asUser, rpc, one, people, befriend, ADA, BERK, CAN, finish } from "./lib.mjs";

const db = await build("11_dms.sql");
await people(db);
await befriend(db, ADA, BERK);

await asUser(db, ADA);
await mustBeRefused(db, `select public.dm_start('can')`, "not a friend: no thread", /friends only/);
const t = (await one(db, `select public.dm_start('berk') id`)).id;
check((await one(db, `select public.dm_start('berk') id`)).id === t, "the same thread twice");
const m1 = (await one(db, `select public.dm_send('${t}', 'tonight on the archive?', 'eeeeeeee-0000-0000-0000-000000000001') id`)).id;
const m1b = (await one(db, `select public.dm_send('${t}', 'tonight on the archive?', 'eeeeeeee-0000-0000-0000-000000000001') id`)).id;
check(m1 === m1b, "a line sent twice from the outbox is stored once");
await mustBeRefused(db, `select public.dm_send('${t}', '')`, "an empty line is refused");
await asUser(db, BERK);
let list = await rpc(db, "dm_list");
check(list.length === 1 && list[0].unread === 1 && list[0].last_body === "tonight on the archive?", "berk: one thread, one unread");
const th = await rpc(db, "dm_thread", { p_thread: t });
check(th.length === 1 && th[0].mine === false && th[0].name === "ada", "the thread reads oldest first");
await db.exec(`select public.dm_seen('${t}', ${m1})`);
check((await rpc(db, "dm_list"))[0].unread === 0, "seen: nothing unread");
const m2 = (await one(db, `select public.dm_send('${t}', 'yes, 23:00') id`)).id;
await db.exec(`select public.dm_unsay(${m2})`);
check((await rpc(db, "dm_thread", { p_thread: t })).length === 1, "a line taken back is gone");
await asUser(db, CAN);
await mustBeRefused(db, `select * from public.dm_thread('${t}')`, "a stranger cannot read it", /no such/);
await asUser(db, BERK);
await db.exec(`select public.block_user('${ADA}')`);
await asUser(db, ADA);
await mustBeRefused(db, `select public.dm_send('${t}', 'hello?')`, "blocked: no more lines", /no such conversation/);
check((await rpc(db, "dm_list")).length === 0, "and the thread is hidden");

finish();
