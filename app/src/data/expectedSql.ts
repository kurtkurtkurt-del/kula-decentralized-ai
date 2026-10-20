// The numbered SQL files this app needs on the live database, in order. A copy of
// backend/tools/expected-sql.mjs (backend/test/setup.test.mjs checks they match), so
// the panel can say which file was never pasted instead of a page failing quietly.
export const EXPECTED_SQL = [
  '00_migrations.sql',
  '01_schema.sql',
  '02_doors.sql',
  '03_seed_projects.sql',
  '04_profiles.sql',
  '05_friends.sql',
  '06_deck.sql',
  '07_passports.sql',
  '08_contributions.sql',
  '09_coops.sql',
  '10_calls.sql',
  '11_dms.sql',
  '12_about.sql',
  '13_push.sql',
  '14_safety.sql',
  '15_health.sql',
] as const;
