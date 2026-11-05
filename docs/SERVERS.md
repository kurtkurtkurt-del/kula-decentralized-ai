# servers: demo and live

Which server a build of the app talks to, and how to set the live one up. Moved here from the old README on 5.11.2026; the wording is as it was.

## Demo builds (no server)

Today (21.10.2026: "no Supabase for now, just random examples") `app/.env.production` is empty,
so a release apk is a **demo**: `src/lib/supabase.ts` swaps the Supabase client for
`src/demo/client.ts`, and `src/demo/server.ts` answers every call from an invented example world
(`src/demo/snapshot.json`: 14 people with their phones, friendships, kept projects, nights,
messages, coops, calls, the network). The demo user (deniz) is signed in; what they do — keep,
write, measure, finish a night, start a coop or call — stays on the phone. Settings → app →
server says "demo". To remake the world (other names, more people): start a fresh local server
and run `node tools/demo-snapshot.mjs [seed]` in `app/`. `EXPO_PUBLIC_DEMO=1` in
`app/.env.development.local` runs the demo in Expo Go or the browser.

## A live server

Two servers, chosen by the env files in `app/` (`app/.env` explains the order):

- **Development** (`expo start`, Expo Go): the Mac's local server, `backend/tools/local-server.mjs`
  (PGlite in memory, imitation auth), from `app/.env.development.local` (not in git).
- **A release apk** (`npm run apk`): kula's **own** Supabase project, from `app/.env.production`.
  Never afterhours' project; `npm run release:check` refuses it, an empty address, the Mac's
  address and plain http, and `npm run apk` runs that check first. A build that slipped
  through anyway shows "this build has no live server" instead of looking offline forever
  (`src/lib/backend.ts`).

To make the apk live (once):

1. Create a new Supabase project for kula (supabase.com; region EU).
2. Run the schema: paste `backend/sql/setup.sql` into the SQL editor and run it, or
   `SUPABASE_DB_URL=<session connection string> node backend/tools/migrate.mjs --write`.
3. Authentication → URL Configuration → Redirect URLs: `pasaport://auth-callback` (and
   `exp://**` for Expo Go). The confirmation and password emails come back to that address.
4. Settings → API: put the Project URL and the publishable key into `app/.env.production`.
5. `cd app && npm run release:check` (✓), then `npm run apk` → `dist/kula-decentralized-ai-<version>.apk`.

Known gap: a password-reset link signs the user in, but the app has no "choose a new password"
screen yet.

