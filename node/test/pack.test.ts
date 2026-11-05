// The single-binary packaging: install.sh against a fake release server, the
// .deb / homebrew / winget files, and (when tools/pack.mjs has run here) the
// packed binary itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  NODE_DIR, TARGETS, binaryName, hostTarget, nodeAsset, parseSums, formatSums, makeDeb, readAr, readTarGz, renderFormula, renderWinget, readVersion,
} from '../tools/packlib.mjs';

const ROOT = path.dirname(NODE_DIR);
const INSTALL_SH = path.join(ROOT, 'packaging', 'install.sh');
const hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const unix = process.platform !== 'win32';

// A release server on 127.0.0.1 serving `files`; counts what was asked for.
async function fakeRelease(files: Record<string, Buffer | string>) {
  const asked: string[] = [];
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? '/').replace(/^\/v\/[^/]+\//, '').replace(/^\//, ''));
    asked.push(name);
    const body = files[name];
    if (body === undefined) { res.writeHead(404).end('no'); return; }
    res.writeHead(200, { 'content-length': Buffer.byteLength(body) }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}/v/0.1.0`, asked, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function runInstall(env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn('sh', [INSTALL_SH], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}

const FAKE = '#!/bin/sh\necho "kula-node 9.9.9 (fake)"\n';
const UNIX_NAMES = Object.keys(TARGETS).filter((t) => TARGETS[t].platform !== 'win32').map(binaryName);

test('install.sh: downloads, checks the sha256, installs into the bin dir', { skip: !unix }, async () => {
  const files: Record<string, string> = { 'sha256sums.txt': formatSums(new Map(UNIX_NAMES.map((n) => [n, hex(FAKE)]))) };
  for (const n of UNIX_NAMES) files[n] = FAKE;
  const srv = await fakeRelease(files);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-inst-'));
  try {
    const bin = path.join(home, 'bin');
    const r = await runInstall({ HOME: home, KULA_NODE_BASE_URL: srv.base, KULA_NODE_BIN_DIR: bin, SHELL: '/bin/zsh' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /sha256 ok/);
    assert.match(r.out, /kula-node 9\.9\.9 \(fake\)/);
    assert.match(r.out, /is not on your PATH/);
    assert.match(r.out, /\.zshrc/);
    const installed = path.join(bin, 'kula-node');
    assert.equal(fs.readFileSync(installed, 'utf8'), FAKE);
    assert.equal(fs.statSync(installed).mode & 0o777, 0o755);
    assert.equal(fs.existsSync(path.join(bin, '.kula-node.new')), false);
    assert.equal(srv.asked[0], 'sha256sums.txt');
    assert.ok(UNIX_NAMES.includes(srv.asked[1]), srv.asked.join(','));
    // on the PATH already: no note
    const again = await runInstall({ HOME: home, KULA_NODE_BASE_URL: srv.base, KULA_NODE_BIN_DIR: bin, PATH: `${bin}:${process.env.PATH}` });
    assert.equal(again.code, 0, again.out);
    assert.doesNotMatch(again.out, /not on your PATH/);
  } finally {
    await srv.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('install.sh: a sha256 mismatch stops the install and leaves nothing behind', { skip: !unix }, async () => {
  const tampered = FAKE.replace('fake', 'evil');
  const files: Record<string, string> = { 'sha256sums.txt': formatSums(new Map(UNIX_NAMES.map((n) => [n, hex(FAKE)]))) };
  for (const n of UNIX_NAMES) files[n] = tampered;
  const srv = await fakeRelease(files);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-inst-'));
  try {
    const bin = path.join(home, 'bin');
    // an older install stays as it was
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'kula-node'), 'old');
    const r = await runInstall({ HOME: home, KULA_NODE_BASE_URL: srv.base, KULA_NODE_BIN_DIR: bin });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /sha256 mismatch .*nothing was installed/);
    assert.doesNotMatch(r.out, /evil/); // never ran
    assert.deepEqual(fs.readdirSync(bin), ['kula-node']);
    assert.equal(fs.readFileSync(path.join(bin, 'kula-node'), 'utf8'), 'old');
  } finally {
    await srv.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('install.sh: no line for this binary, a missing file, or plain http elsewhere all stop it', { skip: !unix }, async () => {
  const srv = await fakeRelease({ 'sha256sums.txt': `${hex('x')}  kula-node-plan9-mips\n` });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-inst-'));
  try {
    const bin = path.join(home, 'bin');
    const r = await runInstall({ HOME: home, KULA_NODE_BASE_URL: srv.base, KULA_NODE_BIN_DIR: bin });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /has no line for kula-node-/);
    const gone = await runInstall({ HOME: home, KULA_NODE_BASE_URL: `${srv.base}/nothing-here`, KULA_NODE_BIN_DIR: bin });
    assert.notEqual(gone.code, 0);
    assert.match(gone.out, /could not download sha256sums\.txt/);
    const plain = await runInstall({ HOME: home, KULA_NODE_BASE_URL: 'http://example.com/x', KULA_NODE_BIN_DIR: bin });
    assert.notEqual(plain.code, 0);
    assert.match(plain.out, /refusing http:\/\/example\.com\/x/);
    assert.equal(fs.existsSync(bin), false);
  } finally {
    await srv.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the .deb holds /usr/bin/kula-node, root owned, with a control file', () => {
  const binary = Buffer.from('#!/bin/sh\necho hi\n');
  const deb = makeDeb({ version: '1.2.3', target: 'linux-arm64', binary, mtime: 1700000000 });
  assert.equal(deb.name, 'kula-node_1.2.3_arm64.deb');
  const members = readAr(deb.data);
  assert.deepEqual(members.map((m) => m.name), ['debian-binary', 'control.tar.gz', 'data.tar.gz']);
  assert.equal(members[0].data.toString(), '2.0\n');
  const control = readTarGz(members[1].data);
  const ctl = control.find((e) => e.name === './control')!.data.toString();
  assert.match(ctl, /^Package: kula-node\nVersion: 1\.2\.3\nArchitecture: arm64\n/);
  assert.match(ctl, /\nDescription: .+\n .+\n/);
  const data = readTarGz(members[2].data);
  assert.deepEqual(data.map((e) => e.name), ['./', './usr/', './usr/bin/', './usr/bin/kula-node']);
  const exe = data.at(-1)!;
  assert.equal(exe.mode, 0o755);
  assert.equal(exe.uid, 0);
  assert.deepEqual(exe.data, binary);
  assert.equal(makeDeb({ version: '1.2.3', target: 'linux-x64', binary }).name, 'kula-node_1.2.3_amd64.deb');
  assert.throws(() => makeDeb({ version: '1', target: 'mac-arm64', binary }), /no debian architecture/);
  // the system tar reads it too
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-deb-'));
  try {
    fs.writeFileSync(path.join(dir, 'data.tar.gz'), members[2].data);
    const r = spawnSync('tar', ['-tzvf', path.join(dir, 'data.tar.gz')], { encoding: 'utf8' });
    if (!r.error) { assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /usr\/bin\/kula-node/); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('formula and winget manifests carry the version and the real sha256s', () => {
  const sums = new Map(Object.keys(TARGETS).map((t) => [binaryName(t), hex(t)]));
  const rb = renderFormula('2.0.0', sums);
  assert.match(rb, /version "2\.0\.0"/);
  for (const t of ['mac-arm64', 'mac-x64', 'linux-x64', 'linux-arm64']) {
    assert.ok(rb.includes(`releases/download/v2.0.0/kula-node-${t}"\n      sha256 "${hex(t)}"`), t);
  }
  assert.doesNotMatch(rb, /REPLACE_WITH/);
  const w = renderWinget('2.0.0', sums);
  assert.match(w['Kula.KulaNode.installer.yaml'], new RegExp(`InstallerSha256: ${hex('win-x64').toUpperCase()}`));
  assert.match(w['Kula.KulaNode.installer.yaml'], /InstallerType: portable/);
  for (const text of Object.values(w)) assert.match(text, /PackageVersion: 2\.0\.0/);
  // the checked-in drafts are exactly what --drafts renders for package.json's version
  const v = readVersion();
  assert.equal(fs.readFileSync(path.join(ROOT, 'packaging', 'homebrew', 'kula-node.rb'), 'utf8'), renderFormula(v));
  for (const [name, text] of Object.entries(renderWinget(v))) assert.equal(fs.readFileSync(path.join(ROOT, 'packaging', 'winget', name), 'utf8'), text);
});

