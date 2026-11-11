#!/usr/bin/env node
// Packs kula-node into one executable per platform: esbuild makes a single
// CommonJS bundle, Node's single executable application support turns it into
// a blob, and postject injects the blob into an official Node binary of the
// target (downloaded from nodejs.org, sha256-checked against SHASUMS256.txt,
// whose own hash is pinned in packlib.mjs). macOS binaries are signed ad hoc
// afterwards (codesign --sign -), so they need a Mac to be packed.
//
//   node tools/pack.mjs                       this machine's target, then runs it (--version, --help)
//   node tools/pack.mjs --target linux-x64,win-x64
//   node tools/pack.mjs --target all          every target (the mac ones only on a Mac)
//   options: --out <dir> (default dist-bin)  --cache <dir> (default .pack-cache)  --no-smoke
//
// Out: dist-bin/kula-node-<target>[.exe] and dist-bin/sha256sums.txt. Neither dir is committed.
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  NODE_DIR, NODE_VERSION, NODE_SHASUMS_SHA256, TARGETS, SEA_FUSE,
  hostTarget, binaryName, nodeAsset, readVersion, sha256, sha256File, parseSums, formatSums,
} from './packlib.mjs';

const require = createRequire(import.meta.url);

function args(argv) {
  const o = { target: 'host', out: path.join(NODE_DIR, 'dist-bin'), cache: path.join(NODE_DIR, '.pack-cache'), smoke: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') o.target = argv[++i];
    else if (a === '--out') o.out = path.resolve(argv[++i]);
    else if (a === '--cache') o.cache = path.resolve(argv[++i]);
    else if (a === '--no-smoke') o.smoke = false;
    else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); process.exit(0); }
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

const log = (s) => console.log(`pack: ${s}`);

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} exited with ${r.status}`);
  return r;
}

function get(url, dest, hops = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'kula-node-pack' } }, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location && hops < 5) {
        res.resume();
        const next = new URL(res.headers.location, url);
        if (next.protocol !== 'https:') return reject(new Error(`refusing a redirect to ${next}`));
        return resolve(get(next.toString(), dest, hops + 1));
      }
      if (code !== 200) { res.resume(); return reject(new Error(`${url}: ${code}`)); }
      const tmp = `${dest}.part`;
      const w = fs.createWriteStream(tmp);
      res.pipe(w);
      w.on('finish', () => { fs.renameSync(tmp, dest); resolve(dest); });
      w.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

// SHASUMS256.txt of the pinned Node release, checked against the pinned hash.
async function nodeSums(cache) {
  const want = NODE_SHASUMS_SHA256[NODE_VERSION];
  if (!want) throw new Error(`no pinned SHASUMS256.txt hash for node ${NODE_VERSION} in packlib.mjs`);
  const dir = path.join(cache, `node-v${NODE_VERSION}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SHASUMS256.txt');
  if (!fs.existsSync(file)) await get(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`, file);
  const text = fs.readFileSync(file);
  if (sha256(text) !== want) { fs.rmSync(file); throw new Error(`SHASUMS256.txt for node ${NODE_VERSION}: sha256 ${sha256(text)}, pinned ${want}`); }
  return parseSums(text.toString('utf8'));
}

// The official node binary for a target, unpacked into the cache.
async function nodeBinary(target, sums, cache) {
  const { file, inner } = nodeAsset(target);
  const want = sums.get(file);
  if (!want) throw new Error(`SHASUMS256.txt has no ${file}`);
  const dir = path.join(cache, `node-v${NODE_VERSION}`, target);
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, `node${TARGETS[target].ext}`);
  const stamp = `${bin}.sha256-of-download`;
  if (fs.existsSync(bin) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === want) return bin;
  const archive = path.join(dir, path.basename(file));
  if (!fs.existsSync(archive) || (await sha256File(archive)) !== want) {
    log(`downloading node ${NODE_VERSION} for ${target}: ${file}`);
    await get(`https://nodejs.org/dist/v${NODE_VERSION}/${file}`, archive);
  }
  const got = await sha256File(archive);
  if (got !== want) { fs.rmSync(archive); throw new Error(`${file}: sha256 mismatch (got ${got}, SHASUMS256.txt says ${want})`); }
  log(`${file}: sha256 ok`);
  if (inner) {
    run('tar', ['-xzf', archive, '-C', dir, inner]);
    fs.renameSync(path.join(dir, inner), bin);
    fs.rmSync(path.join(dir, inner.split('/')[0]), { recursive: true, force: true });
    fs.rmSync(archive);
  } else if (archive !== bin) fs.renameSync(archive, bin);
  fs.writeFileSync(stamp, want);
  return bin;
}

