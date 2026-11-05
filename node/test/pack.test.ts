// The single-file build, for real: bundle, blob, inject, run. Only on the
// host's own target (the others need a download and cannot be executed here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pack, hostTarget, artifactName } from '../tools/pack.mjs';
import { makeDeb } from '../tools/deb.mjs';
import { render, readSums } from '../tools/manifests.mjs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const host = hostTarget();
const run = (bin: string, args: string[], env: Record<string, string> = {}) => spawnSync(bin, args, { encoding: 'utf8', env: { ...process.env, ...env }, cwd: os.tmpdir() });

test('pack.mjs makes a binary for this machine that answers --version, --help and --json', { skip: host ? false : 'no pack target for this host', timeout: 180_000 }, async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-pack-'));
  const made = await pack({ targets: [host!], out, nodeVersion: process.version, bundleOnly: false, cache: path.join(out, 'cache'), smoke: false });
  assert.equal(made.length, 1);
  const bin = path.join(out, artifactName(host!));
  assert.equal(made[0].file, bin);
  assert.ok(fs.statSync(bin).size > 20e6, 'a node binary is tens of megabytes');
  // SHA256SUMS names the file and matches it
  const sums = readSums(path.join(out, 'SHA256SUMS'));
  assert.equal(sums.get(path.basename(bin)), createHash('sha256').update(fs.readFileSync(bin)).digest('hex'));

  const v = run(bin, ['--version']);
  assert.equal(v.status, 0, v.stderr);
  assert.equal(v.stdout.trim(), `kula-node ${pkg.version} (packed, llama.cpp b11157)`);
  const j = JSON.parse(run(bin, ['version', '--json']).stdout) as { version: string; dist: string };
  assert.equal(j.version, pkg.version);
  assert.equal(j.dist, 'packed');
  const h = run(bin, ['--help']);
  assert.equal(h.status, 0);
  assert.match(h.stdout, /kula-node share/);
  assert.match(h.stdout, /a short menu/);
  // no arguments in a pipe: the help, not a hanging menu
  const none = run(bin, []);
  assert.equal(none.status, 0);
  assert.match(none.stdout, /usage:/);
  // a packed binary does not look for the checkout's .llama/host
  const home = path.join(out, 'home');
  const chk = JSON.parse(run(bin, ['setup', '--check', '--json'], { KULA_NODE_HOME: home }).stdout) as { ok: boolean; lookedIn: string[] };
  assert.equal(chk.ok, false);
  assert.ok(chk.lookedIn.every((d) => !d.includes('.llama/host')), chk.lookedIn.join(','));
  // the dry run reads a saved asset list and says the total size before anything is fetched
  const dry = JSON.parse(run(bin, ['setup', '--dry-run', '--json'], { KULA_NODE_HOME: home, KULA_RELEASE_JSON: path.resolve('test/fixtures/release-b11157.json'), KULA_NVIDIA: '0' }).stdout) as { ok: boolean; plan: { totalBytes: number; asset: string } };
  assert.equal(dry.ok, true);
  assert.ok(dry.plan.totalBytes > 1e6);
  assert.ok(fs.existsSync(path.join(home)), 'home was created');

  if (process.platform === 'linux' && !spawnSync('ar', ['--version']).error) {
    const deb = makeDeb(bin, out);
    assert.match(path.basename(deb), /^kula-node_.*_(amd64|arm64)\.deb$/);
    assert.ok(fs.statSync(deb).size > 10e6);
    if (!spawnSync('dpkg-deb', ['--version']).error) {
      const info = spawnSync('dpkg-deb', ['-I', deb], { encoding: 'utf8' }).stdout;
      assert.match(info, new RegExp(`Version: ${pkg.version.replace(/\./g, '\\.')}`));
      assert.match(spawnSync('dpkg-deb', ['-c', deb], { encoding: 'utf8' }).stdout, /usr\/bin\/kula-node/);
    }
  }
  // the manifests pick the real sums up
  const files = render(pkg.version, sums);
  assert.match(files['homebrew/kula-node.rb'], new RegExp(`version "${pkg.version.replace(/\./g, '\\.')}"`));
  if (host === 'linux-x64') assert.match(files['homebrew/kula-node.rb'], new RegExp(sums.get(path.basename(bin))!));
  fs.rmSync(out, { recursive: true, force: true });
});

test('manifests carry the version from package.json and zero hashes without sums', () => {
  const files = render(pkg.version, new Map());
  assert.match(files['nfpm.yaml'], new RegExp(`^version: ${pkg.version.replace(/\./g, '\\.')}$`, 'm'));
  assert.match(files['winget/KurtKurtKurt.KulaNode.installer.yaml'], new RegExp(`kula-node-${pkg.version.replace(/\./g, '\\.')}-win-x64.exe`));
  assert.match(files['homebrew/kula-node.rb'], /sha256 "0{64}"/);
  // the committed drafts are the rendered ones
  for (const [rel, text] of Object.entries(files)) {
    const committed = fs.readFileSync(new URL(`../../packaging/${rel}`, import.meta.url), 'utf8');
    assert.equal(committed, text, `${rel} is stale: run node tools/manifests.mjs`);
  }
});
