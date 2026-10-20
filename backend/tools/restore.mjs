/* pasaport — turns a backup into SQL that puts the content back.
   The projects, their abouts and samples, by slug: a row that already exists is left
   alone. It does NOT restore accounts, keeps, nights or messages: a backup taken with
   the public key never had them.

     node tools/restore.mjs backup/pasaport-2026-10-20.json
     → backup/restore-2026-10-20.sql, to paste in the SQL editor after setup.sql  */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const q = (v) => (v == null ? "null" : "'" + String(v).replace(/'/g, "''") + "'");
const n = (v) => (v == null ? "null" : Number(v));
const arr = (v) => "array[" + (v || []).map(q).join(", ") + "]::text[]";

export function restoreSql(backup) {
  let sql = `-- pasaport — restore from ${backup.source} taken ${backup.taken_at}\n`;
  sql += "\n-- projects ----------------------------------------------------\n";
  for (const p of backup.projects || []) {
    sql += `insert into public.projects (slug, title, summary, model, params_b, nights_wanted, phones_wanted, est_kwh, est_eur, org, city_id, poster_no, image_url, status)
select ${q(p.slug)}, ${q(p.title)}, ${q(p.summary)}, ${q(p.model)}, ${n(p.params_b)}, ${n(p.nights_wanted)}, ${n(p.phones_wanted)}, ${n(p.est_kwh)}, ${n(p.est_eur)}, ${q(p.org)},
       (select id from public.cities where slug = ${q(p.city_slug)}), ${n(p.poster_no)}, ${q(p.image_url)}, ${q(p.status)}
on conflict (slug) do nothing;\n`;
  }
  const slugOf = new Map((backup.projects || []).map((p) => [p.id, p.slug]));
  sql += "\n-- about -------------------------------------------------------\n";
  for (const a of backup.about || []) {
    sql += `insert into public.project_about (project_id, lang, kicker, who, facts, source_url)
select id, ${q(a.lang)}, ${q(a.kicker)}, ${q(a.who)}, ${arr(a.facts)}, ${q(a.source_url)} from public.projects where slug = ${q(slugOf.get(a.project_id))}
on conflict (project_id, lang) do nothing;\n`;
  }
  sql += "\n-- samples -----------------------------------------------------\n";
  for (const s of backup.samples || []) {
    sql += `insert into public.project_samples (project_id, lang, prompt, lines)
select id, ${q(s.lang)}, ${q(s.prompt)}, ${arr(s.lines)} from public.projects where slug = ${q(slugOf.get(s.project_id))}
on conflict (project_id, lang) do nothing;\n`;
  }
  return sql;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) {
    console.error("Which backup? e.g. node tools/restore.mjs backup/pasaport-2026-10-20.json");
    process.exit(1);
  }
  const from = resolve(process.cwd(), path);
  const backup = JSON.parse(await readFile(from, "utf8"));
  const out = from.replace(/pasaport-(.*)\.json$/, "restore-$1.sql");
  await writeFile(out, restoreSql(backup));
  console.log("restore written: " + out);
  for (const k of ["projects", "about", "samples"]) console.log(`  ${k.padEnd(10)} ${(backup[k] || []).length}`);
}
