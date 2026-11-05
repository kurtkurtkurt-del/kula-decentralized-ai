import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import release from './fixtures/release-b11157.json' with { type: 'json' };
import { pickAsset, buildInstructions, parseSidecar } from '../src/assets.ts';
import { verifySidecar } from '../src/llama.ts';

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
  await verifySidecar(archive, null, (s) => logs.push(s));
  assert.match(logs[1], /no \.sha256 sidecar/);
  await assert.rejects(verifySidecar(archive, 'ff'.repeat(32), () => {}), /sha256 mismatch/);
  assert.equal(fs.existsSync(archive), false);
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
