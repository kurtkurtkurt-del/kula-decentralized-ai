/* 07: the passport on the server, the network clusters. */
import { build, check, mustBeRefused, asUser, asAnon, asService, rpc, one, people, ADA, BERK, finish } from "./lib.mjs";

const db = await build("07_passports.sql");
await people(db);
const P = (tps, at = "2026-10-20T21:01:12Z") => JSON.stringify({ schema: "passport/0.1", device: "Google Pixel 8", soc: "Tensor G3", android: "15", ram_total_gb: 8, ram_free_gb: 3.6, app_mem_cap_mb: 512, cpu_cores: 9, cpu_max_ghz: 2.91, mem_bw_gbs: 14.2, gflops: 31.4, storage_free_gb: 41, battery_pct: 87, charging: true, largest_model_q4: "~3B", est_tps: tps, measured_at: at });
const C1 = "aaaaaaaa-0000-0000-0000-000000000001", C2 = "aaaaaaaa-0000-0000-0000-000000000002";

await asAnon(db);
await mustBeRefused(db, `select public.passport_save('${P(3.9)}', '${C1}')`, "a guest saves nothing");
await asUser(db, ADA);
const id1 = (await one(db, `select public.passport_save('${P(3.9)}', '${C1}') id`)).id;
const id1b = (await one(db, `select public.passport_save('${P(99)}', '${C1}') id`)).id;
check(id1 === id1b, "the same client_id returns the first (a retry changes nothing)");
check((await one(db, `select public.passport_last() j`)).j.est_tps === 3.9, "passport_last is the one saved");
await mustBeRefused(db, `select public.passport_save('{"schema":"x"}', '${C2}')`, "an unknown schema is refused", /schema/);
await mustBeRefused(db, `select public.passport_save('{"schema":"passport/0.1"}', '${C2}')`, "est_tps must be there", /est_tps/);
for (let i = 0; i < 12; i++) await db.exec(`select public.passport_save('${P(4 + i, `2026-10-${String(1 + i).padStart(2, "0")}T21:00:00Z`)}', 'bbbbbbbb-0000-0000-0000-${String(i).padStart(12, "0")}')`);
check((await rpc(db, "passport_mine", { p_limit: 100 })).length === 13, "every measurement is kept (twelve plus the first)");
check((await rpc(db, "passport_mine")).length === 10, "passport_mine gives ten unless asked for more");
check((await one(db, `select public.passport_last() j`)).j.est_tps === 3.9, "…the newest by measured_at stays the last (today's)");
check((await one(db, `select (public.passport_save('${P(1, "2099-01-01T00:00:00Z")}', 'cccccccc-0000-0000-0000-000000000000')) is not null ok`)).ok, "a measured_at in the future is accepted…");
await asService(db);
check((await one(db, `select max(measured_at) <= now() ok from public.passports`)).ok, "…and clamped to now");

console.log("\n— the network —");
await asService(db);
await db.exec(`update public.profiles set city_id = (select id from public.cities where slug = 'istanbul') where id in ('${ADA}', '${BERK}')`);
await asUser(db, BERK);
await db.exec(`select public.passport_save('${P(2.5)}', '${C2}')`);
await db.exec(`select public.join_set('yerel-tarih-arsivi', 'right')`);
await asAnon(db);
const n = await rpc(db, "network_nodes");
const ist = n.find((x) => x.city_slug === "istanbul");
check(n.length === 10, "ten cities");
check(ist.phones === 2 && Number(ist.tps) === 3.5 && ist.projects.includes("yerel-tarih-arsivi"), "istanbul: two phones, their speed summed, the project they keep");
check(n.find((x) => x.city_slug === "berlin").phones === 0, "berlin: nobody yet");
await asUser(db, ADA);
check((await one(db, `select jsonb_array_length(public.export_me() -> 'passports') n`)).n === 14, "the export carries every passport");

finish();
