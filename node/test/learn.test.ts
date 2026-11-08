// The learn tab of the chat page's brain panel (src/ui/static/learn.js): three levels of topics,
// each link a real https address of a known kind; and the files the page needs are the files the
// packed binary bakes in (tools/pack.mjs keeps its own list next to UI_STATIC).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { LEVELS, LEARN_COUNT } = await import('../src/ui/static/learn.js');
const { UI_STATIC } = await import('../src/ui/server.ts');

test('learn: three levels, beginner to advanced, then a smaller marked aside; many links of known kinds', () => {
  assert.deepEqual(LEVELS.map((l: any) => l.id), ['beginner', 'intermediate', 'advanced', 'also']);
  assert.deepEqual(LEVELS.map((l: any) => !!l.side), [false, false, false, true]);
  const core = LEVELS.filter((l: any) => !l.side).reduce((n: number, l: any) => n + l.topics.length, 0);
  assert.ok(LEVELS[3].topics.length < core, 'the aside is the smaller part');
  // the general basics are only the beginner foundation
  for (const l of LEVELS) for (const t of l.topics) if (t.base) assert.equal(l.id, 'beginner', t.id);
  const items = LEVELS.flatMap((l: any) => l.topics.flatMap((t: any) => t.items));
  assert.equal(items.length, LEARN_COUNT);
  assert.ok(LEARN_COUNT >= 60, `${LEARN_COUNT} links`);
  const urls = new Set<string>();
  for (const l of LEVELS) {
    assert.ok(l.topics.length >= 3, l.id);
    for (const t of l.topics) {
      assert.match(t.c, /^#[0-9a-f]{6}$/i, t.id);
      for (const f of ['id', 'code', 'name', 'hook', 'why']) assert.ok(typeof t[f] === 'string' && t[f].length, `${t.id}.${f}`);
      for (const i of t.items) {
        assert.ok(['video', 'paper', 'course', 'post', 'doc'].includes(i.k), `${i.u}: kind ${i.k}`);
        assert.ok(i.t && i.by, i.u);
        const u = new URL(i.u);
        assert.equal(u.protocol, 'https:', i.u);
        assert.ok(!urls.has(i.u), `twice: ${i.u}`);
        urls.add(i.u);
        if (i.k === 'video') assert.ok(u.hostname === 'www.youtube.com', i.u);
      }
    }
  }
  assert.ok(items.filter((i: any) => i.k === 'video').length >= 20);
  assert.ok(items.filter((i: any) => i.k === 'paper').length >= 60);
});

test('learn: the page imports it, and the packed binary bakes every file the page serves', () => {
  assert.ok(UI_STATIC.includes('learn.js'));
  const app = fs.readFileSync(path.join(NODE_DIR, 'src/ui/static/app.js'), 'utf8');
  assert.match(app, /from '\.\/learn\.js'/);
  const pack = fs.readFileSync(path.join(NODE_DIR, 'tools/pack.mjs'), 'utf8');
  const list = pack.match(/const uiBaked = Object\.fromEntries\((\[[^\]]*\])/);
  assert.ok(list, 'the ui list in tools/pack.mjs');
  assert.deepEqual(JSON.parse(list[1].replace(/'/g, '"')).sort(), [...UI_STATIC].sort());
});
