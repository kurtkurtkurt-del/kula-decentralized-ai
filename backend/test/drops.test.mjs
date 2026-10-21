/* 17: a passport handed over by a connect id. */
import { build, check, mustBeRefused, asAnon, asService, rpc, one, finish } from "./lib.mjs";

const db = await build("17_passport_drops.sql");
const mac = (tps = 21.3) => JSON.stringify({ schema: "passport/0.3", device: "apple macbook air", soc: "Apple M1", android: "macos 14.6", ram_total_gb: 8, ram_free_gb: 3.1, est_tps: tps, largest_model_q4: "~3B", kind: "computer", os: "macos 14.6", device_id: "9a2b3c4d-0000-4000-8000-000000000001", measured_at: "2026-10-21T18:00:00Z" });
const drop = (code, data) => `select public.passport_drop('${code}', '${data}'::jsonb)`;
const pick = async (code) => (await rpc(db, "passport_pick", { p_code: code }))[0].passport_pick;

console.log("\n— a drop and a pickup, signed out —");
await asAnon(db);
await db.exec(drop("K7M2QX", mac()));
const got = await pick("K7M2QX");
check(got && got.device === "apple macbook air" && got.kind === "computer", "the phone picks up what the mac dropped");
check((await pick("K7M2QX")) === null, "a pickup is once: the second one finds nothing");
check((await pick("ZZZZZ9")) === null, "an id nobody dropped under: null, not an error");
check((await pick("bad")) === null, "a malformed id on pickup: null");

await db.exec(drop("k7m2qx", mac()));
check((await pick(" K7M2QX ")) !== null, "lower case and spaces: the same id");

await db.exec(drop("H4PW8N", mac(10)));
await db.exec(drop("H4PW8N", mac(12.5)));
check((await pick("H4PW8N")).est_tps === 12.5, "a second drop under one id replaces the first");

console.log("\n— what is refused —");
await mustBeRefused(db, drop("K7M2Q", mac()), "five characters", /connect id/);
await mustBeRefused(db, drop("K7M2QO", mac()), "an O (reads like 0)", /connect id/);
await mustBeRefused(db, drop("K7M2Q1", mac()), "a 1 (reads like I)", /connect id/);
await mustBeRefused(db, drop("K7M2QX", JSON.stringify({ hello: "world" })), "not a passport", /not a passport/);
await mustBeRefused(db, drop("K7M2QX", JSON.stringify({ schema: "passport/1.0", device: "x", est_tps: 1 })), "a schema we do not read", /not a passport/);
await mustBeRefused(db, drop("K7M2QX", JSON.stringify({ schema: "passport/0.2", device: "x" })), "no est_tps", /incomplete/);
await mustBeRefused(db, drop("K7M2QX", JSON.stringify({ schema: "passport/0.2", device: "x", est_tps: -1 })), "a negative speed", /incomplete/);
await mustBeRefused(db, drop("K7M2QX", JSON.stringify({ schema: "passport/0.2", device: "x", est_tps: 1, pad: "x".repeat(17000) })), "over 16 kb", /too large/);
await mustBeRefused(db, `select * from public.passport_drops`, "the table itself is closed to guests", /permission/);
await mustBeRefused(db, `insert into public.passport_drops (code, data) values ('ABCDEF', '{}')`, "…and to writing past the function", /permission/);

console.log("\n— fifteen minutes —");
await db.exec(drop("T9RF3B", mac()));
await asService(db);
await db.exec(`update public.passport_drops set created_at = now() - interval '16 minutes' where code = 'T9RF3B'`);
await asAnon(db);
check((await pick("T9RF3B")) === null, "a drop older than 15 minutes is not handed out");
await db.exec(drop("W5JN6C", mac()));
await asService(db);
check(Number((await one(db, `select count(*) n from public.passport_drops`)).n) === 1, "a new drop sweeps the expired ones away");

finish();
