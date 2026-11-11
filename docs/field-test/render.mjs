#!/usr/bin/env node
// kula field test: one data file (the report's json block) -> <name>.html, <name>.md and <name>.pdf.
// Page 1 is the score sheet, the pages after it are docs/FIELD-TEST.md. Run it at the start of a
// test (status "running": the page shows what is still pending) and again after every step.
//
//   node render.mjs <data.json> [--no-pdf] [--protocol <FIELD-TEST.md>] [--browser <path>]
//
// No dependencies. The pdf needs a Chromium-family browser (Chrome, Chromium, Edge, Brave); without
// one the html is still written: open it and print to pdf.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW_PROTOCOL = 'https://raw.githubusercontent.com/kurtkurtkurt-del/kula-decentralized-ai/main/docs/FIELD-TEST.md';

export const ROWS = {
  T01: 'node starts', T02: 'info', T03: 'setup', T04: 'model + sha', T05: 'bench alone',
  T06: 'chat page', T07: 'apk installs', T08: 'passport', T09: 'phone model', T10: 'phone P1–P3',
  T11: 'phone bench', T12: 'pairing', T13: 'probe', T14: 'apart', T15: 'split',
  T16: 'phone + phone', T17: 'pc + pc', T18: 'usb cable', T19: 'brain + ledger', T20: 'phone brain',
  T21: 'card applies', T22: 'access removed', T23: 'vision', T24: '3+ devices', T25: 'holds when warm',
};
const VALUE = { pass: 1, partial: 0.5, fail: 0 };
const clamp = (x) => Math.max(0, Math.min(1, x));
const round1 = (x) => Math.round(x * 10) / 10;

