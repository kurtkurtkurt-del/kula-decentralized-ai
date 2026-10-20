/* 05: requests, accepts, removes, and what a block does to them. */
import { build, check, asUser, rpc, one, people, ADA, BERK, CAN, finish } from "./lib.mjs";

const db = await build("05_friends.sql");
await people(db);

await asUser(db, ADA);
check((await one(db, `select public.friend_request('nobody') s`)).s === "notfound", "an unknown handle: notfound");
check((await one(db, `select public.friend_request('ada') s`)).s === "yourself", "yourself");
check((await one(db, `select public.friend_request('@berk') s`)).s === "sent", "a request to berk is sent");
check((await one(db, `select public.friend_request('berk') s`)).s === "sent", "sending twice is harmless");
await asUser(db, BERK);
let l = await rpc(db, "friends_list");
check(l.length === 1 && l[0].direction === "incoming" && l[0].status === "pending", "berk sees it incoming");
check((await one(db, `select public.friend_request('ada') s`)).s === "accepted", "asking back accepts");
l = await rpc(db, "friends_list");
check(l[0].status === "accepted", "now friends");

await asUser(db, CAN);
await db.exec(`select public.friend_request('berk')`);
await asUser(db, BERK);
check((await one(db, `select public.friend_accept('${CAN}') b`)).b === true, "berk accepts can");
check((await rpc(db, "friends_list")).length === 2, "two friends");
check((await one(db, `select public.friend_remove('${CAN}') b`)).b === true, "and removes can again");
check((await rpc(db, "friends_list")).length === 1, "one friend");

await asUser(db, CAN);
await db.exec(`select public.block_user('${ADA}')`);
await asUser(db, ADA);
check((await one(db, `select public.friend_request('can') s`)).s === "notfound", "a request never reaches someone who blocked you");
await asUser(db, CAN);
await db.exec(`select public.friend_request('ada')`);
check((await rpc(db, "friends_list")).length === 0, "nor goes out from them (the list hides it)");

finish();
