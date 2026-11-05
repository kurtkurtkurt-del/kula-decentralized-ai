#!/usr/bin/env node
// Packs kula-node into one file per platform: a node 22 "single executable
// application". Three steps, all offline except fetching the node binary for
// a foreign target:
//
//   1. esbuild bundles src/bin/kula-node.ts and both dependencies (pure js:
//      bonjour-service, qrcode-terminal; nothing native) into one cjs file,
//      with the version from package.json baked in.
//   2. node --experimental-sea-config turns it into a blob (no code cache,
//      so the same blob serves every platform of this node version).
//   3. the blob is injected (postject) into a copy of the node binary for the
//      target. The host's own binary is used for the host target; any other
//      is downloaded from nodejs.org at the same version and checked against
//      SHASUMS256.txt before anything is done with it.
//
// macOS binaries must be re-signed after injection (codesign --sign -), which
// only works on a mac: a mac target built elsewhere is written but flagged
// "unsigned", and the workflow builds those on a macos runner.
//
//   node tools/pack.mjs                      the host platform
//   node tools/pack.mjs --target linux-x64,win-x64 --out dist/pack
//   node tools/pack.mjs --all                every target
//   node tools/pack.mjs --bundle-only        just dist/pack/kula-node.cjs
//
// targets: mac-arm64 mac-x64 linux-x64 linux-arm64 win-x64
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

export const TARGETS = {
  'mac-arm64': { platform: 'darwin', arch: 'arm64', node: 'darwin-arm64', ext: '' },
  'mac-x64': { platform: 'darwin', arch: 'x64', node: 'darwin-x64', ext: '' },
  'linux-x64': { platform: 'linux', arch: 'x64', node: 'linux-x64', ext: '' },
  'linux-arm64': { platform: 'linux', arch: 'arm64', node: 'linux-arm64', ext: '' },
  'win-x64': { platform: 'win32', arch: 'x64', node: 'win-x64', ext: '.exe' },
};
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

export function hostTarget() {
  return Object.keys(TARGETS).find((t) => TARGETS[t].platform === process.platform && TARGETS[t].arch === process.arch) ?? null;
}

export function artifactName(target, version = pkg.version) {
  return `kula-node-${version}-${target}${TARGETS[target].ext}`;
}

function parseArgs(argv) {
  const o = { targets: [], out: path.join(root, 'dist', 'pack'), nodeVersion: process.version, bundleOnly: false, all: false, cache: process.env.KULA_PACK_CACHE || path.join(os.homedir(), '.cache', 'kula-pack'), smoke: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = () => argv[++i];
    if (a === '--target') o.targets.push(...v().split(','));
    else if (a === '--out') o.out = path.resolve(v());
    else if (a === '--node-version') o.nodeVersion = v().startsWith('v') ? v() : `v${argv[i]}`;
    else if (a === '--cache') o.cache = path.resolve(v());
    else if (a === '--bundle-only') o.bundleOnly = true;
    else if (a === '--no-smoke') o.smoke = false;
    else if (a === '--all') o.all = true;
    else if (a === '-h' || a === '--help') { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); process.exit(0); }
    else throw new Error(`unknown argument: ${a}`);
  }
  if (o.all) o.targets = Object.keys(TARGETS);
  if (!o.targets.length) { const h = hostTarget(); if (!h) throw new Error(`no target for this host ${process.platform}/${process.arch}; pass --target`); o.targets = [h]; }
  for (const t of o.targets) if (!TARGETS[t]) throw new Error(`unknown target ${t}; one of ${Object.keys(TARGETS).join(' ')}`);
  return o;
}

