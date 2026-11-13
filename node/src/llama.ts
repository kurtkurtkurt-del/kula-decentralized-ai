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
import { pickAsset, buildInstructions as instructionsFor, parseSidecar, digestSha256, type Asset } from './assets.js';
import { progressBar, mb } from './progress.js';

export const TAG = 'b11157';
export const SOURCE_URL = `https://github.com/ggml-org/llama.cpp/archive/refs/tags/${TAG}.tar.gz`;
export const SOURCE_SHA256 = 'a3e6b30fd4dc2c65b560427a9f733f419fd48193c0e0fdc6b21e3464709f1c8c';
// github sends the source tarball chunked, without a length; this is its size
export const SOURCE_SIZE = 37563218;
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

// The CUDA build's runtime comes in its own archive with its own top folder
// (cudart-llama-<tag>-bin-...), a sibling of llama-<tag>/, where the loader does not
// look. Moves every file and symlink of each cudart-* directory directly under root
// into where (an existing name there is kept, the source dropped), removes that
// directory and returns the moved names, sorted. A cudart-* directory that is where
// or contains it is skipped; nothing else is touched. No root, nothing to move: [].
export function placeCudaRuntime(root: string, where: string): string[] {
  if (!fs.existsSync(root)) return [];
  const target = path.resolve(where);
  const inside = (dir: string, p: string) => {
    const rel = path.relative(dir, p);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const exists = (p: string) => { try { fs.lstatSync(p); return true; } catch { return false; } };
  const moved: string[] = [];
  const drain = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const from = path.join(dir, e.name);
      if (e.isDirectory()) { drain(from); continue; }
      const to = path.join(target, e.name);
      if (exists(to)) { fs.rmSync(from, { force: true }); continue; }
      fs.renameSync(from, to);
      moved.push(e.name);
    }
  };
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith('cudart-')) continue;
    const dir = path.resolve(root, e.name);
    if (inside(dir, target)) continue;
    drain(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return moved.sort();
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
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`))));
  });
}

function have(cmd: string): boolean {
  const r = spawnSync(cmd, ['--version'], { stdio: 'ignore', windowsHide: true });
  return !r.error;
}

export function buildInstructions(platform: string = process.platform): string {
  return instructionsFor(TAG, platform);
}

type Log = (s: string) => void;

// One file setup fetches: where from, how big, which sha256 it must have.
export interface PlannedDownload {
  name: string;
  url: string;
  size: number | null;
  // the expected sha256 when known up front (pinned or github's digest); a
  // .sha256 sidecar, when the release has one, is fetched and checked as well
  sha256: string | null;
  sidecar: string | null;
  cached: boolean;
  why: string;
}

export interface SetupPlan {
  tag: string;
  platform: string;
  arch: string;
  action: 'build' | 'download';
  dest: string;
  downloads: PlannedDownload[];
  // bytes still to fetch (cached files left out); null when a size is unknown
  totalBytes: number | null;
  notes: string[];
}

// What setup would do on this machine, without doing it.
export async function planSetup(platform: string = process.platform, arch: string = os.arch()): Promise<SetupPlan> {
  const dir = cacheDir();
  if (platform === 'darwin') {
    const tarball = path.join(dir, `${TAG}.tar.gz`);
    const cached = fs.existsSync(tarball) && (await sha256File(tarball)) === SOURCE_SHA256;
    return {
      tag: TAG, platform, arch, action: 'build', dest: path.join(dir, 'build', 'bin'),
      downloads: [{ name: `${TAG}.tar.gz`, url: SOURCE_URL, size: SOURCE_SIZE, sha256: SOURCE_SHA256, sidecar: null, cached, why: 'the pinned source, built here with cmake' }],
      totalBytes: cached ? 0 : SOURCE_SIZE,
      notes: ['then ggml-rpc-server and llama-server are built with cmake (needs: brew install cmake ninja; a few minutes)'],
    };
  }
  const assets = await fetchRelease();
  const nvidia = hasNvidia();
  const pick = pickAsset(platform, arch, nvidia, assets);
  if (!pick) throw new Error(`no release asset for ${platform}/${arch} in ${TAG}; assets: ${assets.map((a) => a.name).join(', ')}\n` + buildInstructions(platform));
  const entry = (a: Asset, side: Asset | null, why: string): PlannedDownload => ({
    name: a.name, url: a.browser_download_url, size: a.size ?? null, sha256: digestSha256(a.digest),
    sidecar: side?.browser_download_url ?? null, cached: false, why,
  });
  const downloads = [entry(pick.asset, pick.sidecar, pick.why)];
  if (pick.companion) downloads.push(entry(pick.companion, assets.find((a) => a.name === `${pick.companion!.name}.sha256`) ?? null, 'the cuda runtime it needs'));
  const unknown = downloads.some((d) => d.size == null);
  const notes = [`unpacked into ${path.join(dir, 'bin')}`];
  if (platform === 'win32') notes.push(WINDOWS_FIREWALL_NOTE);
  return {
    tag: TAG, platform, arch, action: 'download', dest: path.join(dir, 'bin'), downloads,
    totalBytes: unknown ? null : downloads.reduce((n, d) => n + (d.size ?? 0), 0),
    notes,
  };
}

export const WINDOWS_FIREWALL_NOTE =
  'windows: when kula first opens itself to your network (kula-node share; in the app, "invite a device" or loading a file of this computer onto a phone), windows defender firewall asks about it (named kula or kula-node); allow it on private networks only (that is your home wi-fi), never public';

export function describePlan(p: SetupPlan): string[] {
  const todo = p.downloads.filter((d) => !d.cached);
  const lines = [`llama.cpp ${p.tag} for ${p.platform}/${p.arch}:`];
  lines.push(todo.length === 0
    ? '  nothing to download (already here)'
    : `  will download ${todo.length} file${todo.length > 1 ? 's' : ''}, ${p.totalBytes == null ? 'size unknown' : mb(p.totalBytes)} in total`);
  for (const d of p.downloads) {
    lines.push(`  ${d.name}  ${d.size != null ? mb(d.size) : '? MB'}${d.cached ? '  (already downloaded)' : ''}  ${d.why}`);
    lines.push(`    ${d.url}`);
    lines.push(`    sha256 ${d.sha256 ?? (d.sidecar ? 'from the .sha256 sidecar' : 'NOT KNOWN: setup will refuse it')}`);
  }
  for (const n of p.notes) lines.push(`  ${n}`);
  return lines;
}

// Fetches one planned file into dir and checks it; returns the local path.
async function fetchChecked(d: PlannedDownload, dir: string, log: Log): Promise<string> {
  const file = path.join(dir, d.name);
  if (!d.cached || !fs.existsSync(file)) {
    log(`downloading ${d.name}`);
    const bar = progressBar(d.name.length > 28 ? `${d.name.slice(0, 25)}...` : d.name, d.size ?? 0);
    try { await download(d.url, file, bar.update); } finally { bar.done(); }
  }
  const sidecarText = d.sidecar ? await (await fetch(d.sidecar)).text() : null;
  await verifySidecar(file, sidecarText, log, d.sha256);
  return file;
}

// The archive must match every sha256 we know for it: the .sha256 sidecar and
// the expected value (pinned, or github's digest). With neither, it is refused.
export async function verifySidecar(archive: string, sidecarText: string | null, log: Log, expected: string | null = null): Promise<void> {
  const wants: string[] = [];
  if (sidecarText !== null) {
    const w = parseSidecar(sidecarText);
    if (!w) throw new Error(`${path.basename(archive)}.sha256 holds no sha256`);
    wants.push(w);
  }
  if (expected) wants.push(expected.toLowerCase());
  if (!wants.length) {
    fs.rmSync(archive, { force: true });
    throw new Error(`${path.basename(archive)}: no sha256 to check it against (no .sha256 sidecar, no digest from github); refusing to use it`);
  }
  const got = await sha256File(archive);
  for (const want of wants) {
    if (got !== want) { fs.rmSync(archive); throw new Error(`${path.basename(archive)}: sha256 mismatch (got ${got}, want ${want}); the file was deleted, run setup again`); }
  }
  log('sha256 ok');
}

// macOS: build from the pinned source tarball.
async function buildFromSource(plan: SetupPlan, log: Log): Promise<LlamaBinaries> {
  if (!have('cmake')) throw new Error('cmake is missing (brew install cmake ninja)\n' + buildInstructions());
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const tarball = await fetchChecked(plan.downloads[0], dir, log);
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
  const r = spawnSync('nvidia-smi', ['-L'], { stdio: 'ignore', timeout: 5000, windowsHide: true });
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

// On windows the tar of the system (bsdtar, reads zip), not whichever tar comes
// first on the PATH (git's gnu tar does not read zip).
export function tarProgram(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform !== 'win32') return 'tar';
  return path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
}

// Linux and Windows: a release archive of the same tag.
async function downloadRelease(plan: SetupPlan, log: Log): Promise<LlamaBinaries> {
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const files: string[] = [];
  for (const d of plan.downloads) files.push(await fetchChecked(d, dir, log));
  const out = path.join(dir, 'bin');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  // tar reads zip too (bsdtar on windows 10+ and macOS; gnu tar on linux only
  // handles .tar.gz, and those are what linux gets)
  const tar = tarProgram();
  for (const f of files) await run(tar, ['-xf', f, '-C', out], dir, log);
  const found = binariesUnder(out, 3);
  if (!found) {
    const rpc = RPC_NAMES.join(' or ');
    throw new Error(`the archive ${plan.downloads[0].name} has no ${rpc} inside (or no llama-server).\n` + buildInstructions());
  }
  const placed = placeCudaRuntime(out, found.where);
  log(`cuda runtime: ${placed.length} files placed beside llama-server`);
  return found;
}

export async function setup(opts: { check?: boolean; dryRun?: boolean; log?: Log } = {}): Promise<LlamaBinaries | null> {
  const log = opts.log ?? ((s) => console.log(s));
  const found = findLlama();
  if (found) {
    // a home set up before the runtime was placed: move it now (also for --check, which the app runs on every start)
    const bin = path.join(cacheDir(), 'bin');
    const rel = path.relative(bin, found.where);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      try {
        const moved = placeCudaRuntime(bin, found.where);
        if (moved.length > 0) log(`cuda runtime: ${moved.length} files moved beside llama-server`);
      } catch (e) {
        log(`cuda runtime: could not move it beside llama-server: ${(e as Error).message}`);
      }
    }
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
  if (process.platform !== 'darwin') log(`looking up release ${TAG}`);
  const plan = await planSetup();
  for (const l of describePlan(plan)) log(l);
  if (opts.dryRun) return null;
  const got = plan.action === 'build' ? await buildFromSource(plan, log) : await downloadRelease(plan, log);
  log(`ready: ${got.where}`);
  if (process.platform === 'win32') log(WINDOWS_FIREWALL_NOTE);
  return got;
}
