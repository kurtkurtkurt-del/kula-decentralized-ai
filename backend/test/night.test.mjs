/* 18: the morning report on the server — numbers only, once per night, own rows only. */
import { build, check, mustBeRefused, asUser, asAnon, asService, rpc, one, people, ADA, BERK, CAN, finish } from "./lib.mjs";

const db = await build("18_night.sql");
await people(db);
const SLUG = "koy-okulu-ogretmen", SLUG2 = "afet-mesaj-siniflandirma";
const DEV_B = "9a2b3c4d-0000-4000-8000-00000000000b", DEV_B2 = "9a2b3c4d-0000-4000-8000-00000000000c", DEV_C = "9a2b3c4d-0000-4000-8000-00000000000d";
const today = (await one(db, `select current_date::text d`)).d;
const daysAgo = async (n) => (await one(db, `select (current_date - ${n})::text d`)).d;
const report = (p = {}) => ({ id: today, slug: SLUG, device_id: DEV_B, units: 300, checked: 40, wrong: 4, tokens: 36000, seconds: 3600, segments: 2, tps: 10, wh: 3.2, model: "tiny", real: true, app_version: "1.4.0",
  devices: [{ id: "me", name: "this phone", tokens: 24000, units: 200, tps: 6.7 }, { id: "p1", name: "tablet", tokens: 12000, units: 100, tps: 3.3 }], ...p });
const send = async (r, cid) => (await rpc(db, "night_report", { p_report: JSON.stringify(r), p_client_id: cid }))[0].night_report;
const cid = (n) => `c0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

console.log("\n— berk's first night —");
await asUser(db, BERK);
const id1 = await send(report(), cid(1));
check(!!id1, "the report is taken, an id comes back");
check((await send(report(), cid(1))) === id1, "the same client id again: the same id, no second row");
check((await send(report({ units: 999 }), cid(2))) === id1, "the same device, project and night under a new client id: still the first row");
let mine = await rpc(db, "night_reports", {});
check(mine.length === 1 && mine[0].units === 300 && mine[0].mode === "real" && mine[0].slug === SLUG && mine[0].devices === 2 && mine[0].segments === 2, "night_reports: the row as sent, mode real, two devices");
check(Number(mine[0].tps) === 10 && Number(mine[0].wh) === 3.2 && mine[0].model === "tiny", "tok/s, wh and the model kept");
const stored = await one(db, `select *, night::text as night_text from public.night_reports where id = $1`, [id1]);
check(stored.app_version === "1.4.0" && stored.night_text === today, "app version and the night's date in the row");
check(!("report" in stored) && Object.keys(stored).filter((k) => k !== "night_text").every((k) => !/prompt|text|answer|output/.test(k)), "nothing but numbers and names: no json, no prompt column");

console.log("\n— what is refused —");
const bad = (r, c, name, re) => mustBeRefused(db, `select public.night_report('${JSON.stringify(r).replace(/'/g, "''")}'::jsonb, '${c}')`, name, re);
await bad(report({ slug: "no-such-project" }), cid(10), "an unknown project", /noproject/);
await bad(report({ device_id: "phone" }), cid(11), "a device id that is not a uuid", /device id/);
await bad(report({ id: "2020-01-01" }), cid(12), "a night eight days back or more", /out of range/);
await bad(report({ id: "2999-01-01" }), cid(13), "a night in the future", /out of range/);
await bad(report({ id: "not-a-date" }), cid(14), "a night that is not a date", /out of range/);
await bad(report({ checked: 400 }), cid(15), "more checked than units", /add up/);
await bad(report({ wrong: 50 }), cid(16), "more wrong than checked", /add up/);
await bad(report({ units: -1 }), cid(17), "a negative count", /add up/);
await bad(report({ seconds: 90000 }), cid(18), "more than a day", /out of bounds/);
await bad(report({ seconds: 0, tokens: 100 }), cid(19), "tokens without a second of work", /add up/);
await bad(report({ tps: 500 }), cid(20), "a tok/s that the tokens and seconds do not give", /add up/);
await bad(report({ wh: 99999 }), cid(21), "an impossible wh", /out of bounds/);
await bad("hello", cid(22), "not an object", /not a report/);
await mustBeRefused(db, `select public.night_report('${JSON.stringify(report({ pad: "x".repeat(17000) }))}'::jsonb, '${cid(23)}')`, "over 16 kb", /too large/);
await mustBeRefused(db, `select public.night_report('{}'::jsonb, null)`, "no client id", /client id/);
await asAnon(db);
await mustBeRefused(db, `select public.night_report('{}'::jsonb, '${cid(24)}')`, "signed out", /permission/);
await mustBeRefused(db, `select * from public.night_reports`, "the table is closed to guests", /permission/);

