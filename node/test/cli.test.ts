// The command line's shape: json outputs, the menu's items, version source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { menuItems, menuText } from '../src/menu.ts';
import { VERSION, DIST } from '../src/version.ts';
import { firewallNote } from '../src/share.ts';
import { bar } from '../src/progress.ts';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const cli = (args: string[], env: Record<string, string> = {}, input = '') =>
  spawnSync(process.execPath, ['--import', 'tsx', 'src/bin/kula-node.ts', ...args], { encoding: 'utf8', input, env: { ...process.env, KULA_NODE_HOME: fs.mkdtempSync(path.join(os.tmpdir(), 'kula-cli-')), ...env } });

test('the version comes from package.json in a checkout', () => {
  assert.equal(VERSION, pkg.version);
  assert.equal(DIST, 'source');
  const r = cli(['version', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.version, pkg.version);
  assert.equal(j.dist, 'source');
  assert.equal(j.llama, 'b11157');
});

test('setup --check --json and --dry-run --json', () => {
  const chk = cli(['setup', '--check', '--json'], { KULA_LLAMA_DIR: '/nonexistent' });
  const j = JSON.parse(chk.stdout);
  assert.equal(typeof j.ok, 'boolean');
  assert.ok(Array.isArray(j.lookedIn) && j.lookedIn[0] === '/nonexistent');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-cli-'));
  const dry = cli(['setup', '--dry-run', '--json'], { KULA_NODE_HOME: home, KULA_RELEASE_JSON: 'test/fixtures/release-b11157.json', KULA_NVIDIA: '0', KULA_LLAMA_DIR: '/nonexistent' });
  if (process.platform === 'darwin') { assert.equal(dry.status, 0); return; }
  assert.equal(dry.status, 0, dry.stderr);
  const d = JSON.parse(dry.stdout);
  assert.equal(d.dryRun, true);
  assert.ok(d.plan.totalBytes > 1e6);
  assert.ok(d.log.some((l: string) => /^total download: \d+ MB$/.test(l)), d.log.join('\n'));
  assert.equal(d.plan.dest, path.join(home, 'llama-b11157', 'bin'));
});

test('probe --json, peers list --json, info --json', () => {
  const p = cli(['probe', '127.0.0.1', '1', 'ab'.repeat(8), '--json', '--timeout', '300']);
  assert.equal(p.status, 1);
  const j = JSON.parse(p.stdout);
  assert.equal(j.ok, false);
  assert.equal(j.rpc.ok, false);
  assert.equal(j.api.ok, false);
  const l = cli(['peers', 'list', '--json']);
  assert.deepEqual(JSON.parse(l.stdout), []);
  const i = cli(['info', '--json', '--no-bandwidth']);
  assert.equal(i.status, 0, i.stderr);
  const info = JSON.parse(i.stdout);
  assert.equal(info.version, pkg.version);
  assert.ok(info.ramTotalMB > 0);
  assert.equal(info.bandwidthGBs, 0);
  assert.equal(info.llama.tag, 'b11157');
});

test('no arguments: the help in a pipe; the menu lists setup, share, peers, measure', () => {
  const r = cli([]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage:/);
  const items = menuItems();
  assert.deepEqual(items.map((i) => i.key), ['1', '2', '3', '4', 'h', 'q']);
  assert.deepEqual(items.map((i) => i.argv[0]), ['setup', 'share', 'peers', 'info', 'help', undefined]);
  const t = menuText(items);
  assert.match(t, new RegExp(`kula-node ${pkg.version.replace(/\./g, '\\.')} \\(source\\)`));
  assert.match(t, /1  setup/);
  assert.match(t, /4  measure/);
});

test('the firewall note names the port and the netsh-free repair', () => {
  const n = firewallNote(50551);
  assert.match(n, /private networks/);
  assert.match(n, /New-NetFirewallRule .*-LocalPort 50551/);
});

test('the progress bar is silent when quiet and draws once per update otherwise', () => {
  const quiet = bar('x', true);
  quiet(1, 2);
  const writes: string[] = [];
  const orig = process.stdout.write;
  (process.stdout as unknown as { write: unknown }).write = (s: string) => { writes.push(s); return true; };
  try {
    const b = bar('  file.tar.gz', false);
    b(0, 100); b(100, 100); b(100, 100);
  } finally { process.stdout.write = orig; }
  assert.equal(writes.length, 3, writes.join('|'));
  assert.match(writes[1], /100%/);
  assert.equal(writes[2], '\n');
});
