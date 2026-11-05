#!/usr/bin/env node
// Checks the markdown documentation: every relative link points at a file that exists,
// every `#anchor` names a heading in the target, and (with --external) every http(s) link
// answers. No dependencies; run from the repository root:
//
//   node tools-docs-links.mjs              relative links and anchors
//   node tools-docs-links.mjs --external   also fetch external links (HEAD, then GET)
//
// Files checked: README.md, CONTRIBUTING.md, AFTERHOURS.md, app/CREDITS.md, node/README.md,
// app/modules/kula-llama/AUDIT.md and everything in docs/. Exit 1 when a link is broken.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';

const root = dirname(new URL(import.meta.url).pathname);
const external = process.argv.includes('--external');
const files = ['README.md', 'CONTRIBUTING.md', 'AFTERHOURS.md', 'app/CREDITS.md', 'node/README.md', 'app/modules/kula-llama/AUDIT.md']
  .filter((f) => existsSync(join(root, f)))
  .concat(readdirSync(join(root, 'docs')).filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`));

// GitHub's anchor rule: lower case, punctuation out, spaces to dashes, duplicates numbered.
function anchorsOf(md) {
  const seen = new Map();
  const out = new Set();
  let fence = false;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    let a = m[1].toLowerCase().replace(/`[^`]*`/g, (s) => s.slice(1, -1)).replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
    a = a.replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-');
    const n = seen.get(a) ?? 0;
    seen.set(a, n + 1);
    out.add(n ? `${a}-${n}` : a);
  }
  return out;
}

const links = (md) => {
  const out = [];
  let fence = false;
  md.split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; return; }
    if (fence) return;
    const re = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let m;
    while ((m = re.exec(line))) out.push({ target: m[1], line: i + 1 });
  });
  return out;
};

const anchors = new Map();
const anchorsFor = (path) => {
  if (!anchors.has(path)) anchors.set(path, anchorsOf(readFileSync(path, 'utf8')));
  return anchors.get(path);
};

const broken = [];
const ext = new Map();
for (const f of files) {
  const abs = join(root, f);
  for (const { target, line } of links(readFileSync(abs, 'utf8'))) {
    if (/^(https?:)?\/\//.test(target)) { if (external) ext.set(target, `${f}:${line}`); continue; }
    if (/^(mailto:|tel:)/.test(target)) continue;
    const [p, hash] = target.split('#');
    const dest = p ? resolve(dirname(abs), decodeURIComponent(p)) : abs;
    if (!existsSync(dest)) { broken.push(`${f}:${line}  missing  ${target}`); continue; }
    if (hash && statSync(dest).isFile() && dest.endsWith('.md') && !anchorsFor(dest).has(hash.toLowerCase())) broken.push(`${f}:${line}  no anchor  ${target}`);
  }
}

if (external) {
  const check = async (url) => {
    for (const method of ['HEAD', 'GET']) {
      try {
        const r = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'kula-docs-link-check' } });
        if (r.ok || r.status === 403 || r.status === 429) return null; // 403/429: alive, just not for bots
        if (method === 'GET') return `http ${r.status}`;
      } catch (e) { if (method === 'GET') return e.name === 'TimeoutError' ? 'timeout' : (e.cause?.code ?? e.message); }
    }
    return null;
  };
  const urls = [...ext.keys()];
  const results = await Promise.all(urls.map(async (u) => [u, await check(u)]));
  for (const [u, why] of results) if (why) broken.push(`${ext.get(u)}  ${why}  ${u}`);
  console.log(`${urls.length} external links fetched`);
}

const total = files.reduce((n, f) => n + links(readFileSync(join(root, f), 'utf8')).length, 0);
console.log(`${files.length} files, ${total} links, ${broken.length} broken`);
for (const b of broken) console.log('  ' + b);
process.exit(broken.length ? 1 : 0);