test('sha256sums.txt round trip and the node release files per target', () => {
  const m = parseSums(`${'A'.repeat(64)}  kula-node-mac-arm64\n${'b'.repeat(64)} *kula-node-win-x64.exe\nnoise\n`);
  assert.equal(m.get('kula-node-mac-arm64'), 'a'.repeat(64));
  assert.equal(m.get('kula-node-win-x64.exe'), 'b'.repeat(64));
  assert.deepEqual(parseSums(formatSums(m)), m);
  assert.deepEqual(nodeAsset('linux-arm64', '24.22.2'), { file: 'node-v24.22.2-linux-arm64.tar.gz', inner: 'node-v24.22.2-linux-arm64/bin/node' });
  assert.deepEqual(nodeAsset('win-x64', '24.22.2'), { file: 'win-x64/node.exe', inner: null });
  assert.equal(binaryName('win-x64'), 'kula-node-win-x64.exe');
  assert.equal(hostTarget('darwin', 'arm64'), 'mac-arm64');
  assert.equal(hostTarget('freebsd', 'x64'), null);
});

// Runs only after `npm run pack:bin` on this machine (dist-bin is not committed).
const host = hostTarget();
const packed = host ? path.join(NODE_DIR, 'dist-bin', binaryName(host)) : '';
test('the packed binary answers --version, --json and --help', { skip: !packed || !fs.existsSync(packed) ? 'no dist-bin binary; run npm run pack:bin' : false }, () => {
  const v = spawnSync(packed, ['--version', '--json'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(v.status, 0, v.stderr);
  const info = JSON.parse(v.stdout);
  assert.equal(info.version, readVersion());
  assert.equal(info.packed, true);
  assert.equal(info.llama, 'b11157');
  const h = spawnSync(packed, ['--help'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(h.status, 0);
  assert.match(h.stdout, /kula-node setup/);
  const menu = spawnSync(packed, [], { encoding: 'utf8', input: '', timeout: 30000 });
  assert.equal(menu.status, 0);
  assert.match(menu.stdout, /1\) setup/);
});