console.log("\n— a sim night, a missing field or two, tps worked out —");
await asUser(db, BERK);
const idSim = await send({ id: await daysAgo(1), slug: SLUG2, device_id: DEV_B, units: 10, tokens: 1200, seconds: 600, real: false }, cid(30));
const sim = await one(db, `select * from public.night_reports where id = $1`, [idSim]);
check(sim.mode === "sim" && sim.checked === 0 && sim.wrong === 0 && Number(sim.tps) === 2 && sim.devices === 1 && sim.segments === 1 && sim.model === null, "sim mode, zeros for what was not sent, tps = tokens / seconds");

console.log("\n— own rows only (rls) —");
await asService(db);
const PROJ = (await one(db, `select id from public.projects where slug = $1`, [SLUG])).id;
await asUser(db, CAN);
check((await rpc(db, "night_reports", {})).length === 0, "can sees none of berk's reports through the function");
check((await db.query(`select count(*)::int n from public.night_reports`)).rows[0].n === 0, "…nor through the table (the policy)");
await mustBeRefused(db, `insert into public.night_reports (user_id, device_id, project_id, night, client_id, units, checked, wrong, tokens, seconds, tps, wh, mode)
  values ('${BERK}', '${DEV_C}', '${PROJ}', current_date, '${cid(40)}', 1, 0, 0, 10, 10, 1, 0.1, 'sim')`, "can cannot write a row in berk's name", /row-level security/);
await db.exec(`insert into public.night_reports (user_id, device_id, project_id, night, client_id, units, checked, wrong, tokens, seconds, tps, wh, mode)
  values ('${CAN}', '${DEV_C}', '${PROJ}', current_date, '${cid(41)}', 1, 0, 0, 10, 10, 1, 0.1, 'sim')`);
check((await db.query(`select count(*)::int n from public.night_reports`)).rows[0].n === 1, "can may write and read a row of their own directly");
await mustBeRefused(db, `update public.night_reports set units = 5`, "no updating, not even your own (reports are final)", /permission|row-level/);
await mustBeRefused(db, `select * from public.night_project_months`, "the views are not open", /permission/);
await mustBeRefused(db, `select * from public.night_leaderboard_30d`, "…none of them", /permission/);
await asUser(db, BERK);
check((await db.query(`select count(*)::int n from public.night_reports`)).rows[0].n === 2, "berk sees berk's two rows, not can's");

console.log("\n— the detail lines —");
const n = (await rpc(db, "night_units_add", { p_report_id: id1, p_units: JSON.stringify([{ idx: 0, tokens: 120, ms: 900, ok: true }, { idx: 1, tokens: 80, ms: 700 }, { idx: 2, tokens: 90, ms: 800, ok: false }]) }))[0].night_units_add;
check(n === 3, "three unit lines added");
const again = (await rpc(db, "night_units_add", { p_report_id: id1, p_units: JSON.stringify([{ idx: 0, tokens: 999, ms: 1 }]) }))[0].night_units_add;
check(again === 0 && (await one(db, `select tokens from public.night_units where report_id = $1 and idx = 0`, [id1])).tokens === 120, "a retry adds nothing and changes nothing");
await asUser(db, CAN);
await mustBeRefused(db, `select public.night_units_add('${id1}', '[{"idx":9,"tokens":1,"ms":1}]'::jsonb)`, "can cannot add lines to berk's report", /nonight/);
check((await db.query(`select count(*)::int n from public.night_units`)).rows[0].n === 0, "…nor read them");

console.log("\n— the summary on the card: this month, in all, the streak —");
await asUser(db, BERK);
await send(report({ id: await daysAgo(2), slug: SLUG }), cid(50));
await send(report({ id: await daysAgo(1), slug: SLUG }), cid(51));
let sum = await rpc(db, "night_mine_summary", {});
const row = sum.find((r) => r.slug === SLUG);
check(row && row.nights_total === 3 && (row.last_night instanceof Date ? row.last_night.toISOString() : String(row.last_night)).slice(0, 10) === today, "koy-okulu: three nights in all, the last one today");
check(row.nights_month >= 1 && row.nights_month <= 3, "nights this month counted (the month may have turned)");
check(row.streak === 3, "three nights in a row: streak 3");
await send(report({ id: await daysAgo(5), slug: SLUG, device_id: DEV_B2 }), cid(52));
sum = await rpc(db, "night_mine_summary", { p_device_id: DEV_B2 });
check(sum.find((r) => r.slug === SLUG).streak === 0, "a device whose last night was five days ago has no streak running");
const str = await one(db, `select streak, last_night from public.night_device_streaks where device_id = $1`, [DEV_B]).catch(() => null);
await asService(db);
const streaks = (await db.query(`select device_id, streak from public.night_device_streaks where user_id = $1 order by device_id`, [BERK])).rows;
check(str === null && streaks.length === 2 && streaks.find((s) => s.device_id === DEV_B).streak === 3 && streaks.find((s) => s.device_id === DEV_B2).streak === 1, "the streak view: 3 for the phone, 1 for the second device; closed to users");

