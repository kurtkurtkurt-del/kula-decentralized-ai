/* 08: a night on a project, the card, the credit. */
import { build, check, mustBeRefused, asUser, asService, rpc, one, people, befriend, ADA, BERK, CAN, finish } from "./lib.mjs";

const db = await build("08_contributions.sql");
await people(db);
const C = (n) => `cccccccc-0000-0000-0000-${String(n).padStart(12, "0")}`;

console.log("\n— starting —");
await asUser(db, ADA);
await mustBeRefused(db, `select public.contribution_start('koy-okulu-ogretmen', '${C(1)}')`, "a project you did not keep: notkept", /notkept/);
await db.exec(`select public.join_set('koy-okulu-ogretmen', 'right')`);
await db.exec(`select public.join_set('yerel-tarih-arsivi', 'right')`);
await mustBeRefused(db, `select public.contribution_start('nope', '${C(1)}')`, "an unknown project: noproject", /noproject/);
const k1 = (await one(db, `select public.contribution_start('koy-okulu-ogretmen', '${C(1)}', now() - interval '10 minutes') id`)).id;
check(k1 && (await one(db, `select public.contribution_start('koy-okulu-ogretmen', '${C(1)}') id`)).id === k1, "a retry with the same client_id returns the first");
const open = await rpc(db, "contribution_open");
check(open.length === 1 && open[0].slug === "koy-okulu-ogretmen", "contribution_open shows it");
const k2 = (await one(db, `select public.contribution_start('yerel-tarih-arsivi', '${C(2)}') id`)).id;
check((await rpc(db, "contribution_open"))[0].id === k2, "a second start closes the first with nothing");
await asService(db);
check((await one(db, `select ended_at is not null e from public.contributions where id = '${k1}'`)).e, "the abandoned night is closed");

console.log("\n— ending, the card, the credit —");
await asUser(db, ADA);
const card = (await one(db, `select public.contribution_end('${k2}', 70000, 30600, 0.034) n`)).n;
check(card === 1, "the first card is no. 1");
check((await one(db, `select public.contribution_end('${k2}', 1, 1, 1) n`)).n === 1, "ending twice changes nothing");
const cards = await rpc(db, "my_cards");
check(cards.length === 1 && cards[0].slug === "yerel-tarih-arsivi" && Number(cards[0].tokens) === 70000 && cards[0].night_no === 1, "my_cards: one card with the project");
const credits = await rpc(db, "credits_mine");
check(credits.length === 1 && Number(credits[0].amount) === 70 && Number(credits[0].weight) === 1, "7B: 70 000 tokens → 70 credits (weight 1)");
const me = (await rpc(db, "profile_me"))[0];
check(me.night_count === 1 && Number(me.credits) === 70, "profile_me counts the night and the credits");
const pg = (await rpc(db, "project_page", { p_slug: "yerel-tarih-arsivi" }))[0];
check(pg.nights_done === 1 && Number(pg.tokens) === 70000, "the project page counts it");

console.log("\n— the cap from the passport —");
await db.exec(`select public.passport_save('{"schema":"passport/0.1","est_tps":2,"measured_at":"2026-10-20T21:00:00Z"}', 'dddddddd-0000-0000-0000-000000000001')`);
await db.exec(`select public.join_set('koy-okulu-ogretmen', 'right')`);
const k3 = (await one(db, `select public.contribution_start('koy-okulu-ogretmen', '${C(3)}') id`)).id;
await db.exec(`select public.contribution_end('${k3}', 1000000, 1000, 0.001)`);
await asService(db);
const r3 = await one(db, `select tokens, credits from public.contributions where id = '${k3}'`);
check(Number(r3.tokens) === 3000 && Number(r3.credits) === 1.29, "tokens capped at est_tps × seconds × 1.5; 3B weight 3/7 → 1.29");

console.log("\n— friends —");
await befriend(db, ADA, BERK);
await asUser(db, BERK);
check((await rpc(db, "person_cards", { p_handle: "ada" })).length === 2, "a friend sees ada's two cards");
await asUser(db, CAN);
check((await rpc(db, "person_cards", { p_handle: "ada" })).length === 0, "a stranger sees none");
await asUser(db, BERK);
await db.exec(`select public.join_set('koy-okulu-ogretmen', 'right')`);
await db.exec(`select public.contribution_start('koy-okulu-ogretmen', '${C(4)}')`);
await asUser(db, ADA);
const live = await rpc(db, "friends_live");
check(live.length === 1 && live[0].handle === "berk" && live[0].slug === "koy-okulu-ogretmen", "friends_live: berk is in a night now");
await asUser(db, BERK);
const kb = (await rpc(db, "contribution_open"))[0].id;
await db.exec(`select public.contribution_end('${kb}', 500, 100, 0.0001)`);
await asUser(db, ADA);
const k5 = (await one(db, `select public.contribution_start('koy-okulu-ogretmen', '${C(5)}') id`)).id;
await db.exec(`select public.contribution_end('${k5}', 500, 100, 0.0001)`);
const mine = await rpc(db, "my_cards");
check(mine[0].crew.length === 1 && mine[0].crew[0] === "berk", "the same project the same night: berk is on the back of the card");
check((await one(db, `select jsonb_array_length(public.export_me() -> 'nights') n`)).n === 4, "the export carries the nights");

finish();
