/* kula — a backup of the content.
   What needs backing up is what cannot be made again: the projects, their abouts and
   their samples (entered by hand in the panel). The daily backup Supabase takes is a
   separate thing; this is your own copy, independent of the project. Taken with the
   public key, so it never carries a person.

     node tools/backup.mjs                       (the address in web/config.js)
     node tools/backup.mjs http://localhost:4350 (against another address)

   Output: backend/backup/kula-YYYY-MM-DD.json  */

import { readFile, writeFile, mkdir } from "node:fs/promises";

async function readConfig() {
  const text = await readFile(new URL("../../web/config.js", import.meta.url), "utf8");
  const box = {};
  new Function("window", text)(box);
  return box.KULA_CONFIG || {};
}

const config = await readConfig();
const address = (process.argv[2] || config.url || "").replace(/\/$/, "");
const key = process.argv[3] || config.anonKey || "local";
if (!address) {
  console.error("No address. Fill in web/config.js, or pass the address as an argument.");
  process.exit(1);
}

const call = async (fn, args = {}) => {
  const c = await fetch(`${address}/rest/v1/rpc/${fn}`, {
    method: "POST", headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json" }, body: JSON.stringify(args),
  });
  if (!c.ok) throw new Error(fn + " → " + c.status + " " + (await c.text()).slice(0, 120));
  return c.json();
};

const projects = await call("deck", { p_limit: 200 });
const ids = projects.map((p) => p.id);
const backup = {
  taken_at: new Date().toISOString(),
  source: address,
  projects,
  about: (await Promise.all(["en", "de", "tr"].map((l) => call("about_for", { p_projects: ids, p_lang: l })))).flat().filter((a, i, all) => all.findIndex((b) => b.project_id === a.project_id && b.lang === a.lang) === i),
  samples: (await Promise.all(["en", "de", "tr"].map((l) => call("samples_for", { p_projects: ids, p_lang: l })))).flat().filter((a, i, all) => all.findIndex((b) => b.project_id === a.project_id && b.lang === a.lang) === i),
};

const day = new Date().toISOString().slice(0, 10);
const folder = new URL("../backup/", import.meta.url);
await mkdir(folder, { recursive: true });
const file = new URL("kula-" + day + ".json", folder);
await writeFile(file, JSON.stringify(backup, null, 2));
console.log("backup taken: " + file.pathname);
for (const [name, list] of Object.entries(backup)) if (Array.isArray(list)) console.log(`  ${name.padEnd(10)} ${list.length}`);

/* An empty backup is a warning: the published data may be gone, or the key is wrong. */
if (!backup.projects.length) {
  console.error("\nWARNING: no projects came back. Is the address/key right?");
  process.exit(2);
}