console.log("\n— the project's owner —");
await asUser(db, CAN);
await mustBeRefused(db, `select * from public.project_summary('${SLUG}')`, "can, not the owner, is refused", /owner/);
await asService(db);
await db.exec(`update public.projects set owner_id = '${CAN}' where slug = '${SLUG}'`);
await asUser(db, CAN);
const ps = await rpc(db, "project_summary", { p_slug: SLUG });
const total = ps.reduce((a, m) => a + m.nights, 0);
check(ps.length >= 1 && total === 5, "the owner sees the months: five nights in all (berk's four, can's one)");
check(ps.every((m) => !("handle" in m) && !("user_id" in m)) && ps.reduce((a, m) => a + m.phones, 0) >= 2, "counts and phones, never who");
check(Number(ps.reduce((a, m) => a + Number(m.units), 0)) === 300 * 4 + 1 && Number(ps.reduce((a, m) => a + Number(m.wrong), 0)) === 16, "units and wrong added up");
await mustBeRefused(db, `select * from public.project_summary('${SLUG2}')`, "…but not another project's", /owner/);
await asUser(db, ADA);
check((await rpc(db, "project_summary", { p_slug: SLUG2 })).length === 1, "the admin reads any project's summary");

console.log("\n— the leaderboard, by handle —");
await asUser(db, CAN);
let board = await rpc(db, "night_leaderboard", {});
check(board[0].handle === "berk" && board[0].nights === 4 && board.find((b) => b.handle === "can").me === true, "berk leads with four nights; can is marked as me");
check(board.every((b) => !("user_id" in b)), "handles only, no ids");
await asService(db);
await db.exec(`update public.profile_settings set kept_visibility = 'private' where user_id = '${BERK}'`);
await asUser(db, CAN);
board = await rpc(db, "night_leaderboard", {});
check(!board.find((b) => b.handle === "berk"), "a private person is not on the board");
await asAnon(db);
await mustBeRefused(db, `select * from public.night_leaderboard()`, "signed out: no board", /permission/);

console.log("\n— the ledger head —");
const H1 = "a".repeat(64), H2 = "b".repeat(64), SIG = "sig_" + "0".repeat(40);
await asUser(db, BERK);
await rpc(db, "ledger_head_set", { p_device_id: DEV_B, p_seq: 10, p_hash: H1, p_signature: SIG });
await rpc(db, "ledger_head_set", { p_device_id: DEV_B, p_seq: 10, p_hash: H1, p_signature: SIG });
let heads = await rpc(db, "ledger_head_mine", {});
check(heads.length === 1 && Number(heads[0].seq) === 10 && heads[0].head_hash === H1 && heads[0].alg === "ed25519", "the head is kept; the same head again is fine");
await rpc(db, "ledger_head_set", { p_device_id: DEV_B, p_seq: 12, p_hash: H2, p_signature: SIG, p_alg: "ed25519" });
heads = await rpc(db, "ledger_head_mine", {});
check(Number(heads[0].seq) === 12 && heads[0].head_hash === H2, "a later head replaces it");
await mustBeRefused(db, `select public.ledger_head_set('${DEV_B}', 11, '${H1}', '${SIG}')`, "a head behind the last one is refused", /goes back/);
await mustBeRefused(db, `select public.ledger_head_set('${DEV_B}', 12, '${H1}', '${SIG}')`, "the same seq with another hash is refused", /goes back/);
await mustBeRefused(db, `select public.ledger_head_set('${DEV_B}', 13, 'nothex', '${SIG}')`, "a hash that is not sha256 hex", /check|violates/);
await mustBeRefused(db, `select public.ledger_head_set('${DEV_B}', 13, '${H2}', '${SIG}', 'rsa')`, "an algorithm we do not read", /check|violates/);
await asUser(db, CAN);
check((await rpc(db, "ledger_head_mine", {})).length === 0 && (await db.query(`select count(*)::int n from public.device_ledger_heads`)).rows[0].n === 0, "can sees no head of berk's, by function or table");
check(!("signature" in heads[0]), "ledger_head_mine does not hand the signature back (the server keeps it for v1)");

console.log("\n— a second paste changes nothing —");
await asService(db);
const before = (await db.query(`select count(*)::int n from public.night_reports`)).rows[0].n;
const { read } = await import("./lib.mjs");
await db.exec(await read("../sql/18_night.sql"));
check((await db.query(`select count(*)::int n from public.night_reports`)).rows[0].n === before, "18_night.sql runs twice without harm");

finish();
