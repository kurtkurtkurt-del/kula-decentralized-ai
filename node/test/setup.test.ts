import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import release from './fixtures/release-b11157.json' with { type: 'json' };
import { pickAsset, buildInstructions, parseSidecar, digestSha256 } from '../src/assets.ts';
import { verifySidecar, planSetup, describePlan, placeCudaRuntime, tarProgram, SOURCE_SIZE, SOURCE_SHA256 } from '../src/llama.ts';
import { childEnv } from '../src/children.ts';
import { bar, progressBar } from '../src/progress.ts';

const fixture = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'release-b11157.json');

test('the setup plan names every file, its size and the total up front', async () => {
  const before = { home: process.env.KULA_NODE_HOME, rel: process.env.KULA_RELEASE_JSON, nv: process.env.KULA_NVIDIA };
  process.env.KULA_NODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-plan-'));
  process.env.KULA_RELEASE_JSON = fixture;
  try {
    process.env.KULA_NVIDIA = '0';
    const lin = await planSetup('linux', 'x64');
    assert.equal(lin.action, 'download');
    assert.deepEqual(lin.downloads.map((d) => d.name), ['llama-b11157-bin-ubuntu-x64.tar.gz']);
    assert.equal(lin.totalBytes, lin.downloads[0].size);
    process.env.KULA_NVIDIA = '1';
    const cuda = await planSetup('linux', 'x64');
    assert.equal(cuda.downloads.length, 2);
    assert.equal(cuda.totalBytes, cuda.downloads[0].size! + cuda.downloads[1].size!);
    const text = describePlan(cuda).join('\n');
    assert.match(text, /will download 2 files, [\d.]+ MB in total/);
    process.env.KULA_NVIDIA = '0';
    const win = await planSetup('win32', 'x64');
    assert.match(describePlan(win).join('\n'), /firewall/);
    const mac = await planSetup('darwin', 'arm64');
    assert.equal(mac.action, 'build');
    assert.equal(mac.totalBytes, SOURCE_SIZE);
    assert.equal(mac.downloads[0].sha256, SOURCE_SHA256);
    assert.match(describePlan(mac).join('\n'), /will download 1 file, 37\.6 MB in total/);
  } finally {
    fs.rmSync(process.env.KULA_NODE_HOME!, { recursive: true, force: true });
    for (const [k, v] of [['KULA_NODE_HOME', before.home], ['KULA_RELEASE_JSON', before.rel], ['KULA_NVIDIA', before.nv]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});

test('the progress bar', () => {
  assert.equal(bar(0, 100, 10), '[..........]   0%  0.0 / 0.0 MB');
  assert.equal(bar(5e6, 10e6, 10), '[#####.....]  50%  5.0 / 10.0 MB');
  assert.equal(bar(20e6, 10e6, 4), '[####] 100%  20.0 / 10.0 MB');
  assert.equal(bar(1.5e6, 0), '1.5 MB');
  // piped: a line per quarter, not one per chunk
  const lines: string[] = [];
  const p = progressBar('x', 100, { write: (s: string) => lines.push(s), isTTY: false });
  for (let i = 0; i <= 100; i += 5) p.update(i, 0);
  p.done();
  assert.equal(lines.length, 5);
  // a terminal: redrawn in place with \r, closed with a newline
  const tty: string[] = [];
  const q = progressBar('x', 0, { write: (s: string) => tty.push(s), isTTY: true });
  q.update(50, 100); q.update(100, 100); q.done();
  assert.ok(tty[0].startsWith('\r'));
  assert.equal(tty.at(-1), '\n');
});

const assets = release.assets;
const names = (p: ReturnType<typeof pickAsset>) => p && [p.asset.name, p.companion?.name ?? null];

test('pickAsset chooses from the recorded b11157 asset list', () => {
  assert.equal(assets.length, 35);
  assert.deepEqual(names(pickAsset('linux', 'x64', false, assets)), ['llama-b11157-bin-ubuntu-x64.tar.gz', null]);
  assert.deepEqual(names(pickAsset('linux', 'arm64', false, assets)), ['llama-b11157-bin-ubuntu-arm64.tar.gz', null]);
  assert.deepEqual(names(pickAsset('linux', 'x64', true, assets)), ['llama-b11157-bin-ubuntu-cuda-12.8-x64.tar.gz', 'cudart-llama-b11157-bin-ubuntu-cuda-12.8-x64.tar.gz']);
  assert.deepEqual(names(pickAsset('linux', 'arm64', true, assets)), ['llama-b11157-bin-ubuntu-cuda-13.4-arm64.tar.gz', 'cudart-llama-b11157-bin-ubuntu-cuda-13.4-arm64.tar.gz']);
  assert.deepEqual(names(pickAsset('win32', 'x64', false, assets)), ['llama-b11157-bin-win-cpu-x64.zip', null]);
  assert.deepEqual(names(pickAsset('win32', 'arm64', false, assets)), ['llama-b11157-bin-win-cpu-arm64.zip', null]);
  assert.deepEqual(names(pickAsset('win32', 'x64', true, assets)), ['llama-b11157-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip']);
  assert.deepEqual(names(pickAsset('win32', 'arm64', true, assets)), ['llama-b11157-bin-win-cuda-13.4-arm64.zip', 'cudart-llama-bin-win-cuda-13.4-arm64.zip']);
  assert.deepEqual(names(pickAsset('darwin', 'arm64', false, assets)), ['llama-b11157-bin-macos-arm64.tar.gz', null]);
  assert.deepEqual(names(pickAsset('darwin', 'x64', true, assets)), ['llama-b11157-bin-macos-x64.tar.gz', null]);
  // nothing for these; the snapdragon linux arm64 build is never a fallback
  assert.equal(pickAsset('linux', 's390x', false, assets)?.asset.name, 'llama-b11157-bin-ubuntu-s390x.tar.gz');
  assert.equal(pickAsset('freebsd', 'x64', false, assets), null);
  assert.equal(pickAsset('linux', 'arm64', false, assets.filter((a) => !/ubuntu-arm64/.test(a.name))), null);
  // a sidecar is picked up when the release has one
  const withSide = [...assets, { name: 'llama-b11157-bin-ubuntu-x64.tar.gz.sha256', browser_download_url: 'x' }];
  assert.equal(pickAsset('linux', 'x64', false, withSide)?.sidecar?.name, 'llama-b11157-bin-ubuntu-x64.tar.gz.sha256');
  assert.equal(pickAsset('linux', 'x64', false, assets)?.sidecar, null);
  const p = pickAsset('linux', 'x64', false, assets)!;
  assert.equal(p.asset.browser_download_url, 'https://github.com/ggml-org/llama.cpp/releases/download/b11157/llama-b11157-bin-ubuntu-x64.tar.gz');
});

test('the sidecar is parsed and enforced; a mismatch deletes the archive', async () => {
  assert.equal(parseSidecar('ab'.repeat(32) + '  llama.tar.gz\n'), 'ab'.repeat(32));
  assert.equal(parseSidecar('AB'.repeat(32)), 'ab'.repeat(32));
  assert.equal(parseSidecar('nothing here'), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-setup-'));
  const archive = path.join(dir, 'a.tar.gz');
  fs.writeFileSync(archive, 'not really an archive');
  const sum = createHash('sha256').update('not really an archive').digest('hex');
  const logs: string[] = [];
  await verifySidecar(archive, `${sum}  a.tar.gz\n`, (s) => logs.push(s));
  assert.deepEqual(logs, ['sha256 ok']);
  // no sidecar: github's digest is enough
  await verifySidecar(archive, null, (s) => logs.push(s), sum);
  assert.deepEqual(logs, ['sha256 ok', 'sha256 ok']);
  // both known: both must match
  await assert.rejects(verifySidecar(archive, `${sum}  a.tar.gz\n`, () => {}, 'ee'.repeat(32)), /sha256 mismatch/);
  assert.equal(fs.existsSync(archive), false);
  fs.writeFileSync(archive, 'not really an archive');
  await assert.rejects(verifySidecar(archive, 'ff'.repeat(32), () => {}), /sha256 mismatch/);
  assert.equal(fs.existsSync(archive), false);
  // nothing to check against: refused and deleted, never unpacked
  fs.writeFileSync(archive, 'not really an archive');
  await assert.rejects(verifySidecar(archive, null, () => {}), /no sha256 to check it against/);
  assert.equal(fs.existsSync(archive), false);
  assert.equal(digestSha256(`sha256:${'AB'.repeat(32)}`), 'ab'.repeat(32));
  assert.equal(digestSha256('md5:00'), null);
  assert.equal(digestSha256(undefined), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('build instructions name the exact commands for each os', () => {
  for (const os of ['linux', 'win32', 'darwin']) {
    const t = buildInstructions('b11157', os);
    assert.match(t, /git clone --depth 1 --branch b11157 https:\/\/github.com\/ggml-org\/llama.cpp/);
    assert.match(t, /cmake -B build -DGGML_RPC=ON -DLLAMA_BUILD_TOOLS=ON -DLLAMA_BUILD_SERVER=ON -DLLAMA_CURL=OFF/);
    assert.match(t, /cmake --build build --config Release --target ggml-rpc-server llama-server/);
    assert.match(t, /KULA_LLAMA_DIR/);
  }
  assert.match(buildInstructions('b11157', 'win32'), /visual studio|native tools/i);
  assert.match(buildInstructions('b11157', 'win32'), /set KULA_LLAMA_DIR=%CD%\\build\\bin\\Release/);
  assert.match(buildInstructions('b11157', 'linux'), /apt install/);
  assert.match(buildInstructions('b11157', 'darwin'), /brew install cmake/);
});

// the CUDA build unpacks as two siblings: bin/llama-<tag>/ and bin/cudart-.../ (D4)
function cudaTree(): { root: string; where: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-cudart-'));
  const where = path.join(root, 'llama-b11157');
  fs.mkdirSync(where);
  for (const n of ['llama-server', 'ggml-rpc-server']) fs.writeFileSync(path.join(where, n), n);
  const rt = path.join(root, 'cudart-x');
  fs.mkdirSync(rt);
  for (const n of ['libcudart.so.12', 'libcublas.so.12', 'libcublasLt.so.12']) fs.writeFileSync(path.join(rt, n), n);
  fs.symlinkSync('libcudart.so.12', path.join(rt, 'libcudart.so'));
  fs.mkdirSync(path.join(root, 'other'));
  fs.writeFileSync(path.join(root, 'other', 'keep.txt'), 'keep');
  return { root, where };
}

test('placeCudaRuntime moves the cudart files beside llama-server, once', () => {
  const { root, where } = cudaTree();
  try {
    const moved = placeCudaRuntime(root, where);
    assert.deepEqual(moved, ['libcublas.so.12', 'libcublasLt.so.12', 'libcudart.so', 'libcudart.so.12']);
    for (const n of moved) assert.ok(fs.existsSync(path.join(where, n)), n);
    const link = path.join(where, 'libcudart.so');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.readFileSync(link, 'utf8'), 'libcudart.so.12');
    assert.equal(fs.existsSync(path.join(root, 'cudart-x')), false);
    assert.equal(fs.readFileSync(path.join(root, 'other', 'keep.txt'), 'utf8'), 'keep');
    assert.equal(fs.readFileSync(path.join(where, 'llama-server'), 'utf8'), 'llama-server');
    assert.deepEqual(placeCudaRuntime(root, where), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('placeCudaRuntime: a flat layout and a missing root move nothing; an existing name is kept', () => {
  const flat = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-cudart-flat-'));
  const { root, where } = cudaTree();
  try {
    for (const n of ['llama-server', 'ggml-rpc-server', 'libcudart.so.12']) fs.writeFileSync(path.join(flat, n), n);
    assert.deepEqual(placeCudaRuntime(flat, flat), []);
    assert.deepEqual(fs.readdirSync(flat).sort(), ['ggml-rpc-server', 'libcudart.so.12', 'llama-server']);
    assert.deepEqual(placeCudaRuntime(path.join(flat, 'nope'), flat), []);
    // where inside a cudart-* directory: that one is skipped
    const inner = path.join(root, 'cudart-x');
    assert.deepEqual(placeCudaRuntime(root, inner), []);
    assert.ok(fs.existsSync(path.join(inner, 'libcudart.so.12')));
    fs.writeFileSync(path.join(where, 'libcublas.so.12'), 'already here');
    const moved = placeCudaRuntime(root, where);
    assert.deepEqual(moved, ['libcublasLt.so.12', 'libcudart.so', 'libcudart.so.12']);
    assert.equal(fs.readFileSync(path.join(where, 'libcublas.so.12'), 'utf8'), 'already here');
    assert.equal(fs.existsSync(path.join(root, 'cudart-x')), false);
  } finally {
    fs.rmSync(flat, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('childEnv: linux puts the program folder first on LD_LIBRARY_PATH, elsewhere the env is unchanged', () => {
  const env = { PATH: '/usr/bin', LD_LIBRARY_PATH: '/opt/x' };
  assert.deepEqual(childEnv('/h/bin/llama-b11157/llama-server', 'linux', env), { PATH: '/usr/bin', LD_LIBRARY_PATH: '/h/bin/llama-b11157:/opt/x' });
  assert.equal(childEnv('/h/bin/llama-b11157/llama-server', 'linux', { PATH: '/usr/bin' }).LD_LIBRARY_PATH, '/h/bin/llama-b11157');
  assert.equal(env.LD_LIBRARY_PATH, '/opt/x');
  assert.equal(childEnv('/h/bin/llama-server', 'darwin', env), env);
  assert.equal(childEnv('C:\\h\\llama-server.exe', 'win32', env), env);
});

test('tarProgram: windows takes the system tar.exe, not the first tar on the PATH; elsewhere tar', () => {
  assert.equal(tarProgram('win32', { SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\tar.exe');
  assert.equal(tarProgram('win32', {}), 'C:\\Windows\\System32\\tar.exe');
  assert.equal(tarProgram('linux', { SystemRoot: 'D:\\Win' }), 'tar');
  assert.equal(tarProgram('darwin', {}), 'tar');
});
