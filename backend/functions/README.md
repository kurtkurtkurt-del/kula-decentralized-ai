# Edge Functions

## apple-revoke

App Store rule 5.1.1(v): deleting an account made with Sign in with Apple must revoke
its Apple tokens. On delete the app asks Apple once more (Face ID) for an authorization
code and posts it here; the function trades it for a token and revokes it. Without the
function the account is still deleted; the failure lands in `client_errors`.

Deploy once, in the Supabase dashboard:

1. **Apple key.** developer.apple.com → Certificates, IDs & Profiles → Keys → + →
   name it, tick *Sign in with Apple*, Configure → primary App ID `app.pasaport.ios`
   → Continue → Register → **Download** the `.p8` (only once). Note the **Key ID**
   and the **Team ID** (top right of the developer page).
2. **Function.** Supabase → Edge Functions → Deploy a new function → *Via editor* →
   name `apple-revoke` → paste `apple-revoke/index.ts` → Deploy. Leave *Verify JWT* on.
3. **Secrets.** Edge Functions → Secrets → add
   `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_CLIENT_ID` = `app.pasaport.ios`,
   `APPLE_PRIVATE_KEY` = the whole `.p8` file, BEGIN and END lines included.

Or with the CLI: `supabase functions deploy apple-revoke` from a folder whose
`supabase/functions/apple-revoke/index.ts` is this file, and `supabase secrets set …`.

## night-report · project-summary

The morning report (`app/src/night/report.ts`) on the server, numbers only. The app itself
calls the rpcs `night_report` / `night_mine_summary` (18_night.sql) through its outbox; these
two functions are the same doors over HTTP for a client that is not the app, with the
shape checked in TypeScript first (`_shared/night.ts`, tested on node by
`test/functions.test.mjs`). What they do and what they answer is at the top of each file.

Deploy: Supabase → Edge Functions → Deploy → paste `night-report/index.ts` and
`project-summary/index.ts` (each with `_shared/night.ts` beside it), *Verify JWT* on. No
secrets: `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set by Supabase and the caller's own
token travels on to Postgres. Or with the CLI: `supabase functions deploy night-report` and
`supabase functions deploy project-summary` from a folder whose `supabase/functions/` holds
these three files (`tools/supabase-reset.sh` lays that folder out).
