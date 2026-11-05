// kula — night-report (Supabase Edge Function)
//
// The phone posts its morning report here (or calls the rpc night_report directly: the
// app does that; this function is the same door for a client that is not the app, and
// the place where a report is read for shape before Postgres sees it). Numbers only
// come in; prompts, answers and samples are never part of the body and would be dropped
// by checkReport if they were.
//
//   POST { report: NightReport, client_id: uuid, units?: [{idx, tokens, ms, ok?}] }
//   → 200 { id }         the report's row (the same id for a retry or the same night again)
//   → 400 { error }      the shape or the bounds (_shared/night.ts)
//   → 401               no signed-in caller (verify_jwt, the default)
//
// Secrets: none beyond SUPABASE_URL and SUPABASE_ANON_KEY, which Supabase sets. The
// caller's own token travels on to Postgres, so RLS and assert_member() decide as usual.

import { createClient } from "npm:@supabase/supabase-js@2";
import { checkReport, checkUnits, isUuid } from "../_shared/night.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("post only", { status: 405 });
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return Response.json({ error: "signed out" }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return Response.json({ error: "not json" }, { status: 400 });
  const { report, client_id, units } = body as { report?: unknown; client_id?: unknown; units?: unknown };
  if (!isUuid(client_id)) return Response.json({ error: "client id missing" }, { status: 400 });
  const checked = checkReport(report);
  if (!checked.ok) return Response.json({ error: checked.error }, { status: 400 });
  const detail = checkUnits(units);
  if (!detail.ok) return Response.json({ error: detail.error }, { status: 400 });

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
  const r = await db.rpc("night_report", { p_report: checked.report, p_client_id: client_id });
  if (r.error) {
    const m = r.error.message ?? "refused";
    return Response.json({ error: m }, { status: /permission|member/i.test(m) ? 401 : 400 });
  }
  if (detail.units.length) {
    const u = await db.rpc("night_units_add", { p_report_id: r.data, p_units: detail.units });
    if (u.error) return Response.json({ id: r.data, units: 0, warning: u.error.message });
    return Response.json({ id: r.data, units: u.data });
  }
  return Response.json({ id: r.data });
});
