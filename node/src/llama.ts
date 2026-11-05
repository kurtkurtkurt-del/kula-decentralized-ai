// Finding or producing the two llama.cpp programs the worker runs:
// ggml-rpc-server (the split mode) and llama-server (the apart mode). Pinned
// to one release so every device in a cluster speaks the same rpc protocol.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { home, repoRoots } from './paths.js';
import { download } from './download.js';
import { pickAsset, buildInstructions as instructionsFor, parseSidecar, type Asset } from './assets.js';
import { bar, mb } from './progress.js';

export const TAG = 'b11157';
export const SOURCE_URL = `https://github.com/ggml-org/llama.cpp/archive/refs/tags/${TAG}.tar.gz`;
export const SOURCE_SHA256 = 'a3e6b30fd4dc2c65b560427a9f733f419fd48193c0e0fdc6b21e3464709f1c8c';
const RELEASE_API = `https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${TAG}`;

export interface LlamaBinaries {
  rpcServer: string;
  llamaServer: string;
  where: string;
}

const exe = process.platform === 'win32' ? '.exe' : '';
const RPC_NAMES = [`ggml-rpc-server${exe}`, `rpc-server${exe}`, `llama-rpc-server${exe}`];
const SERVER_NAMES = [`llama-server${exe}`];

export function cacheDir(): string {
  return path.join(home(), `llama-${TAG}`);
}

