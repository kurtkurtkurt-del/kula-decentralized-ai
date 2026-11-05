# kula — backend

kula's Supabase project: the schema and its row-level rules, two edge functions, a local
server that imitates Supabase for development, and the tests that run all of it on PGlite.
The app works without it: a build with no server answers from a demo world on the phone
([docs/SERVERS.md](../docs/SERVERS.md)), and models, chat and the cluster never touch it.

## the files

| path | what |
|---|---|
| `sql/00_migrations.sql` … `sql/18_night.sql` | the database, in order: accounts and profiles, friends, projects and keeping them, passports, the night's contributions, coops, calls, messages, push, the store rules, health, devices, passport drops, night reports |
| `sql/setup.sql` | all of them joined, to paste into the SQL editor once (`npm run setup` rebuilds it) |
| `functions/` | edge functions: `night-report`, `project-summary` ([docs/BACKEND.md](../docs/BACKEND.md)) and `apple-revoke` ([functions/README.md](functions/README.md)) |
| `test/` | one PGlite test per SQL file, `supabase-shim.sql` for what Supabase provides |
| `tools/local-server.mjs` | `npm run server`: http://localhost:4350, the endpoints the app calls, for development only |
| `tools/stamp-sql.mjs`, `sql-hashes.json` | every numbered file carries the hash of its own text; `--check` fails when one changed without a restamp |
| `tools/migrate.mjs` | applies the numbered files the live database has not run yet |
| `tools/health.mjs`, `backup.mjs`, `restore.mjs` | the live database's state, a copy of its public content, and that copy back as SQL; they read the address from [web/config.js](../web/config.js) |
| `tools/gate.mjs` | `npm run gate`: every check that runs without a device, then `.qa/gate-proof.json` for the pre-push hook |

The SQL files' header lines still say *pasaport*, the name the project had for a day
(20.10.2026); they are stamped, so they change only with a reason and a restamp.

## day to day

```bash
npm install        # also points git at .githooks/ (the pre-push gate)
npm test           # every SQL file on PGlite
npm run server     # the local imitation server
npm run setup      # rebuild sql/setup.sql after a numbered file changed
npm run stamp      # restamp after a deliberate change
npm run gate       # the whole gate, before a push to main
npm run health     # the live database
SUPABASE_DB_URL=… npm run migrate   # what the live database has not run (dry; -- --write applies)
```

Setting up the live project, once, and which build talks to which server:
[docs/SERVERS.md](../docs/SERVERS.md). The night reports, their privacy rule (numbers only)
and the planned ledger heads for beyin: [docs/BACKEND.md](../docs/BACKEND.md).

Until 5.11.2026 this file was afterhours' backend guide (events, venues, the Ticketmaster
sync, the admin panel); it is in git history (`git show 9d5919f:backend/README.md`).
