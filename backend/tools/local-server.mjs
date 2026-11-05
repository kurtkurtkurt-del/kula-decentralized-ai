/* kula — A LOCAL DEVELOPMENT SERVER. NOT Supabase.
   It imitates the endpoints we use (a small subset of PostgREST and
   GoTrue) on top of PGlite. It exists for one reason: to run and test the
   live path for real before the project is opened.

   Authentication is FAKE: the token is the user id. Never used in
   production, never exposed to the internet.

     node tools/local-server.mjs          → http://localhost:4350
*/

import { PGlite } from "@electric-sql/pglite";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const PORT = Number(process.env.PORT || 4350);
const read = (y) => readFile(new URL(y, import.meta.url), "utf8");

const db = new PGlite();
const { EXPECTED_SQL } = await import("./expected-sql.mjs");
for (const d of ["../test/supabase-shim.sql", ...EXPECTED_SQL.map((f) => "../sql/" + f)]) {
  await db.exec(await read(d));
}
console.log("database ready (in memory)");

/* An imitation store: the files live in memory and go when the server
   stops. It stands in for Supabase Storage only to exercise the flow. */
const store = new Map();

/* --- who made the request ------------------------------------------- */

/* On real Supabase this is a JWT. Here it is the plain user id, carrying
   a "local-" prefix so it is obvious that it is fake. */
function userFromToken(bas) {
  const role = bas.authorization || "";
  const m = role.match(/^Bearer\s+local-(.+)$/);
  return m ? m[1] : null;
}

async function setRole(user) {
  if (user) {
    await db.exec(`set role authenticated;
                   set request.jwt.claims = '{"sub":"${user}"}';`);
  } else {
    await db.exec(`set role anon; set request.jwt.claims = '';`);
  }
}
const dropRole = () => db.exec(`reset role; set request.jwt.claims = '';`);

/* Function argument name → type. Read once and kept. */
const typeCache = new Map();
async function argumentTypes(fn) {
  if (typeCache.has(fn)) return typeCache.get(fn);
  const r = await db.query(
    `select p.proargnames as names,
            array(select t::regtype::text from unnest(p.proargtypes) as t) as types
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = $1 limit 1`, [fn]);
  const match = {};
  /* .adlar/.tipler survived the English migration here — the SQL says
     "as names/as types", so the map came back empty and every argument
     fell to ::text. Nothing noticed until deck() gained an int argument. */
  if (r.rows.length && r.rows[0].names) {
    const names = r.rows[0].names, types = r.rows[0].types;
    names.forEach((a, i) => { if (a && types[i]) match[a] = types[i]; });
  }
  typeCache.set(fn, match);
  return match;
}

/* --- a small subset of the PostgREST filters ------------------------- */

/* ?event_id=eq.<uuid>&order=created_at.desc&limit=60 */
function translateFilters(search, counter) {
  const conditions = [];
  const params = [];
  let orderBy = "";
  let limit = "";

  for (const [field, value] of search) {
    if (field === "select" || field === "apikey") continue;
    if (field === "order") {
      const [k, y] = value.split(".");
      orderBy = ` order by ${k.replace(/[^a-z_]/gi, "")} ${/desc/i.test(y) ? "desc" : "asc"}`;
      continue;
    }
    if (field === "limit") { limit = ` limit ${Number(value) || 50}`; continue; }

    const [op, ...rest] = value.split(".");
    const v = rest.join(".");
    const column = field.replace(/[^a-z_0-9]/gi, "");

    /* is.null and in.(a,b) — beforehours fetches topics and their replies
       with these. Skipping a filter we do not know would silently return
       the WHOLE table, which is the worst possible answer; refuse the row
       set instead when the list is empty. */
    if (op === "is" && v === "null") {
      conditions.push(`${column} is null`);
      continue;
    }
    if (op === "in") {
      const list = v.replace(/^\(/, "").replace(/\)$/, "").split(",").filter(Boolean);
      if (!list.length) { conditions.push("false"); continue; }
      const slots = list.map((x) => { params.push(x); return "$" + counter.n++; });
      conditions.push(`${column} in (${slots.join(", ")})`);
      continue;
    }

    const operator = { eq: "=", neq: "<>", gt: ">", lt: "<", gte: ">=", lte: "<=" }[op];
    if (!operator) continue;
    params.push(v);
    conditions.push(`${column} ${operator} $${counter.n++}`);
  }
  return {
    where: conditions.length ? " where " + conditions.join(" and ") : "",
    orderBy, limit, params,
  };
}

const readBody = (req) =>
  new Promise((tamam) => {
    let v = "";
    req.on("data", (p) => (v += p));
    req.on("end", () => { try { tamam(v ? JSON.parse(v) : null); } catch (_) { tamam(null); } });
  });

/* --- server --------------------------------------------------------- */