const log = (s) => console.error(`pack: ${s}`);

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}\n${r.stderr}`);
  return r.stdout;
}

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export async function bundle(out) {
  const esbuild = require('esbuild');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(root, 'src', 'bin', 'kula-node.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    outfile: out,
    logLevel: 'warning',
    define: { '__KULA_VERSION__': JSON.stringify(pkg.version), '__KULA_PACKED__': 'true', 'import.meta.url': '__kula_import_meta_url' },
    banner: { js: `const __kula_import_meta_url = require('node:url').pathToFileURL(__filename).href;` },
  });
  return out;
}

async function fetchTo(url, dest) {
  const res = await fetch(url, { headers: { 'user-agent': 'kula-node-pack' } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// The node binary for a target, from nodejs.org, checked against SHASUMS256.txt.
export async function nodeBinaryFor(target, version, cache) {
  const t = TARGETS[target];
  if (t.platform === process.platform && t.arch === process.arch && version === process.version) return process.execPath;
  const base = process.env.KULA_NODE_DIST || 'https://nodejs.org/dist';
  const zip = t.platform === 'win32';
  const archive = `node-${version}-${t.node}.${zip ? 'zip' : 'tar.gz'}`;
  const dir = path.join(cache, version);
  const file = path.join(dir, archive);
  const bin = path.join(dir, `node-${target}${t.ext}`);
  if (fs.existsSync(bin)) return bin;
  const sums = path.join(dir, 'SHASUMS256.txt');
  if (!fs.existsSync(sums)) { log(`fetching ${base}/${version}/SHASUMS256.txt`); await fetchTo(`${base}/${version}/SHASUMS256.txt`, sums); }
  const want = fs.readFileSync(sums, 'utf8').split('\n').map((l) => l.trim().split(/\s+/)).find(([, n]) => n === archive)?.[0];
  if (!want) throw new Error(`${archive} is not in SHASUMS256.txt for ${version}`);
  if (!fs.existsSync(file) || sha256(file) !== want) {
    log(`fetching ${base}/${version}/${archive}`);
    await fetchTo(`${base}/${version}/${archive}`, file);
  }
  const got = sha256(file);
  if (got !== want) { fs.rmSync(file); throw new Error(`${archive}: sha256 mismatch (got ${got}, want ${want}); deleted`); }
  log(`${archive}: sha256 ok`);
  const inner = `node-${version}-${t.node}/${zip ? 'node.exe' : 'bin/node'}`;
  const tmp = fs.mkdtempSync(path.join(dir, 'x-'));
  if (zip) {
    try { sh('unzip', ['-q', '-o', file, inner, '-d', tmp]); } catch { sh('tar', ['-xf', file, '-C', tmp, inner]); }
  } else sh('tar', ['-xzf', file, '-C', tmp, inner]);
  fs.copyFileSync(path.join(tmp, inner), bin);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.chmodSync(bin, 0o755);
  return bin;
}

export async function makeBlob(bundleFile, workDir) {
  const blob = path.join(workDir, 'kula-node.blob');
  const cfg = path.join(workDir, 'sea-config.json');
  fs.writeFileSync(cfg, JSON.stringify({ main: bundleFile, output: blob, disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }));
  sh(process.execPath, ['--experimental-sea-config', cfg]);
  return blob;
}

export async function inject(target, nodeBin, blob, outFile) {
  const { inject: postject } = require('postject');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.copyFileSync(nodeBin, outFile);
  fs.chmodSync(outFile, 0o755);
  const mac = TARGETS[target].platform === 'darwin';
  const canSign = mac && process.platform === 'darwin';
  if (canSign) sh('codesign', ['--remove-signature', outFile]);
  await postject(outFile, 'NODE_SEA_BLOB', fs.readFileSync(blob), { sentinelFuse: FUSE, ...(mac ? { machoSegmentName: 'NODE_SEA' } : {}) });
  if (canSign) sh('codesign', ['--sign', '-', outFile]);
  return { outFile, signed: !mac || canSign };
}

export async function pack(opts) {
  fs.mkdirSync(opts.out, { recursive: true });
  const bundleFile = await bundle(path.join(opts.out, 'kula-node.cjs'));
  log(`bundle ${path.relative(process.cwd(), bundleFile)} (${(fs.statSync(bundleFile).size / 1e6).toFixed(2)} MB)`);
  if (opts.bundleOnly) return [];
  if (opts.nodeVersion !== process.version) log(`warning: the blob is made by ${process.version} but the binaries are ${opts.nodeVersion}; use the same version`);
  const blob = await makeBlob(bundleFile, opts.out);
  const made = [];
  for (const target of opts.targets) {
    const nodeBin = await nodeBinaryFor(target, opts.nodeVersion, opts.cache);
    const outFile = path.join(opts.out, artifactName(target));
    const r = await inject(target, nodeBin, blob, outFile);
    const sum = sha256(outFile);
    made.push({ target, file: outFile, sha256: sum, signed: r.signed });
    log(`${path.basename(outFile)}  ${(fs.statSync(outFile).size / 1e6).toFixed(0)} MB  sha256 ${sum}${r.signed ? '' : '  (unsigned: run codesign --sign - on a mac)'}`);
    if (opts.smoke && target === hostTarget() && r.signed) {
      const v = sh(outFile, ['--version']).trim();
      if (!v.includes(pkg.version)) throw new Error(`smoke test: ${outFile} --version said "${v}"`);
      log(`smoke: ${v}`);
    }
  }
  fs.rmSync(blob, { force: true });
  fs.rmSync(path.join(opts.out, 'sea-config.json'), { force: true });
  const sums = made.map((m) => `${m.sha256}  ${path.basename(m.file)}`).join('\n') + '\n';
  fs.writeFileSync(path.join(opts.out, 'SHA256SUMS'), sums);
  console.log(JSON.stringify({ version: pkg.version, node: opts.nodeVersion, out: opts.out, made: made.map((m) => ({ ...m, file: path.basename(m.file) })) }));
  return made;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  pack(parseArgs(process.argv.slice(2))).catch((e) => { log(e.message); process.exit(1); });
}
