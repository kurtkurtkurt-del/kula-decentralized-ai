// install.sh against a fake release server: it installs when the hash matches
// and leaves nothing behind when it does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const script = new URL('../../install.sh', import.meta.url).pathname;
const haveSh = !spawnSync('sh', ['-c', 'true']).error;

async function serve(files: Record<string, string | Buffer>): Promise<{ url: string; close: () => void }> {
  const srv = http.createServer((req, res) => {
    const body = files[req.url ?? ''];
    if (body === undefined) { res.statusCode = 404; res.end('no'); return; }
    res.end(body);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

// async, because the fake server lives in this process and a sync spawn would
// block the event loop it answers from
function runInstall(base: string, binDir: string, extra: Record<string, string> = {}): Promise<{ status: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn('sh', [script], { env: { ...process.env, KULA_BASE_URL: base, KULA_BIN_DIR: binDir, KULA_VERSION: '9.9.9', ...extra } });
    let stdout = ''; let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('error', reject);
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const target = `${process.platform === 'darwin' ? 'mac' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const name = `kula-node-9.9.9-${target}`;
const fakeBin = '#!/bin/sh\necho kula-node 9.9.9 fake\n';
const sum = createHash('sha256').update(fakeBin).digest('hex');

test('install.sh fetches, checks the sha256, installs and mentions PATH', { skip: haveSh && process.platform !== 'win32' ? false : 'needs sh' }, async () => {
  const s = await serve({ [`/${name}`]: fakeBin, '/SHA256SUMS': `${sum}  ${name}\n${'ab'.repeat(32)}  kula-node-9.9.9-win-x64.exe\n` });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-inst-'));
  const bin = path.join(dir, 'bin');
  try {
    const r = await runInstall(s.url, bin, { PATH: `/usr/bin:/bin:/usr/local/bin` });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /sha256 ok/);
    assert.match(r.stderr, /installed .*kula-node/);
    assert.match(r.stderr, /not on your PATH/);
    const installed = path.join(bin, 'kula-node');
    assert.equal(fs.readFileSync(installed, 'utf8'), fakeBin);
    assert.ok(fs.statSync(installed).mode & 0o100, 'executable');
    assert.equal(spawnSync(installed, { encoding: 'utf8' }).stdout.trim(), 'kula-node 9.9.9 fake');
    // on the PATH already: no note
    const r2 = await runInstall(s.url, bin, { PATH: `${bin}:/usr/bin:/bin` });
    assert.equal(r2.status, 0);
    assert.doesNotMatch(r2.stderr, /not on your PATH/);
  } finally { s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('install.sh stops on a sha256 mismatch and on a missing entry; nothing is installed', { skip: haveSh && process.platform !== 'win32' ? false : 'needs sh' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-inst-'));
  const bin = path.join(dir, 'bin');
  const tampered = await serve({ [`/${name}`]: fakeBin + 'echo extra\n', '/SHA256SUMS': `${sum}  ${name}\n` });
  try {
    const r = await runInstall(tampered.url, bin);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /sha256 mismatch/);
    assert.match(r.stderr, /nothing was installed/);
    assert.equal(fs.existsSync(path.join(bin, 'kula-node')), false);
  } finally { tampered.close(); }
  const unlisted = await serve({ [`/${name}`]: fakeBin, '/SHA256SUMS': `${sum}  somebody-else\n` });
  try {
    const r = await runInstall(unlisted.url, bin);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not listed in SHA256SUMS/);
    assert.equal(fs.existsSync(path.join(bin, 'kula-node')), false);
  } finally { unlisted.close(); }
  const noSums = await serve({ [`/${name}`]: fakeBin });
  try {
    const r = await runInstall(noSums.url, bin);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /no SHA256SUMS/);
  } finally { noSums.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