// The score: works 40 + together 25 + trust 20 + holds 15 = 100. Every part reads only the data
// block, so two reports with the same numbers get the same score. A part with nothing measured
// yet is null (0 in the total; the sheet says "pending").
export function score(d) {
  const parts = {};
  const counted = Object.values(d.checklist ?? {}).filter((v) => v in VALUE);
  parts.works = counted.length
    ? { pts: (40 * counted.reduce((s, v) => s + VALUE[v], 0)) / counted.length, max: 40,
        why: `${counted.filter((v) => v === 'pass').length} pass, ${counted.filter((v) => v === 'partial').length} partial, ${counted.filter((v) => v === 'fail').length} fail of ${counted.length} tried` }
    : null;

  const alone = (d.devices ?? []).map((x) => x.alone?.gen_tok_s).filter((x) => typeof x === 'number');
  const fastest = alone.length ? Math.max(...alone) : null;
  const combos = (d.combinations ?? []).filter((c) => c.apart?.result === 'pass' && c.apart.tokens_total && c.apart.seconds);
  let gain = null, best = null;
  for (const c of combos) {
    const tps = c.apart.tokens_total / c.apart.seconds;
    if (!best || tps > best.tps) best = { tps, c };
  }
  if (best && fastest) gain = best.tps / fastest;
  const splits = (d.combinations ?? []).filter((c) => c.split?.result === 'pass' && typeof c.split.tok_s === 'number');
  const bestSplit = splits.length ? Math.max(...splits.map((c) => c.split.tok_s)) : null;
  if (gain !== null || bestSplit !== null) {
    const k = best ? best.c.devices.length : 2;
    const g = gain !== null ? 15 * clamp((gain - 1) / (k - 1)) : 0;
    const s = bestSplit !== null && fastest ? 10 * clamp(bestSplit / (0.5 * fastest)) : 0;
    parts.together = { pts: g + s, max: 25,
      why: `${gain !== null ? `×${gain.toFixed(2)} together (apart)` : 'apart pending'} · ${bestSplit !== null ? `split ${bestSplit} tok/s` : 'split pending'}` };
  } else parts.together = null;

  const t = d.trust;
  if (t && (t.verdict || t.ledger || t.revoke_refused !== undefined)) {
    const v = { 'all clear': 8, 'look at this': 4 }[t.verdict] ?? 0;
    parts.trust = { pts: v + (t.ledger === 'holds' ? 4 : 0) + (t.revoke_refused ? 4 : 0) + (t.tls_pinned ? 4 : 0), max: 20,
      why: `verdict ${t.verdict ?? '—'} · ledger ${t.ledger ?? '—'} · removed device ${t.revoke_refused ? 'refused' : t.revoke_refused === false ? 'still let in' : '—'}` };
  } else parts.trust = null;

  const h = d.heat?.tok_s?.length > 1 ? d.heat.tok_s.at(-1) / d.heat.tok_s[0] : null;
  const ps = (d.devices ?? []).flatMap((x) => ['p1', 'p2', 'p3'].map((p) => x.alone?.[p]).filter((v) => v in VALUE));
  const pair = (d.combinations ?? []).map((c) => c.pairing).filter((p) => p?.result === 'pass');
  const pairPts = pair.length ? Math.max(...pair.map((p) => (p.tries === 1 && p.seconds <= 60 ? 5 : p.tries <= 3 ? 3 : 0))) : null;
  if (h !== null || ps.length || pairPts !== null) {
    const hp = h !== null ? 5 * clamp((h - 0.7) / 0.25) : 0;
    const ap = ps.length ? (5 * ps.reduce((s, v) => s + VALUE[v], 0)) / ps.length : 0;
    parts.holds = { pts: hp + ap + (pairPts ?? 0), max: 15,
      why: `${h !== null ? `kept ${Math.round(h * 100)} % of its speed warm` : 'heat pending'} · prompts ${ps.length ? Math.round((100 * ps.reduce((s, v) => s + VALUE[v], 0)) / ps.length) + ' %' : '—'} · pairing ${pairPts !== null ? pairPts + '/5' : '—'}` };
  } else parts.holds = null;

  const total = Object.values(parts).reduce((s, p) => s + (p ? p.pts : 0), 0);
  const grade = total >= 90 ? 'ready for friends' : total >= 75 ? 'works, rough edges' : total >= 50 ? 'works with help' : 'not yet';
  return { total: Math.round(total), exact: round1(total), grade, parts, gain, fastest, bestApart: best?.tps ?? null, bestSplit, heatRatio: h };
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = (x, d = 1) => (typeof x === 'number' ? (Number.isInteger(x) ? String(x) : x.toFixed(d)) : '<span class="pending-v">—</span>');
const MARK = { pass: '✓', partial: '~', fail: '✗', skipped: '–', 'not tried': '·' };

function ring(sc, running) {
  const r = 26, c = 2 * Math.PI * r, f = clamp(sc.total / 100);
  return `<svg width="30mm" height="30mm" viewBox="0 0 64 64" aria-label="score ${sc.total} of 100">
    <circle cx="32" cy="32" r="${r}" fill="none" stroke="var(--paper)" stroke-width="7"/>
    <circle cx="32" cy="32" r="${r}" fill="none" stroke="var(--sage)" stroke-width="7" stroke-linecap="round"
      stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 32 32)"/>
    <text x="32" y="36" text-anchor="middle" font-size="19" font-weight="700" fill="var(--ink)" class="num">${sc.total}</text>
    <text x="32" y="46" text-anchor="middle" font-size="6" fill="var(--ink-3)">of 100${running ? ' so far' : ''}</text>
  </svg><div class="grade">${esc(sc.grade)}<small>${running ? 'the test is still running; this page fills in as it goes' : '90+ ready for friends<br>75–89 works, rough edges<br>50–74 works with help<br>under 50 not yet'}</small></div>`;
}

function page1(d, sc) {
  const running = d.status !== 'done';
  const parts = [['works', 'works'], ['together', 'together'], ['trust', 'trust'], ['holds', 'holds up']].map(([k, label]) => {
    const p = sc.parts[k], max = { works: 40, together: 25, trust: 20, holds: 15 }[k];
    return `<div class="part"><b>${label}</b><div class="track"><div class="fill" style="width:${p ? (100 * p.pts) / max : 0}%"></div></div>
      <div class="pts num">${p ? round1(p.pts) : '<span>—</span>'}<span> / ${max}</span></div><div class="why">${p ? esc(p.why) : 'pending'}</div></div>`;
  }).join('');

  const devs = (d.devices ?? []).map((x) => `<div class="card dev"><div class="badge">${esc(x.label)}</div><div>
      <div class="name">${esc(x.brand ?? '')} ${esc(x.model ?? '')}</div>
      <div class="sub">${esc(x.kind)} · ${esc(x.chip ?? '—')} · ${x.ram_total_mb ? Math.round(x.ram_total_mb / 1024) + ' GB' : '—'} ram (${x.ram_free_mb ? (x.ram_free_mb / 1024).toFixed(1) + ' GB free' : '—'}) · ${esc(x.os ?? '')}</div>
      <div class="stats">
        <div class="stat"><div class="v num">${fmt(x.alone?.gen_tok_s)}</div><div class="k">tok/s alone</div></div>
        <div class="stat"><div class="v num">${fmt(x.alone?.prompt_tok_s, 0)}</div><div class="k">prompt tok/s</div></div>
        <div class="stat"><div class="v num">${fmt(x.passport?.mem_bw_gbs)}</div><div class="k">GB/s memory</div></div>
      </div>
      <div class="chips">${['p1', 'p2', 'p3'].map((p) => { const v = x.alone?.[p]; return `<span class="chip"><i style="color:var(--${v === 'pass' ? 'good' : v === 'partial' ? 'ink-2' : v === 'fail' ? 'bad' : 'ink-3'})">${MARK[v] ?? '·'}</i>${p.toUpperCase()}</span>`; }).join('')}
        <span class="chip">${esc(x.battery_start ?? '—')} → ${esc(x.battery_end ?? '—')} %${x.charging ? ' ⚡' : ''}</span></div>
    </div></div>`).join('');

  // speed bars: one measure (tok/s), one axis
  const short = (s) => String(s ?? '').replace(/\s*\(.*\)/, '');
  const bars = [];
  for (const x of d.devices ?? []) bars.push({ lab: `<b>${esc(x.label)}</b> alone`, v: x.alone?.gen_tok_s });
  for (const c of d.combinations ?? []) {
    const n = c.devices.join('+');
    bars.push({ lab: `<b>${n}</b> apart · ${esc(short(c.link))}`, v: c.apart?.tokens_total && c.apart?.seconds ? round1(c.apart.tokens_total / c.apart.seconds) : null });
  }
  for (const c of d.combinations ?? []) bars.push({ lab: `<b>${c.devices.join('+')}</b> split · ${esc(short(c.link))}`, v: c.split?.tok_s, soft: true });
  const top = Math.max(1, ...bars.map((b) => b.v ?? 0)) * 1.04;
  const ref = sc.fastest ? (100 * sc.fastest) / top : null;
  const barsHtml = bars.map((b) => `<div class="bar"><div class="lab">${b.lab}</div><div class="t">${ref ? `<div class="ref" style="left:${ref}%"></div>` : ''}<div class="b${b.soft ? ' soft' : ''}" style="width:${b.v ? (100 * b.v) / top : 0}%"></div></div><div class="val num">${fmt(b.v)}</div></div>`).join('');

  const cs = d.combinations ?? [];
  const col = (f) => cs.map((c) => `<td class="n num">${f(c)}</td>`).join('');
  const mx = cs.length ? `<table class="mx"><tr><th></th>${cs.map((c) => `<th><span class="dot" style="background:var(--${/cable/.test(c.link) ? 'cable' : 'wifi'})"></span>${esc(short(c.link))}</th>`).join('')}</tr>
    <tr><td>pairing</td>${col((c) => c.pairing ? `${MARK[c.pairing.result] ?? ''} ${c.pairing.tries ?? '—'} try · ${fmt(c.pairing.seconds, 0)} s` : '—')}</tr>
    <tr><td>gate round trip</td>${col((c) => `${fmt(c.probe?.gate_ms, 0)} ms`)}</tr>
    <tr><td>tunnel</td>${col((c) => `${fmt(c.tunnel_mb_s)} MB/s`)}</tr>
    <tr><td>apart, together</td>${col((c) => c.apart?.tokens_total ? `${fmt(round1(c.apart.tokens_total / c.apart.seconds))} tok/s` : '—')}</tr>
    <tr><td>apart, per device</td>${col((c) => c.apart?.tok_s ? Object.entries(c.apart.tok_s).map(([k, v]) => `${k} ${v}`).join(' · ') : '—')}</tr>
    <tr><td>split</td>${col((c) => c.split ? `${fmt(c.split.tok_s)} tok/s · ${fmt(c.split.load_seconds, 0)} s load` : '—')}</tr>
    <tr><td>trust verdict</td>${col((c) => esc(c.trust_verdict ?? '—'))}</tr></table>` : '<div class="note">no pair joined yet</div>';

  const cells = Object.entries(ROWS).map(([id, label]) => {
    const v = d.checklist?.[id] ?? 'pending';
    return `<div class="cell ${v.replace(' ', '')}" title="${esc(d.checklist_notes?.[id] ?? '')}"><span class="id">${id}</span>${esc(label)}<span class="s">${MARK[v] ?? '…'}</span></div>`;
  }).join('');

  const cut = (s, n) => { s = String(s ?? ''); const k = s.indexOf(';'); s = k > 40 && k < n ? s.slice(0, k) : s; return s.length > n ? s.slice(0, s.lastIndexOf(' ', n)) + '…' : s; };
  const probs = (d.problems ?? []).slice(0, 4).map((p) => `<li><b>${esc(p.title ?? p.expected)}</b><span class="t">${esc(p.t)}</span><span class="d">${esc(cut(p.happened, 120))}</span></li>`).join('') || '<li class="note">none yet</li>';
  const more = (d.problems ?? []).length > 4 ? `<div class="note">+ ${(d.problems.length - 4)} more in the report file</div>` : '';

  const ht = d.heat?.tok_s ?? [];
  let spark = '<div class="note">not measured yet</div>';
  if (ht.length > 1) {
    const W = 150, H = 48, mx2 = Math.max(...ht) * 1.08, pts = ht.map((v, i) => [6 + (i * (W - 12)) / (ht.length - 1), H - 6 - ((H - 14) * v) / mx2]);
    spark = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="22mm" aria-label="speed over consecutive runs">
      <line x1="6" x2="${W - 6}" y1="${H - 6}" y2="${H - 6}" stroke="var(--line)"/>
      <polyline points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke="var(--sage)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      ${pts.map((p) => `<circle cx="${p[0]}" cy="${p[1]}" r="2.6" fill="var(--sage)" stroke="var(--card)" stroke-width="1.2"/>`).join('')}
      <text x="${pts[0][0] + 4}" y="${pts[0][1] - 4}" font-size="8" font-weight="700" fill="var(--ink)">${ht[0]}</text>
      <text x="${pts.at(-1)[0]}" y="${pts.at(-1)[1] - 5}" font-size="8" font-weight="700" fill="var(--ink)" text-anchor="end">${ht.at(-1)}</text>
    </svg><div class="note">device ${esc(d.heat.device)} tok/s over ${ht.length} runs in a row (${esc(d.heat.minutes)} min) · ${d.heat.temp_c ? `${d.heat.temp_c[0]} → ${d.heat.temp_c.at(-1)} °C` : ''}</div>`;
  }

  return `<main class="sheet">
  <header class="head"><div><div class="kicker">kula field test · ${esc(d.protocol)}</div><h1>${esc(d.tester ?? 'tester')} · test ${esc(d.test ?? 1)}</h1></div>
    <div class="meta">${running ? '<span class="live">running · refreshes itself</span><br>' : ''}${esc(d.date)} · ${esc(d.started ?? '')}–${esc(d.ended ?? '')}${d.minutes ? ` (${d.minutes} min)` : ''}<br>kula ${esc(d.kula?.node ?? '—')} · ${(d.devices ?? []).length} devices · Qwen3 0.6B Q8_0<br>${esc((d.ai ?? '').split(';')[0])}</div></header>
  <section class="row hero"><div class="card ring">${ring(sc, running)}</div><div class="card"><h2>the score, part by part</h2>${parts}</div></section>
  <section class="row devices">${devs || '<div class="card note">no devices yet</div>'}</section>
  <section class="row mid"><div class="card bars"><h2>tokens per second · Qwen3 0.6B</h2>${barsHtml}<div class="note">dashed line: the fastest device alone. apart = every device its own copy, the batch's tokens over its wall time. split = one model across the devices (slower by nature: it is for models too big for one device).</div></div>
    <div class="card"><h2>the two links</h2>${mx}</div></section>
  <section class="card"><h2>checklist · 25 rows</h2><div class="grid25">${cells}</div>
    <div class="legend"><span style="--c:var(--good)">✓ pass</span><span style="--c:var(--warn)">~ partial</span><span style="--c:var(--bad)">✗ fail</span><span style="--c:var(--none)">– skipped · not tried</span></div></section>
  <section class="row low"><div class="card"><h2>what to fix first${(d.problems ?? []).length > 4 ? ` · 4 of ${d.problems.length}, all in the report` : ""}</h2><ol class="probs">${probs}</ol></div>
    <div class="card"><h2>warm and busy</h2>${spark}</div></section>
  <footer class="foot"><span>score = works 40 (checklist) + together 25 (apart gain over the fastest device, split speed) + trust 20 (verdict, ledger, removed access, pinned tls) + holds up 15 (speed when warm, P1–P3, pairing ease). Formula: FIELD-TEST.md, “the score”.</span><span>nothing personal: devices are A, B; no addresses, codes or serials</span></footer>
</main>`;
}

// A small markdown reader for FIELD-TEST.md: headings, paragraphs, lists, tables, code, rules.
export function markdown(md) {
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s)<]+)/g, '$1<a href="$2">$2</a>');
  const lines = md.split('\n'); const out = []; let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (/^```/.test(l)) { const b = []; i++; while (i < lines.length && !/^```/.test(lines[i])) b.push(lines[i++]); i++; out.push(`<pre><code>${esc(b.join('\n'))}</code></pre>`); continue; }
    if (/^#{1,4} /.test(l)) { const n = l.match(/^#+/)[0].length; out.push(`<h${n}>${inline(l.slice(n + 1))}</h${n}>`); i++; continue; }
    if (/^---+\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^\|/.test(l)) {
      const rows = []; while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|\s*$/g, '').split('|').map((c) => c.trim());
      const body = rows.filter((r, k) => k !== 1 || !/^\|[\s:|-]+\|?\s*$/.test(r));
      out.push(`<table>${body.map((r, k) => `<tr>${cells(r).map((c) => (k === 0 ? `<th>${inline(c)}</th>` : `<td>${inline(c)}</td>`)).join('')}</tr>`).join('')}</table>`); continue;
    }
    if (/^\s*([-*]|\d+\.) /.test(l)) {
      const ordered = /^\s*\d+\./.test(l); const items = [];
      while (i < lines.length && (/^\s*([-*]|\d+\.) /.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (/^\s*([-*]|\d+\.) /.test(lines[i])) items.push(lines[i].replace(/^\s*([-*]|\d+\.) /, '')); else items[items.length - 1] += ' ' + lines[i].trim();
        i++;
      }
      out.push(`<${ordered ? 'ol' : 'ul'}>${items.map((x) => `<li>${inline(x)}</li>`).join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
    }
    if (!l.trim()) { i++; continue; }
    const p = []; while (i < lines.length && lines[i].trim() && !/^(#{1,4} |```|\||\s*([-*]|\d+\.) |---+\s*$)/.test(lines[i])) p.push(lines[i++].trim());
    out.push(`<p>${inline(p.join(' '))}</p>`);
  }
  return out.join('\n');
}

export function reportMd(d, sc) {
  const row = (id) => `| ${id} | ${ROWS[id]} | ${d.checklist?.[id] ?? 'pending'} | ${d.checklist_notes?.[id] ?? ''} |`;
  const devs = (d.devices ?? []).map((x) => `${x.label} = ${x.kind}, ${x.brand} ${x.model}`).join('; ');
  const passed = Object.entries(d.checklist ?? {}).filter(([, v]) => v === 'pass').map(([k]) => k);
  const notOk = Object.entries(d.checklist ?? {}).filter(([, v]) => v === 'fail' || v === 'partial').map(([k, v]) => `${k} ${v}`);
  const fastest = [...(d.devices ?? []).map((x) => [x.alone?.gen_tok_s, `${x.label} alone`]), ...(d.combinations ?? []).filter((c) => c.apart?.tokens_total).map((c) => [round1(c.apart.tokens_total / c.apart.seconds), `${c.devices.join('+')} apart over ${c.link}`])].filter(([v]) => typeof v === 'number').sort((a, b) => b[0] - a[0])[0];
  const raw = fs.existsSync(d.__raw ?? '') ? JSON.parse(fs.readFileSync(d.__raw, 'utf8')) : {};
  const data = { ...d }; delete data.__raw; delete data.__out;
  return `# kula field test: ${d.tester ?? ''} · test ${d.test ?? 1} (${d.date})

Score **${sc.total} / 100**: ${sc.grade}. ${d.status !== 'done' ? '(the test is still running)' : ''}

## 1. Summary

- Devices: ${devs || '—'}.
- Worked: ${passed.length ? passed.join(', ') : '—'}.
- Did not, or only partly: ${notOk.length ? notOk.join(', ') : '—'}.
- Fastest: ${fastest ? `${fastest[0]} tok/s, ${fastest[1]}` : '—'}.
- Most important problem: ${d.problems?.[0] ? `${d.problems[0].title} (${d.problems[0].t})` : '—'}.

## 2. Checklist

| # | what | result | note |
|---|---|---|---|
${Object.keys(ROWS).map(row).join('\n')}

## 3. Problems

${(d.problems ?? []).map((p, k) => `### ${k + 1}. ${p.title ?? ''} (${p.t})

- expected: ${p.expected ?? '—'}
- happened: ${p.happened ?? '—'}
- error: ${p.error ? '`' + p.error + '`' : '—'}
- again on a second try: ${p.again === true ? 'yes' : p.again === false ? 'no' : '—'}
- got around it: ${p.workaround ?? '—'}`).join('\n\n') || '—'}

## 4. The person's own words

- What was the most confusing moment? ${d.person?.most_confusing || '(not asked yet)'}
- What would you want it to do that it does not? ${d.person?.wish || '(not asked yet)'}

## 5. Data

\`\`\`json
${JSON.stringify(data, null, 2)}
\`\`\`
${Object.entries(raw).map(([k, v]) => `\nRaw bench record, ${k}:\n\n\`\`\`json\n${JSON.stringify(v, null, 1)}\n\`\`\``).join('\n')}
`;
}

function findBrowser(given) {
  const c = [given, process.env.KULA_BROWSER,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'];
  return c.find((p) => p && fs.existsSync(p)) ?? null;
}

async function protocolText(given) {
  for (const p of [given, path.join(HERE, '..', 'FIELD-TEST.md'), path.join(HERE, 'FIELD-TEST.md')]) if (p && fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  try { const r = await fetch(RAW_PROTOCOL); if (r.ok) return await r.text(); } catch {}
  return '# the protocol\n\nFIELD-TEST.md was not found next to this script and could not be fetched.';
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--') && a.endsWith('.json'));
  if (!file) { console.error('usage: node render.mjs <data.json> [--no-pdf] [--protocol <md>] [--browser <path>]'); process.exit(2); }
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const d = JSON.parse(fs.readFileSync(file, 'utf8'));
  const base = file.replace(/\.json$/, '');
  d.__raw = base + '.raw.json';
  const sc = score(d);
  const tpl = fs.readFileSync(path.join(HERE, 'template.html'), 'utf8');
  const proto = markdown(await protocolText(opt('--protocol')));
  const title = `${d.tester ?? 'kula'} · test ${d.test ?? 1} · ${sc.total}/100`;
  const build = (live) => tpl.replace('{{REFRESH}}', live ? '<meta http-equiv="refresh" content="5">' : '').replace('{{TITLE}}', esc(title)).replace('{{PAGE1}}', page1(d, sc)).replace('{{PROTOCOL}}', proto);
  fs.writeFileSync(base + '.html', build(d.status !== 'done'));
  fs.writeFileSync(base + '.md', reportMd(d, sc));
  let pdf = null;
  if (!args.includes('--no-pdf')) {
    const b = findBrowser(opt('--browser'));
    if (b) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-ft-'));
      const page = path.join(tmp, 'page.html');
      fs.writeFileSync(page, build(false));
      const out = path.resolve(base + '.pdf');
      execFileSync(b, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${path.join(tmp, 'profile')}`,
        '--no-pdf-header-footer', `--print-to-pdf=${out}`, 'file://' + page], { stdio: 'ignore', timeout: 120000 });
      fs.rmSync(tmp, { recursive: true, force: true });
      pdf = out;
    } else console.error('no Chromium-family browser found: open the .html and print it to pdf');
  }
  console.log(`score ${sc.exact} (${sc.grade}) · ${Object.entries(sc.parts).map(([k, p]) => `${k} ${p ? round1(p.pts) + '/' + p.max : 'pending'}`).join(' · ')}`);
  console.log([base + '.html', base + '.md', pdf].filter(Boolean).join('\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
