/* kula — the live server's public address, in one place.
   Read by tools/passport-mac.py (the relay web/passport/mac.sh sends a Mac's passport to) and by
   backend/tools/health.mjs and backup.mjs (the daily checks in .github/workflows/).

   The key is the "anon" (publishable) key. It is public on purpose: what protects the data is
   the row-level rules in backend/sql/, not this string. The "service_role" key is NEVER written
   here. kula's own Supabase project since 21.10.2026; never afterhours' (see CLAUDE.md). */

window.KULA_CONFIG = {
  url: "https://eshgfeasffxryrijwksp.supabase.co",
  anonKey: "sb_publishable_eSYlpNsoLWyijpzcN1KEkg_hHia0yF0",
};
