import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parse, menuItems, menuText, pickMenu, versionInfo } from '../src/cli.ts';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the bare menu: setup first until llama.cpp is here, then share', () => {
  const fresh = menuItems(null);
  assert.deepEqual(fresh.map((i) => i.label), ['setup', 'share', 'peers', 'help']);
  assert.match(menuText(fresh, '1'), /1\) setup .*start here.*<- enter/);
  assert.deepEqual(pickMenu('', fresh, '1'), ['setup']);
  assert.deepEqual(pickMenu('2', fresh, '1'), ['share']);
  assert.deepEqual(pickMenu(' peers ', fresh, '1'), ['peers', 'list']);
  assert.deepEqual(pickMenu('4', fresh, '1'), ['help']);
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