function firstExisting(dir: string, names: string[]): string | null {
  for (const n of names) {
    const p = path.join(dir, n);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Looks for both programs in one folder.
function binariesIn(dir: string): LlamaBinaries | null {
  if (!fs.existsSync(dir)) return null;
  const rpcServer = firstExisting(dir, RPC_NAMES);
  const llamaServer = firstExisting(dir, SERVER_NAMES);
  if (rpcServer && llamaServer) return { rpcServer, llamaServer, where: dir };
  return null;
}

// Walks a tree (a few levels) for the programs, for unpacked release archives.
function binariesUnder(root: string, depth = 3): LlamaBinaries | null {
  const direct = binariesIn(root);
  if (direct) return direct;
  if (depth === 0 || !fs.existsSync(root)) return null;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const found = binariesUnder(path.join(root, e.name), depth - 1);
    if (found) return found;
  }
  return null;
}

// Where to look, in order: a build next to the repository, then our cache.
export function candidates(): string[] {
  const list: string[] = [];
  if (process.env.KULA_LLAMA_DIR) list.push(process.env.KULA_LLAMA_DIR);
  for (const r of repoRoots()) list.push(path.join(r, '.llama', 'host'));
  list.push(path.join(cacheDir(), 'build', 'bin'));
  list.push(path.join(cacheDir(), 'bin'));
  return list;
}

export function findLlama(): LlamaBinaries | null {
  for (const dir of candidates()) {
    const found = binariesUnder(dir, 2);
    if (found) return found;
  }
  return null;
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

function run(cmd: string, args: string[], cwd: string, log: (s: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    log(`$ ${cmd} ${args.join(' ')}`);
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

function have(cmd: string): boolean {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return !r.error;
}

export function buildInstructions(platform: string = process.platform): string {
  return instructionsFor(TAG, platform);
}

// macOS: build from the pinned source tarball.
async function buildFromSource(log: (s: string) => void): Promise<LlamaBinaries> {
  if (!have('cmake')) throw new Error('cmake is missing (brew install cmake ninja)\n' + buildInstructions());
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const tarball = path.join(dir, `${TAG}.tar.gz`);
  if (!fs.existsSync(tarball) || (await sha256File(tarball)) !== SOURCE_SHA256) {
    log(`downloading ${SOURCE_URL}`);
    await download(SOURCE_URL, tarball, bar(`  ${TAG}.tar.gz`));
    const sum = await sha256File(tarball);
    if (sum !== SOURCE_SHA256) {
      fs.rmSync(tarball);
      throw new Error(`source tarball sha256 mismatch: got ${sum}, want ${SOURCE_SHA256}`);
    }
  }
  const src = path.join(dir, 'src');
  if (!fs.existsSync(path.join(src, 'CMakeLists.txt'))) {
    fs.rmSync(src, { recursive: true, force: true });
    fs.mkdirSync(src, { recursive: true });
    await run('tar', ['-xzf', tarball, '--strip-components=1', '-C', src], dir, log);
  }
  const build = path.join(dir, 'build');
  const gen = have('ninja') ? ['-G', 'Ninja'] : [];
  await run('cmake', ['-S', src, '-B', build, ...gen, '-DCMAKE_BUILD_TYPE=Release', '-DGGML_RPC=ON', '-DLLAMA_BUILD_TOOLS=ON', '-DLLAMA_BUILD_SERVER=ON', '-DLLAMA_CURL=OFF', '-DLLAMA_BUILD_TESTS=OFF', '-DLLAMA_BUILD_EXAMPLES=OFF'], dir, log);
  await run('cmake', ['--build', build, '--config', 'Release', '--target', 'ggml-rpc-server', 'llama-server', '-j', String(os.cpus().length)], dir, log);
  const found = binariesUnder(build, 3);
  if (!found) throw new Error(`built, but could not find the programs under ${build}`);
  return found;
}

export function hasNvidia(): boolean {
  if (process.env.KULA_NVIDIA === '0') return false;
  if (process.env.KULA_NVIDIA === '1') return true;
  const r = spawnSync('nvidia-smi', ['-L'], { stdio: 'ignore', timeout: 5000 });
  return !r.error && r.status === 0;
}

// KULA_RELEASE_JSON names a saved copy of the release api answer, for an
// offline dry run (the test fixture is one).
export async function fetchRelease(): Promise<Asset[]> {
  if (process.env.KULA_RELEASE_JSON) return (JSON.parse(fs.readFileSync(process.env.KULA_RELEASE_JSON, 'utf8')) as { assets: Asset[] }).assets;
  const res = await fetch(RELEASE_API, { headers: { 'user-agent': 'kula-node', accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`github api: ${res.status}\n` + buildInstructions());
  const rel = (await res.json()) as { assets: Asset[] };
  return rel.assets;
}

async function fetchArchive(asset: Asset, sidecar: Asset | null, dir: string, log: (s: string) => void): Promise<string> {
  const archive = path.join(dir, asset.name);
  if (!fs.existsSync(archive)) {
    log(`downloading ${asset.browser_download_url}`);
    await download(asset.browser_download_url, archive, bar(`  ${asset.name}`));
  }
  await verifySidecar(archive, sidecar ? await (await fetch(sidecar.browser_download_url)).text() : null, log);
  return archive;
}

// The sidecar is optional in these releases; when it exists the archive must match it.
export async function verifySidecar(archive: string, sidecarText: string | null, log: (s: string) => void): Promise<void> {
  if (sidecarText === null) { log(`no .sha256 sidecar for ${path.basename(archive)}; skipping the check`); return; }
  const want = parseSidecar(sidecarText);
  if (!want) throw new Error(`${path.basename(archive)}.sha256 holds no sha256`);
  const got = await sha256File(archive);
  if (got !== want) { fs.rmSync(archive); throw new Error(`${path.basename(archive)}: sha256 mismatch (got ${got}, want ${want}); the file was deleted, run setup again`); }
  log('sha256 ok');
}

// What the last setup decided, for --json.
export interface SetupPlan { platform: string; arch: string; nvidia: boolean; asset: string; companion: string | null; sidecar: boolean; totalBytes: number; dest: string; urls: string[] }
let lastPlan: SetupPlan | null = null;
export const setupPlan = (): SetupPlan | null => lastPlan;

// Linux and Windows: a release archive of the same tag.
async function downloadRelease(log: (s: string) => void, dryRun: boolean): Promise<LlamaBinaries | null> {
  log(`looking up release ${TAG}`);
  const assets = await fetchRelease();
  const nvidia = hasNvidia();
  const pick = pickAsset(process.platform, os.arch(), nvidia, assets);
  if (!pick) throw new Error(`no release asset for ${process.platform}/${os.arch()} in ${TAG}; assets: ${assets.map((a) => a.name).join(', ')}\n` + buildInstructions());
  const size = (a: Asset) => (a.size ? ` (${mb(a.size)} MB)` : '');
  log(`${pick.asset.name}${size(pick.asset)}: ${pick.why}`);
  if (pick.companion) log(`${pick.companion.name}${size(pick.companion)}: the cuda runtime it needs`);
  const total = (pick.asset.size ?? 0) + (pick.companion?.size ?? 0);
  if (total) log(`total download: ${mb(total)} MB`);
  log(pick.sidecar ? 'sha256: checked against the .sha256 sidecar' : 'sha256: this asset has no .sha256 sidecar');
  lastPlan = { platform: process.platform, arch: os.arch(), nvidia, asset: pick.asset.name, companion: pick.companion?.name ?? null, sidecar: !!pick.sidecar, totalBytes: total, dest: path.join(cacheDir(), 'bin'), urls: [pick.asset.browser_download_url, ...(pick.companion ? [pick.companion.browser_download_url] : [])] };
  if (dryRun) {
    log(`would download to ${cacheDir()} and unpack into ${path.join(cacheDir(), 'bin')}`);
    log(`  ${pick.asset.browser_download_url}`);
    if (pick.companion) log(`  ${pick.companion.browser_download_url}`);
    return null;
  }
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const archive = await fetchArchive(pick.asset, pick.sidecar, dir, log);
  const companion = pick.companion ? await fetchArchive(pick.companion, assets.find((a) => a.name === `${pick.companion!.name}.sha256`) ?? null, dir, log) : null;
  const out = path.join(dir, 'bin');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  // tar reads zip too (bsdtar on windows 10+ and macOS; gnu tar on linux only
  // handles .tar.gz, and those are what linux gets)
  await run('tar', ['-xf', archive, '-C', out], dir, log);
  if (companion) await run('tar', ['-xf', companion, '-C', out], dir, log);
  const found = binariesUnder(out, 3);
  if (!found) {
    const rpc = RPC_NAMES.join(' or ');
    throw new Error(`the archive ${pick.asset.name} has no ${rpc} inside (or no llama-server).\n` + buildInstructions());
  }
  return found;
}

export async function setup(opts: { check?: boolean; dryRun?: boolean; log?: (s: string) => void } = {}): Promise<LlamaBinaries | null> {
  const log = opts.log ?? ((s) => console.log(s));
  const found = findLlama();
  if (found) {
    log(`llama.cpp ${TAG}: ${found.where}`);
    log(`  ${path.basename(found.rpcServer)}, ${path.basename(found.llamaServer)}`);
    return found;
  }
  if (opts.check) {
    log(`llama.cpp ${TAG} not found. looked in:`);
    for (const c of candidates()) log(`  ${c}`);
    log('run: kula-node setup');
    return null;
  }
  if (process.platform === 'darwin') {
    if (opts.dryRun) { log(`would download ${SOURCE_URL} (sha256 ${SOURCE_SHA256}) and build it under ${cacheDir()}`); return null; }
    const got = await buildFromSource(log);
    log(`ready: ${got.where}`);
    return got;
  }
  const got = await downloadRelease(log, opts.dryRun === true);
  if (got) log(`ready: ${got.where}`);
  return got;
}
