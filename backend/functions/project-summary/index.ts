// kula — project-summary (Supabase Edge Function)
//
// A project's owner (projects.owner_id) or an admin reads what the nights added up to,
// per month: nights, phones, people, units, checked, wrong, tokens, seconds, wh. Counts
// only; the rpc project_summary refuses anyone else. Beside it, for the caller themselves,
// night_mine_summary: "this project, this month: X nights" (what the app's cards show).
//
//   GET  ?slug=koy-okulu-ogretmen         → 200 { slug, months: [...] }     owner or admin
//   GET  ?mine=1[&device_id=uuid]         → 200 { projects: [...] }         the caller's own
//   → 400 { error } no slug · 401 signed out · 403 not the owner

import { createClient } from "npm:@supabase/supabase-js@2";
import { isUuid } from "../_shared/night.ts";

Deno.serve(async (req) => {
  if (req.method !== "GET") return new Response("get only", { status: 405 });
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return Response.json({ error: "signed out" }, { status: 401 });
  const url = new URL(req.url);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });

  if (url.searchParams.get("mine")) {
    const device = url.searchParams.get("device_id");
    const r = await db.rpc("night_mine_summary", { p_device_id: isUuid(device) ? device : null });
    if (r.error) return Response.json({ error: r.error.message }, { status: 401 });
    return Response.json({ projects: r.data ?? [] });
  }
  const slug = url.searchParams.get("slug") ?? "";
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) return Response.json({ error: "slug missing" }, { status: 400 });
  const r = await db.rpc("project_summary", { p_slug: slug });
  if (r.error) {
    const m = r.error.message ?? "refused";
    return Response.json({ error: m }, { status: /owner/i.test(m) ? 403 : /permission|member/i.test(m) ? 401 : 400 });
  }
  return Response.json({ slug, months: r.data ?? [] });
});
