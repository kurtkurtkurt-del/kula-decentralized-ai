import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicName } from '../src/devicenames.ts';

test('samsung model codes become the names on the box, in every spelling adb and the gate use', () => {
  assert.equal(publicName('SM S936B'), 'Galaxy S25+');
  assert.equal(publicName('SM_S936B'), 'Galaxy S25+');
  assert.equal(publicName('samsung SM-S936B'), 'Galaxy S25+');
  assert.equal(publicName('SM-S936U1'), 'Galaxy S25+');
  assert.equal(publicName('SM X520'), 'Galaxy Tab S10 FE');
});

test('anything else stays as it was', () => {
  assert.equal(publicName('Pixel 8'), 'Pixel 8');
  assert.equal(publicName('SM-Z999B'), 'SM-Z999B');
  assert.equal(publicName('my phone'), 'my phone');
  assert.equal(publicName(null), '');
});