const server = createServer(async (req, reply) => {
  const url = new URL(req.url, "http://localhost");
  const path = url.pathname;

  reply.setHeader("Access-Control-Allow-Origin", "*");
  reply.setHeader("Access-Control-Allow-Headers", "authorization, apikey, content-type, content-profile, accept-profile, prefer, x-upsert, range, x-client-info, x-supabase-api-version");
  reply.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") { reply.writeHead(204); return reply.end(); }

  const send = (code, data) => {
    reply.writeHead(code, { "Content-Type": "application/json" });
    reply.end(data === undefined ? "" : JSON.stringify(data));
  };

  const user = userFromToken(req.headers);
  const body = ["POST", "PATCH", "PUT"].includes(req.method) ? await readBody(req) : null;

  try {
    /* ---------- imitating GoTrue ---------- */

    if (path === "/auth/v1/otp") {
      const email = (body && body.email || "").toLowerCase();
      if (!email) return send(400, { msg: "email required" });
      await dropRole();
      let k = await db.query(`select id from auth.users where email = $1`, [email]);
      if (!k.rows.length) {
        k = await db.query(`insert into auth.users (email) values ($1) returning id`, [email]);
      }
      const id = k.rows[0].id;

      /* A convenience for development: make the first user an admin. In a
         real setup that is a one-line update in the SQL editor. */
      const admins = await db.query(`select count(*)::int as n from public.profiles where is_admin`);
      if (admins.rows[0].n === 0) {
        await db.query(`update public.profiles set is_admin = true where id = $1`, [id]);
        console.log("  ★ " + email + " made an admin (locally only)");
      }

      const back = (body.options && body.options.email_redirect_to) || "http://localhost:4340/";
      console.log("\n  ✉  sign-in link (" + email + "):");
      console.log("     " + back + "#access_token=local-" + id +
                  "&refresh_token=local-" + id + "&expires_in=3600\n");
      return send(200, {});
    }

    /* Opening an account. Real Supabase may ask for email confirmation
       here; the imitation does not, it hands back a token at once. */
    if (path === "/auth/v1/signup") {
      const email = ((body && body.email) || "").toLowerCase();
      if (!email) return send(400, { msg: "email required" });
      await dropRole();
      const exists = await db.query(`select id from auth.users where email = $1`, [email]);
      if (exists.rows.length) {
        return send(400, { msg: "User already registered" });
      }
      const extra = (body && body.data) || {};
      const k = await db.query(
        `insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`,
        [email, JSON.stringify(extra)]);
      const id = k.rows[0].id;

      const admins = await db.query(`select count(*)::int as n from public.profiles where is_admin`);
      if (admins.rows[0].n === 0) {
        await db.query(`update public.profiles set is_admin = true where id = $1`, [id]);
        console.log("  ★ " + email + " made an admin (locally only)");
      }

      console.log("  ✚ account opened: " + email);
      return send(200, {
        access_token: "local-" + id, refresh_token: "local-" + id, expires_in: 3600,
        user: { id, email: email },
      });
    }

    if (path === "/auth/v1/token") {
      const kind = url.searchParams.get("grant_type") || "refresh_token";

      /* Signing in with a password. NOTE: the password is NOT CHECKED
         here — this is an imitation server, only for exercising the flow.
         Real Supabase does verify it. Never exposed to the internet. */
      if (kind === "password") {
        const email = ((body && body.email) || "").toLowerCase();
        if (!email) return send(400, { msg: "email required" });
        await dropRole();
        let k = await db.query(`select id from auth.users where email = $1`, [email]);
        if (!k.rows.length) {
          return send(400, { error_description: "Invalid login credentials" });
        }
        const id = k.rows[0].id;
        console.log("  🔑 password sign-in: " + email + " (password not checked - imitation)");
        return send(200, {
          access_token: "local-" + id, refresh_token: "local-" + id, expires_in: 3600,
          user: { id, email: email },
        });
      }

      const id = (body && body.refresh_token || "").replace(/^local-/, "");
      if (!id) return send(400, { msg: "refresh_token required" });
      /* The database lives in memory: after a restart the phone's saved session points at a
         user that is gone. Say so (the app signs out) instead of answering without a user,
         which left session.user undefined and crashed the app on is_anonymous. */
      await dropRole();
      const u = await db.query(`select id, email from auth.users where id::text = $1`, [id]);
      if (!u.rows.length) return send(400, { error: "invalid_grant", error_description: "Refresh Token Not Found" });
      return send(200, { access_token: "local-" + id, refresh_token: "local-" + id, expires_in: 3600, token_type: "bearer",
        user: { id: u.rows[0].id, email: u.rows[0].email, is_anonymous: false } });
    }

    if (path === "/auth/v1/user") {
      if (!user) return send(401, { msg: "no token" });
      await dropRole();
      const r = await db.query(`select id, email from auth.users where id = $1`, [user]);
      /* A token for a user the in-memory database no longer has (the server restarted):
         answer as Supabase does, so the app signs out instead of reading a null user. */
      if (!r.rows.length) return send(403, { code: 403, error_code: "user_not_found", msg: "User from sub claim in JWT does not exist" });
      return send(200, { ...r.rows[0], is_anonymous: false });
    }

    if (path === "/auth/v1/logout") return send(204);

    /* ---------- imitating Storage (in memory) ---------- */

    if (path.startsWith("/storage/v1/object/")) {
      /* Upload: /storage/v1/object/posters/<name> */
      if (req.method === "POST" || req.method === "PUT") {
        if (!user) return send(401, { message: "no token" });
        await setRole(user);
        const y = await db.query(`select public.is_admin() as y`);
        await dropRole();
        if (!y.rows[0].y) return send(403, { message: "only an admin may upload" });

        const name = path.split("/").slice(5).join("/");
        const parts = [];
        for await (const p of req) parts.push(p);
        store.set(name, Buffer.concat(parts));
        console.log("  ⇧ poster yuklendi: " + name + " (" + store.get(name).length + " bayt)");
        return send(200, { Key: "posters/" + name });
      }

      /* Read: /storage/v1/object/public/posters/<name> */
      if (req.method === "GET") {
        const name = path.replace("/storage/v1/object/public/posters/", "");
        const data = store.get(name);
        if (!data) return send(404, { message: "not found" });
        reply.writeHead(200, { "Content-Type": "image/svg+xml" });
        return reply.end(data);
      }
    }

    /* ---------- imitating PostgREST ---------- */

    if (path.startsWith("/rest/v1/")) {
      const name = path.slice("/rest/v1/".length);
      await setRole(user);

      /* a function call */
      if (name.startsWith("rpc/")) {
        const fn = name.slice(4).replace(/[^a-z_0-9]/gi, "");
        const keys = Object.keys(body || {});
        const types = await argumentTypes(fn);
        /* With no type given, Postgres treats the argument as "unknown"
           and cannot find the function; we read the signature from the
           catalogue and cast every argument. */
        const args = keys
          .map((k, i) => `${k} => $${i + 1}::${types[k] || "text"}`)
          .join(", ");
        const r = await db.query(`select * from public.${fn}(${args})`,
                                 keys.map((k) => body[k]));
        /* For a function returning a scalar, PostgREST hands back the bare
           value rather than wrapping it in a row. Same behaviour here. */
        const scalar = r.rows.length === 1 && r.fields && r.fields.length === 1
          && r.fields[0].name === fn;
        return send(200, scalar ? r.rows[0][fn] : r.rows);
      }

      const table = name.split("?")[0].replace(/[^a-z_0-9]/gi, "");
      const counter = { n: 1 };
      const { where, orderBy, limit, params } = translateFilters(url.searchParams, counter);
      const prefer = String(req.headers.prefer || "");

      if (req.method === "GET") {
        const r = await db.query(
          `select * from public.${table}${where}${orderBy}${limit}`, params);
        return send(200, r.rows);
      }

      if (req.method === "POST") {
        const rows = Array.isArray(body) ? body : [body];
        if (!rows.length || !rows[0]) return send(400, { message: "body empty" });
        const columns = Object.keys(rows[0]);
        const values = [];
        const parts = rows.map((s) => {
          const slots = columns.map((k) => { values.push(s[k]); return `$${values.length}`; });
          return `(${slots.join(", ")})`;
        });
        const conflict = /merge-duplicates/.test(prefer)
          ? ` on conflict (user_id, event_id) do update set direction = excluded.direction,
              created_at = now()`
          : "";
        const back = /return=minimal/.test(prefer) ? "" : " returning *";
        const r = await db.query(
          `insert into public.${table} (${columns.join(", ")}) values ${parts.join(", ")}${conflict}${back}`,
          values);
        return back ? send(201, r.rows) : send(201);
      }

      if (req.method === "PATCH") {
        /* The SET values take $1..$n, so the filters have to start AFTER
           them. Since the filters are numbered from $1 above, we work them
           out again here with a shifted counter. */
        const columns = Object.keys(body || {});
        const shifted = { n: columns.length + 1 };
        const f = translateFilters(url.searchParams, shifted);
        const assignments = columns.map((k, i) => `${k} = $${i + 1}`);
        const r = await db.query(
          `update public.${table} set ${assignments.join(", ")}${f.where} returning *`,
          [...columns.map((k) => body[k]), ...f.params]);
        return send(200, r.rows);
      }

      if (req.method === "DELETE") {
        await db.query(`delete from public.${table}${where}`, params);
        return send(204);
      }
    }

    send(404, { message: "unknown endpoint: " + path });
  } catch (e) {
    console.error("  ✗ " + req.method + " " + path + " → " + e.message);
    send(400, { message: e.message });
  } finally {
    await dropRole().catch(() => {});
  }
});

server.listen(PORT, () => {
  console.log(`\nLOCAL imitation server: http://localhost:${PORT}`);
  console.log("This is NOT Supabase; for development only.\n");
  console.log("for web/config.js (or app/.env.development.local):");
  console.log(`  url: "http://localhost:${PORT}", anonKey: "local"\n`);
});