// One CommonJS file with everything, the dashboard's and the chat page's static files baked in.
async function bundle(outFile, version) {
  const esbuild = await import('esbuild');
  const staticDir = path.join(NODE_DIR, 'src', 'dashboard', 'static');
  const baked = Object.fromEntries(['index.html', 'app.js', 'app.css'].map((f) => [f, fs.readFileSync(path.join(staticDir, f), 'utf8')]));
  // the chat page (kula-node ui) the same way; the list is UI_STATIC in src/ui/server.ts
  const uiDir = path.join(NODE_DIR, 'src', 'ui', 'static');
  const uiBaked = Object.fromEntries(['index.html', 'app.js', 'app.css', 'fonts.css', 'markdown.js', 'wizard.js', 'learn.js', 'brainmap.js', 'replay.js', 'replay.css'].map((f) => [f, fs.readFileSync(path.join(uiDir, f), 'utf8')]));
  const r = await esbuild.build({
    entryPoints: [path.join(NODE_DIR, 'src', 'bin', 'kula-node.ts')],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    legalComments: 'inline',
    // only paths.ts reads import.meta.url, and never when packed
    logOverride: { 'empty-import-meta': 'silent' },
    define: {
      __KULA_NODE_VERSION__: JSON.stringify(version),
      __KULA_PACKED__: 'true',
      __KULA_STATIC__: JSON.stringify(baked),
      __KULA_UI_STATIC__: JSON.stringify(uiBaked),
    },
    metafile: true,
    logLevel: 'warning',
  });
  // a native addon would not survive the bundle; say so instead of shipping a broken binary
  const native = Object.keys(r.metafile.inputs).filter((f) => f.endsWith('.node'));
  if (native.length) throw new Error(`native addons cannot go into the single binary: ${native.join(', ')}`);
  return Object.keys(r.metafile.inputs).filter((f) => f.includes('node_modules/')).map((f) => f.split('node_modules/')[1].split('/')[0]);
}

async function main() {
  const o = args(process.argv.slice(2));
  const host = hostTarget();
  let targets = o.target === 'host' ? [host] : o.target === 'all' ? Object.keys(TARGETS) : o.target.split(',');
  if (targets.includes(null)) throw new Error(`no target for this machine (${process.platform}/${process.arch}); pass --target`);
  for (const t of targets) if (!TARGETS[t]) throw new Error(`unknown target ${t}; one of ${Object.keys(TARGETS).join(', ')}`);
  if (process.platform !== 'darwin') {
    const mac = targets.filter((t) => TARGETS[t].platform === 'darwin');
    if (mac.length && o.target !== 'all') throw new Error(`${mac.join(', ')}: macOS binaries must be signed with codesign, pack them on a Mac`);
    if (mac.length) log(`skipping ${mac.join(', ')}: they need codesign, pack them on a Mac`);
    targets = targets.filter((t) => TARGETS[t].platform !== 'darwin');
  }

  const version = readVersion();
  fs.mkdirSync(o.out, { recursive: true });
  const work = path.join(o.cache, 'work');
  fs.mkdirSync(work, { recursive: true });

  const bundleFile = path.join(work, 'kula-node.cjs');
  const deps = await bundle(bundleFile, version);
  log(`bundle ${(fs.statSync(bundleFile).size / 1e6).toFixed(2)} MB (kula-node ${version}; packages: ${[...new Set(deps)].join(', ') || 'none'})`);

  const sums = await nodeSums(o.cache);
  // the blob comes from node of the very same version, run on this machine;
  // without a snapshot or code cache it fits every target
  const hostNode = host ? await nodeBinary(host, sums, o.cache) : null;
  if (!hostNode) throw new Error('cannot make the blob: no node binary for this machine');
  const blob = path.join(work, 'sea-prep.blob');
  const seaConfig = path.join(work, 'sea-config.json');
  fs.writeFileSync(seaConfig, JSON.stringify({ main: bundleFile, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }, null, 2));
  run(hostNode, ['--experimental-sea-config', seaConfig], { cwd: work });
  const blobData = fs.readFileSync(blob);
  const { inject } = require('postject');

  for (const target of targets) {
    const t = TARGETS[target];
    const src = await nodeBinary(target, sums, o.cache);
    const out = path.join(o.out, binaryName(target));
    fs.rmSync(out, { force: true });
    fs.copyFileSync(src, out);
    fs.chmodSync(out, 0o755);
    if (t.platform === 'darwin') run('codesign', ['--remove-signature', out]);
    log(`${target}: injecting the blob`);
    await inject(out, 'NODE_SEA_BLOB', blobData, { sentinelFuse: SEA_FUSE, ...(t.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}) });
    // macOS refuses to run an arm64 binary without a signature; ad hoc is enough for a download
    if (t.platform === 'darwin') run('codesign', ['--sign', '-', '--force', out]);
    log(`${target}: ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
    if (o.smoke && target === host) {
      for (const a of [['--version'], ['--version', '--json'], ['--help']]) {
        const r = spawnSync(out, a, { encoding: 'utf8', timeout: 30000 });
        if (r.status !== 0) throw new Error(`${out} ${a.join(' ')} exited with ${r.status}: ${r.stderr}`);
        log(`$ ${binaryName(target)} ${a.join(' ')}\n${r.stdout.trimEnd().split('\n').slice(0, a[0] === '--help' ? 3 : 9).map((l) => `    ${l}`).join('\n')}`);
      }
      const v = JSON.parse(spawnSync(out, ['--version', '--json'], { encoding: 'utf8' }).stdout);
      if (v.version !== version || v.packed !== true) throw new Error(`the binary says ${JSON.stringify(v)}`);
    }
  }

  // sha256sums.txt over every binary in the out dir
  const lines = new Map();
  for (const f of fs.readdirSync(o.out)) if (/^kula-node-/.test(f)) lines.set(f, await sha256File(path.join(o.out, f)));
  fs.writeFileSync(path.join(o.out, 'sha256sums.txt'), formatSums(lines));
  log(`sha256sums.txt: ${lines.size} file${lines.size === 1 ? '' : 's'}`);
}

main().catch((e) => { console.error(`pack: ${e instanceof Error ? e.message : e}`); process.exit(1); });
