import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatStore } from '../src/ui/store.ts';
import { ProjectRunner, ProjectStore, partsOf, type ProjectEngine } from '../src/ui/projects.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kula-projects-'));
const H = 3600_000;

function fakeEngine(): ProjectEngine & { calls: string[]; loaded: unknown[] } {
  const calls: string[] = [], loaded: unknown[] = [];
  return {
    calls, loaded,
    async load(req) { loaded.push(req); return {}; },
    async chat(messages, onToken) {
      const ask = messages.at(-1)!.content;
      calls.push(ask);
      const text = ask.includes('Break it into') ? '1. find the sources\n2. compare them\n- write it down' : ask.includes('morning report') ? 'summary: all good' : `<think>hmm</think>worked on it`;
      onToken(text);
      return { text, device: 'this computer', tokens: 10, tps: 20, ms: 500, firstMs: 100 };
    },
    async unload() {},
    peers: () => [],
    status: () => ({ loading: null }),
  };
}

test('the plan is split into parts, numbering and bullets taken off', () => {
  assert.deepEqual(partsOf('<think>x</think>1. one thing\n2) another\n- third one\n\n**part 4:** four'), ['one thing', 'another', 'third one', 'four']);
});

test('a project waits for its time, then plans, works each part and leaves a morning report in its chat', async () => {
  const dir = tmp();
  let now = Date.UTC(2026, 10, 6, 20, 0);
  const chats = new ChatStore(path.join(dir, 'chats'));
  const eng = fakeEngine();
  const r = new ProjectRunner(eng, chats, new ProjectStore(path.join(dir, 'projects.json')), { now: () => now, awake: false });
  const p = r.create({ title: 'tides', request: 'explain the tides for a ten year old', start: now + H, end: now + 5 * H, model: 'qwen3-0.6b-q8', mode: 'split', peers: ['cable:A', 'cable:B'] });
  assert.equal(p.state, 'waiting');
  const c0 = chats.get(p.chatId)!;
  assert.equal(c0.title, 'tides');
  assert.equal(c0.messages[0].content, 'explain the tides for a ten year old');

  await r.tick();
  assert.equal(r.get(p.id)!.state, 'waiting', 'nothing before its time');
  assert.equal(eng.loaded.length, 0);

  now += H + 1000;
  await r.tick();
  const done = r.get(p.id)!;
  assert.equal(done.state, 'done');
  assert.equal(done.parts, 3);
  assert.equal(done.done, 3);
  assert.deepEqual(eng.loaded[0], { model: 'qwen3-0.6b-q8', mode: 'split', peers: ['cable:A', 'cable:B'], ctx: 4096, all: true });
  const msgs = chats.get(p.chatId)!.messages.map((m) => m.content);
  assert.match(msgs.find((m) => m.startsWith('**the plan**'))!, /1\. find the sources\n2\. compare them\n3\. write it down/);
  assert.equal(msgs.filter((m) => m.startsWith('**part ')).length, 3);
  assert.ok(!msgs.some((m) => m.includes('<think>')), 'the thinking stays out');
  assert.match(msgs.at(-1)!, /^\*\*morning report\*\*\n\nsummary: all good/);
});

test('a start the computer slept through is missed, not run late; a waiting one can be cancelled', async () => {
  const dir = tmp();
  let now = Date.UTC(2026, 10, 6, 20, 0);
  const chats = new ChatStore(path.join(dir, 'chats'));
  const eng = fakeEngine();
  const r = new ProjectRunner(eng, chats, new ProjectStore(path.join(dir, 'projects.json')), { now: () => now, awake: false });
  const a = r.create({ request: 'one', start: now + H, end: now + 2 * H, model: 'm', mode: 'here' });
  const b = r.create({ request: 'two', start: now + H, end: now + 2 * H, model: 'm', mode: 'here' });
  assert.equal(r.cancel(b.id)!.state, 'cancelled');
  now += 3 * H;
  await r.tick();
  assert.equal(r.get(a.id)!.state, 'missed');
  assert.equal(eng.loaded.length, 0);
  assert.match(chats.get(a.chatId)!.messages.at(-1)!.content, /^missed/);
});

test('it says what is missing', () => {
  const dir = tmp();
  const now = Date.UTC(2026, 10, 6, 20, 0);
  const r = new ProjectRunner(fakeEngine(), new ChatStore(path.join(dir, 'chats')), new ProjectStore(path.join(dir, 'p.json')), { now: () => now, awake: false });
  assert.throws(() => r.create({ request: '', start: now + H, end: now + 2 * H, model: 'm' }), /say what it should do/);
  assert.throws(() => r.create({ request: 'x', start: now + 2 * H, end: now + H, model: 'm' }), /end has to come after/);
  assert.throws(() => r.create({ request: 'x', start: now + H, end: now + 20 * H, model: 'm' }), /at most 14 hours/);
  assert.throws(() => r.create({ request: 'x', start: now + H, end: now + 2 * H, model: 'm', mode: 'split' }), /pick the devices/);
});
