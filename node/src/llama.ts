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

export function buildInstructions(): string {
  return [
    `build llama.cpp ${TAG} yourself (needs git, cmake and a C++ compiler):`,
    `  git clone --depth 1 --branch ${TAG} https://github.com/ggml-org/llama.cpp`,
    `  cd llama.cpp`,
    `  cmake -B build -DGGML_RPC=ON -DLLAMA_BUILD_TOOLS=ON -DLLAMA_BUILD_SERVER=ON -DLLAMA_CURL=OFF`,
    `  cmake --build build --config Release --target ggml-rpc-server llama-server`,
    `then point kula-node at the result: KULA_LLAMA_DIR=<llama.cpp>/build/bin kula-node share`,
  ].join('\n');
}

// macOS: build from the pinned source tarball.
async function buildFromSource(log: (s: string) => void): Promise<LlamaBinaries> {
  if (!have('cmake')) throw new Error('cmake is missing (brew install cmake ninja)\n' + buildInstructions());
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const tarball = path.join(dir, `${TAG}.tar.gz`);
  if (!fs.existsSync(tarball) || (await sha256File(tarball)) !== SOURCE_SHA256) {
    log(`downloading ${SOURCE_URL}`);
    await download(SOURCE_URL, tarball, (got, total) => process.stdout.write(`\r  ${(got / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`));
    process.stdout.write('\n');
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

function assetFor(names: string[]): string | null {
  const arch = os.arch() === 'arm64' ? 'arm64' : os.arch() === 'x64' ? 'x64' : os.arch();
  const prefer = process.platform === 'win32'
    ? [`bin-win-cpu-${arch}.zip`, `bin-win-${arch}.zip`]
    : process.platform === 'linux'
      ? [`bin-ubuntu-${arch}.tar.gz`, `bin-linux-${arch}.tar.gz`]
      : [`bin-macos-${arch}.tar.gz`];
  for (const suffix of prefer) {
    const hit = names.find((n) => n.endsWith(suffix) && !/snapdragon/.test(n));
    if (hit) return hit;
  }
  return null;
}

// Linux and Windows: a release archive of the same tag.
async function downloadRelease(log: (s: string) => void): Promise<LlamaBinaries> {
  log(`looking up release ${TAG}`);
  const res = await fetch(RELEASE_API, { headers: { 'user-agent': 'kula-node', accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`github api: ${res.status}\n` + buildInstructions());
  const rel = (await res.json()) as { assets: { name: string; browser_download_url: string }[] };
  const names = rel.assets.map((a) => a.name);
  const name = assetFor(names);
  if (!name) throw new Error(`no release asset for ${process.platform}/${os.arch()} in ${TAG}; assets: ${names.join(', ')}\n` + buildInstructions());
  const asset = rel.assets.find((a) => a.name === name)!;
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, name);
  if (!fs.existsSync(archive)) {
    log(`downloading ${asset.browser_download_url}`);
    await download(asset.browser_download_url, archive, (got, total) => process.stdout.write(`\r  ${(got / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`));
    process.stdout.write('\n');
  }
  // the sidecar is optional in these releases; when it exists it is checked
  const side = rel.assets.find((a) => a.name === `${name}.sha256`);
  if (side) {
    const want = (await (await fetch(side.browser_download_url)).text()).trim().split(/\s+/)[0].toLowerCase();
    const got = await sha256File(archive);
    if (got !== want) { fs.rmSync(archive); throw new Error(`${name}: sha256 mismatch (got ${got}, want ${want})`); }
    log('sha256 ok');
  } else {
    log('no .sha256 sidecar for this asset; skipping the check');
  }
  const out = path.join(dir, 'bin');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  // tar reads zip too (bsdtar on windows 10+ and macOS; gnu tar on linux only
  // handles .tar.gz, and those are what linux gets)
  await run('tar', ['-xf', archive, '-C', out], dir, log);
  const found = binariesUnder(out, 3);
  if (!found) {
    const rpc = RPC_NAMES.join(' or ');
    throw new Error(`the archive ${name} has no ${rpc} inside (or no llama-server).\n` + buildInstructions());
  }
  return found;
}

export async function setup(opts: { check?: boolean; log?: (s: string) => void } = {}): Promise<LlamaBinaries | null> {
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
  const got = process.platform === 'darwin' ? await buildFromSource(log) : await downloadRelease(log);
  log(`ready: ${got.where}`);
  return got;
}
