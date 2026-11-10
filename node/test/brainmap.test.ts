// The brain panel's map (src/ui/static/brainmap.js, the same module the page imports): each
// branch's state from the eye's words, the branch the panel opens first, the notices, the four
// numbers and where the twelve sit. The page serves and packs the module like the others.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NODE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bm = await import('../src/ui/static/brainmap.js');
const { UI_STATIC } = await import('../src/ui/server.ts');

const v = (stat: string, more: Record<string, unknown> = {}) => ({ built: true, stat, gauge: null, rows: [], lines: [], ...more });

test('brain map: a state for each branch from what the eye says', () => {
  assert.equal(bm.branchState('senses', null), 'quiet');
  assert.equal(bm.branchState('senses', { ...v('x'), built: false }), 'off');
  assert.equal(bm.branchState('memory', v('6 events kept · 6 today', { error: 'boom' })), 'look');
  assert.equal(bm.branchState('trust', v('1 thing to look at', { report: { verdict: 'bad' } })), 'look');
  assert.equal(bm.branchState('trust', v('all clear · 2 devices', { report: { verdict: 'ok' } })), 'fine');
  assert.equal(bm.branchState('trust', v('nothing to check')), 'quiet');
  assert.equal(bm.branchState('limits', v('2 warnings')), 'look');
  assert.equal(bm.branchState('limits', v('all within limits')), 'fine');
  assert.equal(bm.branchState('senses', v('0 of 2 devices active')), 'know');
  assert.equal(bm.branchState('senses', v('2 of 2 devices active')), 'fine');
  assert.equal(bm.branchState('senses', v('no device yet')), 'quiet');
  assert.equal(bm.branchState('advisor', v('a bigger model fits: Qwen2.5 1.5B')), 'know');
  assert.equal(bm.branchState('advisor', v('keep SmolVLM 500M as it is')), 'fine');
  assert.equal(bm.branchState('advisor', v('night project: phone is offline')), 'look');
  assert.equal(bm.branchState('advisor', v('nothing to suggest')), 'quiet');
  assert.equal(bm.branchState('forecast', v('still learning: 0 recent hours so far')), 'quiet');
  assert.equal(bm.branchState('review', v('nothing waiting')), 'quiet');
  assert.equal(bm.branchState('review', v('1 waiting · 1 to look at again')), 'know');
  assert.equal(bm.branchState('review', v('1 waiting · all ok')), 'fine');
  assert.equal(bm.branchState('executor', v('idle')), 'quiet');
  assert.equal(bm.branchState('executor', v('0 answering · 1 answers')), 'fine');
  assert.equal(bm.branchState('planner', v('looking…')), 'quiet');
});

test('brain map: the card opens on what needs you most; the notices are the rest worth a look', () => {
  const list = [{ id: 'senses', state: 'know' }, { id: 'memory', state: 'fine' }, { id: 'trust', state: 'look' }, { id: 'advisor', state: 'know' }];
  assert.equal(bm.firstOpen(list), 'trust');
  assert.equal(bm.firstOpen(list.filter((x) => x.id !== 'trust')), 'senses');
  assert.equal(bm.firstOpen([{ id: 'memory', state: 'fine' }]), 'executor');
  // senses is already the numbers card's "devices active": not said twice
  assert.deepEqual(bm.notices(list, 'trust').map((x: { id: string }) => x.id), ['advisor']);
  assert.deepEqual(bm.notices(list, 'advisor').map((x: { id: string }) => x.id), ['trust']);
  assert.deepEqual(bm.counts(list), { look: 1, know: 2, fine: 1, quiet: 0, off: 0 });
});

test('brain map: the four numbers come from the eye\'s lines, null when not there yet', () => {
  assert.deepEqual(bm.fourNumbers({ senses: '0 of 2 devices active', learning: 'reachability right 97%', memory: '6 events kept · 6 today' }),
    { devices: { on: 0, of: 2 }, reach: 97, events: { n: 6, today: 6 } });
  assert.deepEqual(bm.fourNumbers({ senses: 'no device yet', learning: 'nothing to learn yet', memory: 'looking…' }), { devices: null, reach: null, events: null });
});

test('brain map: twelve places on the ring, clockwise from the top, inside the drawing', () => {
  const at = Array.from({ length: 12 }, (_, k) => bm.nodeAt(k));
  assert.equal(at[0].x, bm.MAP.cx);
  assert.ok(at[0].y < bm.MAP.cy && at[6].y > bm.MAP.cy && at[3].x > bm.MAP.cx && at[9].x < bm.MAP.cx);
  for (const p of at) {
    assert.ok(p.x - bm.MAP.r >= 0 && p.x + bm.MAP.r <= bm.MAP.w, `x ${p.x}`);
    assert.ok(p.ly - 12 >= bm.MAP.top && p.ly <= bm.MAP.top + bm.MAP.h, `label ${p.ly}`);
  }
});

test('brain map: the page imports it and serves and packs it', () => {
  assert.ok(UI_STATIC.includes('brainmap.js'));
  assert.match(fs.readFileSync(path.join(NODE_DIR, 'src/ui/static/app.js'), 'utf8'), /from '\.\/brainmap\.js'/);
});
