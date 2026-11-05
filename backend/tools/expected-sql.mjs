/* kula — the files a finished database has run, in order. Three things ask the same
   question: the health check, the setup build, the tests (test/lib.mjs builds up to the
   file under test). app/src/data/expectedSql.ts is a copy (setup.test.mjs checks). */
export const EXPECTED_SQL = [
  "00_migrations.sql",
  "01_schema.sql",
  "02_doors.sql",
  "03_seed_projects.sql",
  "04_profiles.sql",
  "05_friends.sql",
  "06_deck.sql",
  "07_passports.sql",
  "08_contributions.sql",
  "09_coops.sql",
  "10_calls.sql",
  "11_dms.sql",
  "12_about.sql",
  "13_push.sql",
  "14_safety.sql",
  "15_health.sql",
  "16_devices.sql",
  "17_passport_drops.sql",
  "18_night.sql",
];
