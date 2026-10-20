/* 14 and 15: terms, reports, errors, the floor, feedback, pruning, health. */
import { build, check, mustBeRefused, asUser, asAnon, asService, rpc, one, people, befriend, ADA, BERK, CAN, finish } from "./lib.mjs";

const db = await build("15_health.sql");
await people(db);
await befriend(db, ADA, BERK);

await asUser(db, BERK);
check((await rpc(db, "terms_status"))[0].version === null, "no terms yet");
await db.exec(`select public.accept_terms(1)`);
check((await rpc(db, "terms_status"))[0].version === 1, "accepted v1");

console.log("\n— reports —");
const t = (await one(db, `select public.dm_start('ada') id`)).id;
const m = (await one(db, `select public.dm_send('${t}', 'something unkind') id`)).id;
await asUser(db, ADA);
await db.exec(`select public.report('dm', '${m}', 'rude')`);
await db.exec(`select public.report('profile', 'berk', null)`);
await mustBeRefused(db, `select public.report('x', '1', null)`, "an unknown kind");
let r = await rpc(db, "staff_reports");
check(r.length === 2 && r.find((x) => x.kind === "dm").snapshot === "something unkind" && r.find((x) => x.kind === "dm").reasons[0] === "rude", "the admin sees the two reports with a snapshot");
await db.exec(`select public.staff_report_settle('dm', '${m}', true)`);
check((await rpc(db, "dm_thread", { p_thread: t })).length === 0, "removed: the line is gone");
await db.exec(`select public.staff_report_settle('profile', 'berk', false)`);
check((await rpc(db, "staff_reports")).length === 0, "both settled");
await asUser(db, CAN);
await mustBeRefused(db, `select * from public.staff_reports()`, "a member cannot read reports", /admins/);

console.log("\n— errors, the floor, feedback —");
await asAnon(db);
await db.exec(`select public.log_error('boom', 'at x', 'flow', 'android', '0.1.0', true)`);
await db.exec(`select public.feedback_send('hi', 'the deck is lovely', null)`);
check((await one(db, `select public.min_app_version() v`)).v === "0.1.0", "the floor starts at 0.1.0");
await asUser(db, ADA);
check((await rpc(db, "admin_errors")).length === 1 && (await rpc(db, "admin_errors"))[0].fatal, "the admin reads the error");
check((await rpc(db, "feedback_list")).length === 1, "and the feedback");
check((await one(db, `select public.set_min_app_version('0.2.0') v`)).v === "0.2.0", "the floor moves");
check((await one(db, `select public.version_lt('0.1.9', '0.2.0') b`)).b === true, "0.1.9 < 0.2.0 (numbers, not letters)");
await db.exec(`select public.admin_errors_clear()`);
check((await rpc(db, "admin_errors")).length === 0, "errors cleared");
check((await rpc(db, "admin_people", { p_query: "be" })).length === 1, "admin_people finds berk");

console.log("\n— pruning and health —");
await asUser(db, ADA);
await db.exec(`select public.join_set('koy-okulu-ogretmen', 'right')`);
await db.exec(`select public.contribution_start('koy-okulu-ogretmen', gen_random_uuid())`);
await db.exec(`select public.contribution_start('koy-okulu-ogretmen', gen_random_uuid())`);
await asService(db);
await db.exec(`update public.contributions set started_at = now() - interval '2 days', ended_at = now() - interval '2 days' where card_no is null and ended_at is not null`);
check((await one(db, `select public.retention_prune() n`)).n === 1, "the abandoned night of two days ago is pruned");
await asAnon(db);
const h = (await rpc(db, "health"))[0];
check(Number(h.projects) === 10 && Number(h.people) === 4 && Number(h.nights_tonight) === 1 && Number(h.friendships) === 1, "health counts");
await asService(db);
await db.exec(`update public.contributions set started_at = now() - interval '2 days' where ended_at is null`);
await asAnon(db);
check(Number((await rpc(db, "health"))[0].nights_stuck) === 1, "a night open for two days is stuck");

finish();
