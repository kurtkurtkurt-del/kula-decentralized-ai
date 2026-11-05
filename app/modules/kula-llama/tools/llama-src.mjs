#!/usr/bin/env node
// llama.cpp for kula-llama: one pinned upstream release, downloaded, checked and patched.
//
//   node tools/llama-src.mjs            fetch + unpack into android/src/main/cpp/llama.cpp (gitignored)
//   node tools/llama-src.mjs --host     also build Mac/Linux binaries (rpc-server, llama-server, llama-cli)
//                                       into ../../../.llama/host (used by the cluster tests and kula-node)
//   node tools/llama-src.mjs --check    exit 1 when the tree is missing or at another tag
//
// Why pinned: the cluster speaks ggml's RPC protocol, which only matches between identical versions.
// b11157 is what PrivateLM ships (RPC proto 7), so a PrivateLM worker can even join a kula cluster.
// The patches in tools/patches/ are PrivateLM's two log lines the worker uses to know when a master
// is connected. Never edit the unpacked tree by hand: change the tag or the patches here.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TAG = 'b11157';
const SHA256 = 'a3e6b30fd4dc2c65b560427a9f733f419fd48193c0e0fdc6b21e3464709f1c8c';
const URL = `https://github.com/ggml-org/llama.cpp/archive/refs/tags/${TAG}.tar.gz`;

const here = dirname(fileURLToPath(import.meta.url));
const moduleDir = resolve(here, '..');
const repoRoot = resolve(moduleDir, '../../..');
const cache = join(repoRoot, '.llama');
const tarball = join(cache, `${TAG}.tar.gz`);
const dest = join(moduleDir, 'android/src/main/cpp/llama.cpp');
const stamp = join(dest, '.kula-tag');
const hostOut = join(cache, 'host');

const args = new Set(process.argv.slice(2));
const sh = (cmd, a, opts = {}) => execFileSync(cmd, a, { stdio: 'inherit', ...opts });

function current() {
  return existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : null;
}

if (args.has('--check')) {
  if (current() !== TAG) {
    console.error(`kula-llama: llama.cpp is ${current() ?? 'missing'}, need ${TAG} (node tools/llama-src.mjs)`);
    process.exit(1);
  }
  process.exit(0);
}

if (current() !== TAG) {
  mkdirSync(cache, { recursive: true });
  if (!existsSync(tarball) || sha(tarball) !== SHA256) {
    console.log(`kula-llama: downloading llama.cpp ${TAG}`);
    sh('curl', ['-fL', '--retry', '3', '-o', tarball, URL]);
  }
  const got = sha(tarball);
  if (got !== SHA256) {
    rmSync(tarball);
    throw new Error(`kula-llama: ${TAG}.tar.gz sha256 ${got}, expected ${SHA256}`);
  }
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = join(cache, `unpack-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  sh('tar', ['xzf', tarball, '-C', tmp]);
  sh('mv', [join(tmp, `llama.cpp-${TAG}`), dest]);
  rmSync(tmp, { recursive: true, force: true });
  for (const p of ['privatelm-rpc-log.patch']) {
    sh('patch', ['-p1', '-s', '-i', join(here, 'patches', p)], { cwd: dest });
  }
  writeFileSync(stamp, `${TAG}\n`);
  console.log(`kula-llama: llama.cpp ${TAG} ready at ${dest}`);
} else {
  console.log(`kula-llama: llama.cpp ${TAG} already in place`);
}

if (args.has('--host')) {
  // Same tree, built for this computer. Metal on a Mac; RPC on so it can be a split-mode worker.
  const build = join(cache, `host-build-${TAG}`);
  mkdirSync(build, { recursive: true });
  sh('cmake', ['-S', dest, '-B', build, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', '-DGGML_RPC=ON',
    '-DLLAMA_BUILD_TESTS=OFF', '-DLLAMA_BUILD_EXAMPLES=OFF', '-DLLAMA_BUILD_SERVER=ON', '-DLLAMA_BUILD_TOOLS=ON', '-DLLAMA_CURL=OFF',
    '-DGGML_NATIVE=ON']);
  sh('cmake', ['--build', build, '--target', 'ggml-rpc-server', 'llama-server', 'llama-cli', '-j']);
  mkdirSync(hostOut, { recursive: true });
  for (const b of ['ggml-rpc-server', 'llama-server', 'llama-cli']) sh('cp', ['-f', join(build, 'bin', b), hostOut]);
  // the shared ggml/llama libs the binaries load
  sh('sh', ['-c', `cp -f ${build}/bin/*.dylib ${build}/bin/*.so ${hostOut} 2>/dev/null || true`]);
  writeFileSync(join(hostOut, '.kula-tag'), `${TAG}\n`);
  console.log(`kula-llama: host binaries in ${hostOut}`);
}

function sha(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}
