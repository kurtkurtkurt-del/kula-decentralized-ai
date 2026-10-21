#!/usr/bin/env node
// Makes the example world a build without a server runs on (src/demo, 21.10.2026: "no
// Supabase for now, just random examples"). It plays a whole little network against a
// FRESH local server (backend/tools/local-server.mjs, port 4350) — invented people with
// invented phones, friendships, kept projects, finished nights, people working right now,
// messages, coops, calls — then asks every question the app asks, as the demo user, and
// writes the answers to src/demo/snapshot.json. src/demo/server.ts answers from that file
// on the phone and keeps what the user does there.
//
//   node backend/tools/local-server.mjs      (fresh: the database lives in memory)
//   node tools/demo-snapshot.mjs [seed]      → src/demo/snapshot.json
//
// Every name, phone and number here is invented. Same seed, same world.
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const S = process.env.LOCAL_SERVER ?? "http://localhost:4350";
let seed = Number(process.argv[2] ?? 2110);
const rnd = () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const shuffle = (a) => a.map((x) => [rnd(), x]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
const between = (lo, hi, d = 1) => Math.round((lo + rnd() * (hi - lo)) * 10 ** d) / 10 ** d;
const H = { "content-type": "application/json", apikey: "local" };

async function signup(handle) {
  const r = await fetch(`${S}/auth/v1/signup`, { method: "POST", headers: H, body: JSON.stringify({ email: `${handle}@demo.kula`, password: "demo-1234" }) });
  const j = await r.json();
  if (!j.access_token) throw new Error(`signup ${handle}: ${JSON.stringify(j)}`);
  return { token: j.access_token, id: j.user.id };
}
async function rpc(who, name, args = {}, soft = false) {
  const r = await fetch(`${S}/rest/v1/rpc/${name}`, { method: "POST", headers: { ...H, ...(who ? { authorization: `Bearer ${who.token}` } : {}) }, body: JSON.stringify(args) });
  const text = await r.text();
  const body = text ? JSON.parse(text) : null;
  if (!r.ok) {
    if (soft) return null;
    throw new Error(`${name}: ${text}`);
  }
  return body;
}

// ---- the people (invented) and their phones (example numbers in the shape of passport/0.3)
const NAMES = {
  tr: ["Ayşe", "Mert", "Elif", "Can", "Zeynep", "Emre", "Selin", "Barış", "Ece", "Kerem", "Defne", "Arda"],
  de: ["Lena", "Jonas", "Mia", "Felix", "Lukas", "Hannah", "Paul", "Lea", "Noah", "Clara"],
};
const CITIES = { tr: ["istanbul", "ankara", "izmir", "hatay", "van"], de: ["munchen", "berlin", "hamburg", "koln", "leipzig"] };
const ASCII = { ş: "s", ç: "c", ğ: "g", ı: "i", ö: "o", ü: "u", é: "e" };
const handleOf = (n) => n.toLowerCase().replace(/[şçğıöüé]/g, (c) => ASCII[c]);
const PHONES = [
  { device: "samsung SM-S936B", soc: "SM8750", ram: 10.9, bw: 38, threads: 4, gpu: "Adreno830v2", feats: ["asimddp", "i8mm", "asimdhp", "fphp"], clusters: [[2, 4.47], [6, 3.53]] },
  { device: "samsung SM-S921B", soc: "s5e9945", ram: 7.4, bw: 27, threads: 4, gpu: "", feats: ["asimddp", "i8mm", "asimdhp"], clusters: [[1, 3.21], [2, 2.9], [3, 2.6], [4, 1.96]] },
  { device: "Google Pixel 8", soc: "Tensor G3", ram: 7.6, bw: 21, threads: 4, gpu: "", feats: ["asimddp", "i8mm", "asimdhp", "sve", "sve2"], clusters: [[1, 2.91], [4, 2.37], [4, 1.7]] },
  { device: "Google Pixel 9 Pro", soc: "Tensor G4", ram: 15.2, bw: 29, threads: 4, gpu: "", feats: ["asimddp", "i8mm", "asimdhp", "sve", "sve2"], clusters: [[1, 3.1], [3, 2.6], [4, 1.92]] },
  { device: "Xiaomi 23127PN0CG", soc: "SM8650", ram: 11.2, bw: 35, threads: 4, gpu: "Adreno750v2", feats: ["asimddp", "i8mm", "asimdhp"], clusters: [[1, 3.3], [5, 3.15], [2, 2.27]] },
  { device: "OnePlus CPH2581", soc: "SM8650", ram: 15.3, bw: 36, threads: 6, gpu: "Adreno750v2", feats: ["asimddp", "i8mm", "asimdhp"], clusters: [[1, 3.3], [5, 3.15], [2, 2.27]] },
  { device: "samsung SM-A556B", soc: "s5e8845", ram: 7.4, bw: 13, threads: 4, gpu: "", feats: ["asimddp", "asimdhp"], clusters: [[4, 2.4], [4, 1.8]] },
  { device: "Nothing A142", soc: "MT6886", ram: 7.6, bw: 15, threads: 4, gpu: "", feats: ["asimddp", "asimdhp"], clusters: [[2, 2.8], [6, 2.0]] },
  { device: "Fairphone FP5", soc: "QCM6490", ram: 7.5, bw: 11, threads: 4, gpu: "Adreno643v1", feats: ["asimddp", "asimdhp"], clusters: [[1, 2.7], [3, 2.4], [4, 1.9]] },
];
// the phase-1 rule of device-passport (Probe.kt): budget and speed range
const r1 = (x) => Math.floor(x * 10 + 0.5) / 10, r2 = (x) => Math.floor(x * 100 + 0.5) / 100;
function passport(ph) {
  const free = r1(ph.ram * between(0.32, 0.5, 2));
  const ram = r2(Math.max(0, free * 0.8 - 0.5));
  const fit = [1, 3, 4, 7, 8, 12, 14].filter((s) => s * 0.61 <= ram).pop() ?? 0;
  const read = r2(ph.bw * between(0.9, 1.1, 2));
  const high = r1((read * 0.6) / (Math.max(fit, 1) * 0.61));
  const old = [1, 3, 4, 7, 8, 12, 14].filter((s) => s * 0.6 <= free * 0.8).pop() ?? null;
  const bwThreads = Object.fromEntries([1, 2, 4, 6, 8].map((t) => [String(t), r2(read * ({ 1: 0.45, 2: 0.78, 4: 1, 6: 0.97, 8: 0.82 })[t] * (t === ph.threads ? 1 : 0.97))]));
  return {
    schema: "passport/0.3", device: ph.device, soc: ph.soc, android: pick(["14", "15", "16"]), ram_total_gb: ph.ram, ram_free_gb: free,
    app_mem_cap_mb: 512, cpu_cores: ph.clusters.reduce((s, c) => s + c[0], 0), cpu_max_ghz: ph.clusters[0][1], mem_bw_gbs: r2(read * 0.68),
    gflops: between(20, 70, 1), storage_free_gb: between(20, 200, 1), battery_pct: Math.round(between(30, 100, 0)), charging: rnd() < 0.6,
    largest_model_q4: old === null ? "<1B" : `~${old}B`, est_tps: r1((read * 0.68) / ((old ?? 1) * 0.6) * 0.5),
    measured_at: new Date(Date.now() - between(1, 72, 0) * 3600_000).toISOString(), device_id: randomUUID(), kind: "phone", os: "android 15",
    mem_bw_read_gbs: read, bw_threads: bwThreads, best_threads: ph.threads, clusters: ph.clusters.map(([count, max_ghz]) => ({ count, max_ghz })),
    cpu_features: ph.feats, thermal: { status: pick([0, 0, 0, 1]), headroom: between(0.2, 0.7, 2), battery_c: between(27, 36, 1) },
    gpu: { opencl: !!ph.gpu, vulkan: "1.3", model: ph.gpu }, wifi: { band: pick(["5", "5", "2.4"]), link_mbps: pick([433, 866, 1201]) },
    budget: { ctx: 2048, reserve_gb: 0.5, ram_gb: ram, q4_k_m_b: r1(ram / 0.61), q3_k_s_b: r1(ram / 0.45), q8_0_b: r1(ram / 1.06) },
    estimate: { fit_b: fit, tps_low: r1(high * 0.5), tps_high: high, source: "estimate" }, measure_ms: Math.round(between(11000, 16000, 0)),
  };
}

const LINES = {
  tr: ["bu gece {p} üzerinde çalışıyorum, sen de gelsene", "telefon şarjda, wi-fi açık, başladı bile", "dün gece kartım geldi, 41 bin token", "kooperatife katılır mısın?", "bu gece olmaz, yarın varım", "tamam, ben de bunu sakladım", "sabah kartları karşılaştıralım"],
  de: ["heute nacht arbeite ich an {p}, kommst du mit?", "handy hängt am strom, läuft schon", "meine karte von gestern: 38 tausend tokens", "kommst du in unsere koop?", "heute nicht, morgen bin ich dabei", "ok, hab ich auch behalten", "morgen früh karten vergleichen"],
};

const today = (offsetDays = 0) => { const d = new Date(Date.now() - 12 * 3600_000 + offsetDays * 86400_000); return d.toISOString().slice(0, 10); };

console.log(`demo world from ${S}, seed ${seed}`);
const me = { handle: "deniz", name: "Deniz", lang: "tr", city: "istanbul", ...(await signup("deniz")) };
const names = shuffle([...NAMES.tr.map((n) => ["tr", n]), ...NAMES.de.map((n) => ["de", n])]).slice(0, 14);
const people = [];
for (const [lang, name] of names) {
  const h = handleOf(name);
  people.push({ handle: h, name, lang, city: pick(CITIES[lang]), phone: pick(PHONES), ...(await signup(h)) });
}
const all = await signup("everything"); // keeps nothing: its deck is every project
await rpc(me, "profile_setup", { p_handle: me.handle, p_display_name: me.name, p_city_slug: me.city, p_bio: "telefonum geceleri çalışıyor" });
await rpc(all, "profile_setup", { p_handle: "everything", p_display_name: "everything", p_city_slug: "berlin", p_bio: null });
for (const p of people) await rpc(p, "profile_setup", { p_handle: p.handle, p_display_name: p.name, p_city_slug: p.city, p_bio: pick([null, "gece vardiyası", "nachtschicht", "şarjdayken işe yarasın", "für die gute sache"]) });

const projects = await rpc(all, "deck", { p_country: null, p_limit: 100 });
const slugs = projects.map((p) => p.slug);
const friends = people.slice(0, 7), incoming = people.slice(7, 9), outgoing = people[9], strangers = people.slice(10);
for (const f of friends) { await rpc(me, "friend_request", { p_handle: f.handle }); await rpc(f, "friend_accept", { p_other: me.id }); }
for (const p of incoming) await rpc(p, "friend_request", { p_handle: me.handle });
await rpc(me, "friend_request", { p_handle: outgoing.handle });
// friends know each other too (a coop may only hold its maker's friends)
for (const [a, b] of [[0, 1], [0, 2], [1, 2], [3, 4], [2, 5], [4, 6]]) { await rpc(friends[a], "friend_request", { p_handle: friends[b].handle }); await rpc(friends[b], "friend_accept", { p_other: friends[a].id }); }
for (const s of strangers) for (const f of shuffle(friends).slice(0, 2)) { await rpc(s, "friend_request", { p_handle: f.handle }); await rpc(f, "friend_accept", { p_other: s.id }); }

const keeps = new Map();
for (const p of [me, ...people]) {
  const mine = shuffle(slugs).slice(0, 2 + Math.floor(rnd() * 3));
  keeps.set(p.handle, mine);
  for (const s of mine) await rpc(p, "join_set", { p_slug: s, p_direction: "right" });
  for (const s of shuffle(slugs.filter((x) => !mine.includes(x))).slice(0, 2)) await rpc(p, "join_set", { p_slug: s, p_direction: "left" });
}
const meP = { ...passport(PHONES[0]), measured_at: new Date().toISOString() };
await rpc(me, "passport_save", { p_data: meP, p_client_id: randomUUID() });
for (const p of people) await rpc(p, "passport_save", { p_data: passport(p.phone), p_client_id: randomUUID() });

// nights: a start may be at most 12 h back, so they all happen today; the snapshot spreads
// the finished ones over the past days afterwards (shiftCards)
async function night(p, slug, startH, hours, tps) {
  const id = await rpc(p, "contribution_start", { p_slug: slug, p_client_id: randomUUID(), p_at: new Date(Date.now() - startH * 3600_000).toISOString() });
  if (hours === null) return id;
  const seconds = Math.round(hours * 3600);
  return rpc(p, "contribution_end", { p_id: id, p_tokens: Math.round(tps * seconds), p_seconds: seconds, p_kwh: r2((4 * seconds) / 3600 / 1000 * 1000) / 1000, p_at: new Date(Date.now() - (startH - hours) * 3600_000).toISOString() });
}
for (let i = 0; i < 3; i++) await night(me, keeps.get(me.handle)[i % keeps.get(me.handle).length], 11 - i * 3, 2.5, meP.estimate.tps_low);
for (const f of friends.slice(0, 5)) for (let i = 0; i < 1 + Math.floor(rnd() * 2); i++) await night(f, keeps.get(f.handle)[i % keeps.get(f.handle).length], 10 - i * 4, 3, between(3, 9));
for (const f of friends.slice(5, 7)) await night(f, keeps.get(f.handle)[0], 0.5, null, 0); // working right now

for (const f of friends.slice(0, 3)) {
  const thread = await rpc(me, "dm_start", { p_handle: f.handle });
  const lines = shuffle(LINES[f.lang]).slice(0, 3 + Math.floor(rnd() * 3));
  for (const [i, l] of lines.entries()) {
    const who = i % 2 === 0 ? f : me;
    await rpc(who, "dm_send", { p_thread: thread, p_body: l.replace("{p}", projects.find((p) => p.slug === keeps.get(f.handle)[0]).title), p_client_id: randomUUID() });
  }
}

const coopA = await rpc(friends[0], "coop_create", { p_name: "gece vardiyası", p_emoji: "🔋", p_color: "green", p_members: [me.id, friends[1].id, friends[2].id] });
await rpc(friends[0], "coop_night_set", { p_id: coopA, p_night: today(), p_slug: keeps.get(friends[0].handle)[0] }, true);
const coopB = await rpc(friends[3], "coop_create", { p_name: "nachtschicht", p_emoji: "🌙", p_color: "gold", p_members: [me.id, friends[4].id] });
await rpc(friends[3], "coop_night_set", { p_id: coopB, p_night: today(), p_slug: keeps.get(friends[3].handle)[0] }, true);
const callA = await rpc(friends[1], "call_create", { p_slug: keeps.get(friends[1].handle)[0], p_night: today(1), p_reach: 1, p_note: "yarın gece birlikte?" });
await rpc(friends[2], "call_create", { p_slug: keeps.get(friends[2].handle)[0], p_night: today(), p_reach: 2, p_note: "bu gece şarja takın" });
await rpc(me, "call_answer", { p_call: callA, p_answer: "in" });
await rpc(me, "call_create", { p_slug: keeps.get(me.handle)[0], p_night: today(2), p_reach: 1, p_note: "cumartesi gecesi kim var?" }, true);

// ---- every answer the app asks for, as the demo user
const q = (name, args) => rpc(me, name, args);
const ids = projects.map((p) => p.id);
const snap = { schema: "kula-demo/1", generated_at: new Date().toISOString(), seed: Number(process.argv[2] ?? 2110), me: { id: me.id, handle: me.handle, email: "deniz@demo.kula" } };
snap.projects = projects;
snap.profile_me = await q("profile_me");
snap.friends_list = await q("friends_list");
snap.friends_kept = await q("friends_kept", { p_limit: 60 });
snap.friends_live = await q("friends_live");
snap.joins = Object.fromEntries(keeps.get(me.handle).map((s) => [s, "right"]));
snap.project_pages = Object.fromEntries(await Promise.all(slugs.map(async (s) => [s, await q("project_page", { p_slug: s })])));
snap.about = {};
snap.samples = {};
for (const lang of ["en", "de", "tr"]) { snap.about[lang] = await q("about_for", { p_projects: ids, p_lang: lang }); snap.samples[lang] = await q("samples_for", { p_projects: ids, p_lang: lang }); }
snap.my_cards = await q("my_cards");
snap.credits_mine = await q("credits_mine");
snap.passport_mine = await q("passport_mine", { p_limit: 10 });
snap.people = {};
for (const p of people) snap.people[p.handle] = { card: await q("profile_card", { p_handle: p.handle }), cards: await rpc(me, "person_cards", { p_handle: p.handle }, true) ?? [] };
snap.people_suggested = await q("people_suggested", { p_limit: 12 });
snap.dm_list = await q("dm_list");
snap.dm_threads = Object.fromEntries(await Promise.all((snap.dm_list ?? []).map(async (d) => [d.id, await q("dm_thread", { p_thread: d.id, p_after: 0 })])));
snap.my_coops = await q("my_coops");
snap.coops = {};
snap.coop_nights = {};
for (const c of snap.my_coops ?? []) { snap.coops[c.id] = await q("coop_get", { p_id: c.id }); snap.coop_nights[c.id] = await q("coop_nights", { p_id: c.id }); }
snap.call_inbox = await q("call_inbox");
snap.call_mine = await q("call_mine");
snap.call_people = Object.fromEntries(await Promise.all([...(snap.call_inbox ?? []), ...(snap.call_mine ?? [])].map(async (c) => [c.id, await q("call_people", { p_call: c.id })])));
snap.call_audience = await q("call_audience");
snap.network_nodes = await rpc(null, "network_nodes");
snap.device_catalog = await rpc(null, "device_catalog");
snap.network_estimate = await rpc(null, "network_estimate");
snap.terms_status = await q("terms_status");
snap.account_status = await q("account_status");
snap.min_app_version = await rpc(null, "min_app_version", {}, true);
snap.migrations_applied = await rpc(null, "migrations_applied", {}, true);

// spread the finished nights over the past days (they all ran today on the local server)
function shiftCards(rows) {
  const by = [...new Set((rows ?? []).map((r) => r.card_no))].sort((a, b) => b - a);
  for (const r of rows ?? []) {
    const days = by.indexOf(r.card_no) * 2 + 1;
    for (const k of ["started_at", "ended_at"]) if (r[k]) r[k] = new Date(new Date(r[k]).getTime() - days * 86400_000).toISOString();
  }
}
shiftCards(snap.my_cards);
for (const p of Object.values(snap.people)) shiftCards(p.cards);

const out = new URL("../src/demo/snapshot.json", import.meta.url);
writeFileSync(out, JSON.stringify(snap) + "\n");
const count = (x) => (Array.isArray(x) ? x.length : x ? 1 : 0);
console.log(`✓ ${out.pathname}: ${snap.projects.length} projects, ${Object.keys(snap.people).length} people, ${count(snap.friends_list)} relations, ${count(snap.my_cards)} cards, ${count(snap.dm_list)} threads, ${count(snap.my_coops)} coops, ${count(snap.call_inbox)} calls in, ${count(snap.device_catalog)} device models`);
