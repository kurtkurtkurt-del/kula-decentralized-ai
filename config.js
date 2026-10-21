/* afterhours — backend configuration.
   These two fields get filled in once a Supabase project exists. While
   they are empty the site behaves exactly as it did before there was a
   backend: the data is read from events-data.js.

   The key below is the "anon" key. It is public on purpose and is not a
   secret. What protects the data is the row-level rules in the database
   (backend/sql/02_rls.sql), not the obscurity of this string. The
   "service_role" key is NEVER written here.  */

window.AH_CONFIG = {
  /* kula's own project since 21.10.2026 (the site came with afterhours' — never again) */
  url: "https://eshgfeasffxryrijwksp.supabase.co",
  anonKey: "sb_publishable_eSYlpNsoLWyijpzcN1KEkg_hHia0yF0",
  city: "munchen",
  /* Where the app lives. The Android listing is the closed test for now;
     the iOS entry arrives with the App Store. The scheme opens a night in
     the app from its web page: afterhours://night/<slug>. */
  app: {
    android: "https://play.google.com/store/apps/details?id=app.afterhours.android",
    ios: null,
    scheme: "afterhours://",
  },
};
