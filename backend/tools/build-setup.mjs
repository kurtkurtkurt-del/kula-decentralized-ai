/* kula — joins the numbered SQL files into one pasteable file.
   Instead of opening each file in the Supabase panel one by one, one press of Run is enough.

     node tools/build-setup.mjs                                        */

import { readFile, writeFile } from "node:fs/promises";

const read = (d) => readFile(new URL("../sql/" + d, import.meta.url), "utf8");

const structure = [
  ["00_migrations.sql", "THE MIGRATION LOG — which files have been run"],
  ["01_schema.sql", "TABLES — cities, projects, people, joins, friendships, contributions, credits, passports"],
  ["02_doors.sql", "THE DOOR — who is asking, who may be seen; bans and blocks"],
  ["03_seed_projects.sql", "TEN PROJECTS — türkiye and germany"],
  ["04_profiles.sql", "PEOPLE — the card, the settings, the search, leaving"],
  ["05_friends.sql", "FRIENDSHIP"],
  ["06_deck.sql", "THE DECK — keep, let go, the project page"],
  ["07_passports.sql", "THE DEVICE PASSPORT — and the network clusters"],
  ["08_contributions.sql", "THE NIGHT — check-in, the card, the credits"],
  ["09_coops.sql", "COOPS — friends who work a night together"],
  ["10_calls.sql", "CALLS — a project night that travels in waves"],
  ["11_dms.sql", "DIRECT MESSAGES"],
  ["12_about.sql", "ABOUT A PROJECT — who runs it, what the model says; the panel's projects"],
  ["13_push.sql", "PUSH — a sentence and a name, never the words"],
  ["14_safety.sql", "WHAT THE STORES REQUIRE — terms, reports, errors, the floor, feedback, pruning"],
  ["15_health.sql", "HEALTH"],
  ["16_devices.sql", "DEVICES — the catalog of every device model, the network's night estimated"],
  ["17_passport_drops.sql", "THE HANDOVER — a passport dropped under a connect id, picked up once by the phone"],
];

/* A visible version stamp goes at the top of the file, so one look at the
   editor tells you which copy is sitting there. The clipboard has proven
   unreliable. */
const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");

let one = `-- ============================================================
--  pasaport — SETUP : THE WHOLE DATABASE
--  VERSION: ${stamp}   ← if the editor shows this line, it is the right copy
--
--  In the Supabase panel: SQL Editor → New query → paste this file
--  IN FULL → Run.
--
--  When it finishes you should see "Success. No rows returned".
--
--  GENERATED FILE — source: backend/tools/build-setup.mjs
-- ============================================================
`;

for (const [file, heading] of structure) {
  one += `\n\n-- ============================================================\n`;
  one += `--  ${heading}   (${file})\n`;
  one += `-- ============================================================\n\n`;
  one += await read(file);
}

await writeFile(new URL("../sql/setup.sql", import.meta.url), one);

console.log("setup.sql  " + Buffer.byteLength(one).toLocaleString() + " bytes");
