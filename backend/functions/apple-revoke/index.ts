// kula — apple-revoke (Supabase Edge Function)
//
// App Store 5.1.1(v): when an account made with Sign in with Apple is deleted, the
// app revokes its Apple tokens. The app gets a fresh authorization code from Apple
// and sends it here; this function trades it for a refresh token and revokes that.
// The private key never leaves the server.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   APPLE_TEAM_ID      the 10-character team id
//   APPLE_KEY_ID       the id of a key with "Sign in with Apple" enabled
//   APPLE_PRIVATE_KEY  the .p8 file's contents, BEGIN/END lines included
//   APPLE_CLIENT_ID    the bundle id: app.pasaport.ios
//
// Only a signed-in caller gets through (verify_jwt, the default).

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const json = (o: unknown) => b64url(enc.encode(JSON.stringify(o)));

async function clientSecret(): Promise<string> {
  const team = Deno.env.get("APPLE_TEAM_ID")!, kid = Deno.env.get("APPLE_KEY_ID")!, client = Deno.env.get("APPLE_CLIENT_ID")!;
  const pem = Deno.env.get("APPLE_PRIVATE_KEY")!.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const now = Math.floor(Date.now() / 1000);
  const head = json({ alg: "ES256", kid });
  const body = json({ iss: team, iat: now, exp: now + 300, aud: "https://appleid.apple.com", sub: client });
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

async function apple(path: string, form: Record<string, string>) {
  return fetch(`https://appleid.apple.com/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("post only", { status: 405 });
  const missing = ["APPLE_TEAM_ID", "APPLE_KEY_ID", "APPLE_PRIVATE_KEY", "APPLE_CLIENT_ID"].filter((k) => !Deno.env.get(k));
  if (missing.length) return Response.json({ error: "not set up: " + missing.join(", ") }, { status: 500 });
  const { code } = await req.json().catch(() => ({ code: null }));
  if (!code || typeof code !== "string") return Response.json({ error: "no code" }, { status: 400 });

  const client_id = Deno.env.get("APPLE_CLIENT_ID")!;
  const client_secret = await clientSecret();
  const tokenRes = await apple("token", { client_id, client_secret, code, grant_type: "authorization_code" });
  const token = await tokenRes.json().catch(() => ({}));
  const refresh = token.refresh_token ?? token.access_token;
  if (!refresh) return Response.json({ error: "apple: " + (token.error ?? tokenRes.status) }, { status: 502 });

  const revoke = await apple("revoke", {
    client_id, client_secret, token: refresh,
    token_type_hint: token.refresh_token ? "refresh_token" : "access_token",
  });
  if (!revoke.ok) return Response.json({ error: "apple revoke: " + revoke.status }, { status: 502 });
  return Response.json({ ok: true });
});
