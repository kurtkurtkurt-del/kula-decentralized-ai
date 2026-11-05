// kula — what the night functions check before the database sees a report. Plain TypeScript,
// no Deno API, so backend/test/functions.test.mjs runs it on node as well. The database
// (18_night.sql) checks the same bounds again; this layer answers with a readable 400
// instead of a Postgres error, and drops anything that is not a number before it travels.

export const LIMITS = {
  units: 1_000_000,
  tokens: 1_000_000_000,
  seconds: 86_400,
  tps: 100_000,
  wh: 10_000,
  segments: 1000,
  devices: 64,
  daysBack: 7,
  bytes: 16_384,
} as const;

export type CleanReport = {
  id: string;
  slug: string;
  device_id: string;
  units: number;
  checked: number;
  wrong: number;
  tokens: number;
  seconds: number;
  segments: number;
  tps: number;
  wh: number;
  model: string | null;
  real: boolean;
  app_version: string | null;
  devices: { id: string; tokens: number; units: number; tps: number }[];
};
export type Checked = { ok: true; report: CleanReport } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SLUG = /^[a-z0-9-]{1,80}$/;
const num = (v: unknown, fallback = 0) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const int = (v: unknown, fallback = 0) => Math.round(num(v, fallback));
const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : null);

/** The days between two YYYY-MM-DD strings (b − a), in UTC. */
export const daysBetween = (a: string, b: string) => Math.round((Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10)) - Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10))) / 86_400_000);

/** Numbers and names only: the report the phone keeps, stripped to what the server stores.
 * Anything else in the object (a prompt, an answer, a sample) is left behind here. */
export function checkReport(raw: unknown, today = new Date().toISOString().slice(0, 10)): Checked {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "not a report" };
  const r = raw as Record<string, unknown>;
  if (JSON.stringify(raw).length > LIMITS.bytes) return { ok: false, error: "report too large" };
  const id = typeof r.id === "string" ? r.id : "";
  if (!DAY.test(id) || Number.isNaN(Date.parse(id))) return { ok: false, error: "night is not a date" };
  const back = daysBetween(id, today);
  if (back > LIMITS.daysBack || back < -1) return { ok: false, error: "night out of range" };
  const slug = typeof r.slug === "string" ? r.slug : "";
  if (!SLUG.test(slug)) return { ok: false, error: "slug missing" };
  const device_id = typeof r.device_id === "string" ? r.device_id : "";
  if (!UUID.test(device_id)) return { ok: false, error: "device id missing" };

  const units = int(r.units), checked = int(r.checked), wrong = int(r.wrong), tokens = int(r.tokens), seconds = int(r.seconds);
  const segments = Math.max(1, int(r.segments, 1));
  const rawDevices = Array.isArray(r.devices) ? r.devices : [];
  const devices = rawDevices.slice(0, LIMITS.devices).map((d) => {
    const o = (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
    return { id: str(o.id, 64) ?? "?", tokens: int(o.tokens), units: int(o.units), tps: num(o.tps) };
  });
  const tps = r.tps === undefined ? (seconds > 0 ? Math.round((tokens / seconds) * 10) / 10 : 0) : num(r.tps, -1);
  const wh = num(r.wh);
  if ([units, checked, wrong, tokens, seconds, tps, wh].some((x) => x < 0)) return { ok: false, error: "counts do not add up" };
  if (checked > units || wrong > checked) return { ok: false, error: "counts do not add up" };
  if (units > LIMITS.units || tokens > LIMITS.tokens || seconds > LIMITS.seconds || tps > LIMITS.tps || wh > LIMITS.wh) return { ok: false, error: "out of bounds" };
  if (seconds === 0 && tokens > 0) return { ok: false, error: "counts do not add up" };
  if (seconds > 0 && tps > (tokens / seconds) * 1.5 + 1) return { ok: false, error: "counts do not add up" };
  if (devices.length > 0 && devices.reduce((a, d) => a + d.tokens, 0) > tokens * 1.01 + 1) return { ok: false, error: "counts do not add up" };

  return {
    ok: true,
    report: {
      id, slug, device_id, units, checked, wrong, tokens, seconds,
      segments: Math.min(segments, LIMITS.segments), tps, wh,
      model: str(r.model, 120), real: r.real === true, app_version: str(r.app_version, 32),
      devices: devices.length ? devices : [{ id: "me", tokens, units, tps }],
    },
  };
}

/** The unit detail lines, if the phone sends any: idx, tokens, ms, ok. Nothing else. */
export function checkUnits(raw: unknown): { ok: true; units: { idx: number; tokens: number; ms: number; ok?: boolean }[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, units: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "not units" };
  if (raw.length > 2000) return { ok: false, error: "too many units" };
  const units = [];
  for (const u of raw) {
    const o = (u && typeof u === "object" ? u : {}) as Record<string, unknown>;
    const idx = int(o.idx, -1), tokens = int(o.tokens), ms = int(o.ms);
    if (idx < 0 || tokens < 0 || ms < 0 || tokens > LIMITS.units || ms > LIMITS.seconds * 1000) return { ok: false, error: "unit out of bounds" };
    units.push(typeof o.ok === "boolean" ? { idx, tokens, ms, ok: o.ok } : { idx, tokens, ms });
  }
  return { ok: true, units };
}

export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);
