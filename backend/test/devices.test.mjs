/* 16: the device catalog and the network's night. */
import { build, check, asUser, asAnon, asService, rpc, one, people, ADA, BERK, CAN, finish } from "./lib.mjs";

const db = await build("16_devices.sql");
await people(db);
const S25 = { device: "samsung SM-S936B", soc: "SM8750", android: "16", ram_total_gb: 10.9, app_mem_cap_mb: 512, cpu_cores: 8, cpu_max_ghz: 4.47, gflops: 61.2, storage_free_gb: 180, battery_pct: 30, charging: true, largest_model_q4: "~3B" };
const v03 = (free, read, low, high, at) => JSON.stringify({ schema: "passport/0.3", ...S25, ram_free_gb: free, mem_bw_gbs: 25.9, est_tps: 7.2, measured_at: at,
  mem_bw_read_gbs: read, best_threads: 4, budget: { ctx: 2048, reserve_gb: 0.5, ram_gb: free * 0.8 - 0.5 }, estimate: { fit_b: 4, tps_low: low, tps_high: high, source: "estimate" } });
const js = JSON.stringify({ schema: "passport/0.2", ...S25, ram_free_gb: 4.9, mem_bw_gbs: 44.74, gflops: 0.02, est_tps: 37.3, approx: true, measured_at: "2026-10-21T10:20:00Z" });
const pixel = JSON.stringify({ schema: "passport/0.2", device: "Google Pixel 8", soc: "Tensor G3", ram_total_gb: 8, ram_free_gb: 3.6, mem_bw_gbs: 14.2, est_tps: 3.9, measured_at: "2026-10-20T21:00:00Z" });
const id = (n) => `eeeeeeee-0000-0000-0000-${String(n).padStart(12, "0")}`;
const now = (h) => new Date(Date.now() - h * 3600_000).toISOString();

await asUser(db, ADA);
await db.exec(`select public.passport_save('${v03(4.9, 38, 4.7, 9.3, now(48))}', '${id(1)}')`);
await db.exec(`select public.passport_save('${v03(4.2, 30, 3.7, 7.4, now(1))}', '${id(2)}')`);
await asUser(db, CAN);
await db.exec(`select public.passport_save('${js}', '${id(3)}')`);
await asUser(db, BERK);
await db.exec(`select public.passport_save('${pixel.replace("2026-10-20T21:00:00Z", now(2))}', '${id(4)}')`);

console.log("\n— the catalog —");
await asAnon(db);
const cat = await rpc(db, "device_catalog");
const s25 = cat.find((r) => r.device === "samsung SM-S936B");
check(cat.length === 2, "two device models");
check(s25.phones === 2 && s25.passports === 3 && s25.native === 2, "the S25+: two phones, three measurements, two of them native");
check(Number(s25.mem_bw_gbs) === 25.9, "bandwidth only from native measurements (the JS 44.74 is left out)");
check(Number(s25.mem_bw_read_gbs) === 34 && s25.best_threads === 4, "the read bandwidth's median and the usual thread count");
check(Number(s25.ram_free_min) === 4.2 && Number(s25.ram_free_max) === 4.9, "the spread of free memory over every measurement");
check(Number(s25.tps_low) === 4.2 && Number(s25.tps_high) === 8.4, "the speed range's medians, native only");
check(cat.find((r) => r.device === "Google Pixel 8").tps_low == 3.9, "a 0.2 passport: low = high = est_tps");
check(!Object.keys(s25).some((k) => /user|handle|id/.test(k)), "no person in the catalog");

console.log("\n— the network's night —");
let net = (await rpc(db, "network_estimate"))[0];
check(net.phones === 3 && net.observed === 0, "three phones, none with a night yet");
const r1 = (x) => Math.round(x * 10) / 10;
check(Number(net.tps_low) === r1(3.7 + 37.3 + 3.9) && Number(net.tps_high) === r1(7.4 + 37.3 + 3.9), "each person's newest passport, summed (ada's of an hour ago)");
check(Number(net.tokens_night_low) === Math.round((3.7 + 37.3 + 3.9) * 3600 * 8.5), "tokens a night = speed × 3600 × 8.5 hours");
check(net.by_device.length === 2 && net.by_device[0].device === "samsung SM-S936B" && net.by_device[0].phones === 2, "by device, most phones first");
net = (await rpc(db, "network_estimate", { p_hours: 100 }))[0];
check(Number(net.hours) === 24, "hours are held between half an hour and a day");

await asService(db);
const project = (await one(db, `select id from public.projects order by slug limit 1`)).id;
await db.exec(`insert into public.contributions (user_id, project_id, client_id, card_no, started_at, ended_at, tokens, seconds)
  values ('${BERK}', '${project}', '${id(9)}', 1, now() - interval '9 hours', now() - interval '1 hour', 57600, 28800)`);
await asAnon(db);
net = (await rpc(db, "network_estimate"))[0];
check(net.observed === 1 && Number(net.tps_low) === 3.7 + 37.3 + 2, "a finished night beats the estimate: berk's real 2.0 tok/s replaces 3.9");

await asService(db);
await db.exec(`update public.passports set measured_at = now() - interval '40 days' where user_id = '${CAN}'`);
await asAnon(db);
check((await rpc(db, "network_estimate"))[0].phones === 2, "a passport older than 30 days no longer counts");
check((await rpc(db, "device_catalog")).find((r) => r.device === "samsung SM-S936B").passports === 3, "…but stays in the catalog");

finish();
