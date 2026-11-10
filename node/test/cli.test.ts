import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, menuItems, menuText, pickMenu, versionInfo, secretFrom, probeSecret } from '../src/cli.ts';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the bare menu: setup first until llama.cpp is here, then share', () => {
  const fresh = menuItems(null);
  assert.deepEqual(fresh.map((i) => i.label), ['setup', 'share', 'peers', 'ui', 'help']);
  assert.match(menuText(fresh, '1'), /1\) setup .*start here.*<- enter/);
  assert.deepEqual(pickMenu('', fresh, '1'), ['setup']);
  assert.deepEqual(pickMenu('2', fresh, '1'), ['share']);
  assert.deepEqual(pickMenu(' peers ', fresh, '1'), ['peers', 'list']);
  assert.deepEqual(pickMenu('4', fresh, '1'), ['ui']);
  assert.deepEqual(pickMenu('5', fresh, '1'), ['help']);
  assert.equal(pickMenu('q', fresh, '1'), 'quit');
  assert.equal(pickMenu('9', fresh, '1'), null);
  const ready = menuItems('/x/bin');
  assert.match(menuText(ready, '2'), /is here \(\/x\/bin\)/);
  assert.deepEqual(pickMenu('', ready, '2'), ['share']);
});

test('--json never swallows the next word; value flags still take one', () => {
  assert.deepEqual(parse(['probe', '--json', 'h', '1', 's']), { cmd: 'probe', flags: { json: true }, rest: ['h', '1', 's'] });
  assert.deepEqual(parse(['chat', '--peer', 'a', '--peer', 'b', '--mode', 'split']).flags, { peer: 'a,b', mode: 'split' });
  assert.deepEqual(parse(['setup', '--dry-run', '--json']).flags, { 'dry-run': true, json: true });
});

test('the version comes from package.json', () => {
  const v = versionInfo();
  assert.equal(v.version, pkg.version);
  assert.equal(v.llama, 'b11157');
  assert.equal(v.packed, false);
});

test('share is tls unless --no-tls; --no-tls never swallows the next word', () => {
  assert.deepEqual(parse(['share', '--no-tls', '--port', '1']).flags, { 'no-tls': true, port: '1' });
  assert.deepEqual(parse(['share', '--no-tls', 'x']).rest, ['x']);
});

test('the v1 secret: --secret-file (mode 600 only), KULA_SECRET, --secret with a ps warning; never echoed', () => {
  const S = '0123456789ABCDEF0123456789abcdef';
  const warned: string[] = [];
  const warn = (s: string) => warned.push(s);
  assert.deepEqual(secretFrom({}, {}, warn), {});
  assert.deepEqual(secretFrom({}, { KULA_SECRET: S }, warn), { secret: S.toLowerCase() });
  assert.deepEqual(secretFrom({}, { KULA_SECRET: 'nothex' }, warn), { error: 'KULA_SECRET must be hex (16 to 128 characters)' });
  assert.equal(warned.length, 0);
  // on argv: still taken, with one warning that names the other ways
  assert.deepEqual(secretFrom({ secret: S }, { KULA_SECRET: 'ff'.repeat(16) }, warn), { secret: S.toLowerCase() });
  assert.equal(warned.length, 1);
  assert.match(warned[0], /ps/);
  assert.match(warned[0], /KULA_SECRET/);
  assert.match(warned[0], /--secret-file/);
  assert.deepEqual(secretFrom({ secret: 'zz' }, {}, warn), { error: '--secret must be hex' });
  assert.deepEqual(secretFrom({ secret: true }, {}, warn), { error: '--secret needs a value' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-cli-'));
  const file = path.join(dir, 'secret');
  fs.writeFileSync(file, S + '\n', { mode: 0o600 });
  try {
    assert.deepEqual(secretFrom({ 'secret-file': file }, {}, warn), { secret: S.toLowerCase() });
    assert.deepEqual(secretFrom({ 'secret-file': file, secret: S }, {}, warn), { error: 'give the secret one way: --secret-file or --secret' });
    if (process.platform !== 'win32') {
      for (const mode of [0o644, 0o640, 0o604]) {
        fs.chmodSync(file, mode);
        const r = secretFrom({ 'secret-file': file }, {}, warn);
        assert.match(r.error ?? '', /can be read by other users; chmod 600/);
      }
      fs.chmodSync(file, 0o600);
    }
    fs.writeFileSync(file, 'not hex');
    const bad = secretFrom({ 'secret-file': file }, {}, warn);
    assert.match(bad.error ?? '', /must hold one hex secret/);
    assert.ok(!bad.error!.includes('not hex'), 'the content is not echoed');
    assert.match(secretFrom({ 'secret-file': path.join(dir, 'none') }, {}, warn).error ?? '', /cannot read/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  for (const w of warned) assert.ok(!w.toLowerCase().includes(S.toLowerCase()), 'a warning carries the secret');
});

test('probe: "env" reads KULA_SECRET, "-" is none, a typed secret warns', () => {
  const warned: string[] = [];
  const warn = (s: string) => warned.push(s);
  assert.deepEqual(probeSecret('env', { KULA_SECRET: 'abcd' }, warn), { secret: 'abcd' });
  assert.deepEqual(probeSecret('env', {}, warn), { error: 'probe: secret "env" but KULA_SECRET is not set' });
  assert.deepEqual(probeSecret('-', {}, warn), { secret: '-' });
  assert.equal(warned.length, 0);
  assert.deepEqual(probeSecret('abcd', {}, warn), { secret: 'abcd' });
  assert.equal(warned.length, 1);
  assert.match(warned[0], /ps/);
  assert.ok(!warned[0].includes('abcd'));
});
