/* 12: about and samples, the panel's project save. */
import { build, check, mustBeRefused, asUser, asAnon, rpc, one, people, ADA, BERK, finish } from "./lib.mjs";

const db = await build("12_about.sql");
await people(db);

await asAnon(db);
const ids = (await rpc(db, "deck")).map((p) => p.id);
const ab = await rpc(db, "about_for", { p_projects: ids, p_lang: "tr" });
check(ab.length === 10 && ab.every((a) => a.lang === "en"), "ten abouts, english when turkish is missing");
const sm = await rpc(db, "samples_for", { p_projects: ids, p_lang: "en" });
check(sm.length === 10 && sm.every((s) => s.lines.length <= 3), "ten samples, three lines at most");
await mustBeRefused(db, `select public.staff_about_set('koy-okulu-ogretmen', 'tr', 'k', 'w', '{}', null)`, "a guest writes nothing");
await asUser(db, BERK);
await mustBeRefused(db, `select public.staff_about_set('koy-okulu-ogretmen', 'tr', 'k', 'w', '{}', null)`, "nor a member", /admins/);
await asUser(db, ADA);
await db.exec(`select public.staff_about_set('koy-okulu-ogretmen', 'tr', 'van''da bir öğretmen derneği', 'on iki öğretmen.', array['2019'], null)`);
const tr = (await rpc(db, "about_for", { p_projects: ids, p_lang: "tr" })).find((a) => a.lang === "tr");
check(tr && tr.kicker.startsWith("van"), "the turkish about is preferred once it exists");
await db.exec(`select public.staff_samples_set('koy-okulu-ogretmen', 'tr', 'ay neden şekil değiştirir?', array['Ay değişmez.', 'Gördüğümüz kısım değişir.'])`);
await mustBeRefused(db, `select public.staff_samples_set('koy-okulu-ogretmen', 'de', 'x', array['1','2','3','4'])`, "four lines are too many");

console.log("\n— the panel's projects —");
const slug = (await one(db, `select public.staff_project_save('Sokak Hayvanları!', 'street animal registry', 'Reads shelter forms. Helps vets.', '1B Q4', 1, 6, 200, 'haytap', 'izmir') s`)).s;
check(slug === "sokak-hayvanlar", "the slug is made from the name (letters, digits, dashes; ı is not a letter here)");
check((await rpc(db, "staff_projects")).length === 11, "eleven projects now");
await asAnon(db);
check((await rpc(db, "deck")).length === 11, "and it is on the deck");
await asUser(db, ADA);
await db.exec(`select public.staff_project_delete('${slug}')`);
check((await rpc(db, "staff_projects")).length === 10, "deleted while it had no nights");
await db.exec(`select public.join_set('yerel-tarih-arsivi', 'right')`);
const k = (await one(db, `select public.contribution_start('yerel-tarih-arsivi', gen_random_uuid()) id`)).id;
await db.exec(`select public.contribution_end('${k}', 100, 10, 0)`);
await db.exec(`select public.staff_project_delete('yerel-tarih-arsivi')`);
const rows = await rpc(db, "staff_projects");
check(rows.length === 10 && rows.find((r) => r.slug === "yerel-tarih-arsivi").status === "done", "a project with nights is retired, not deleted");
check((await rpc(db, "my_cards")).length === 1, "the card stays");

finish();
