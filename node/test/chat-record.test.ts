// The chat record keeps two new things: `ran` (how the last good answer was made, so an old chat
// can offer its model again) and the `skill` tag on a system note. Both are cleaned like the rest:
// known keys only, sizes capped; a save without `ran` keeps the one already kept.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-chat-record-'));
process.env.KULA_NODE_HOME = HOME;

const { ChatStore, clean } = await import('../src/ui/store.ts');

after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const ID = 'abcdef0123456789';
const user = { role: 'user', content: 'hi' };
const ranBody = { model: 'qwen3-0.6b', name: 'Qwen3 0.6B', mode: 'apart', peers: ['p1', 'p2'], names: ['pixel', 'galaxy'], here: true, ctx: 4096, at: 1234 };

test('ran: kept as sent, known keys only', () => {
  const c = clean(ID, { messages: [user], model: 'Qwen3 0.6B', ran: { ...ranBody, evil: 'x', token: 'secret' } }, null);
  assert.deepEqual(c.ran, ranBody);
  assert.equal(c.model, 'Qwen3 0.6B');
});

test('ran: sizes capped and bad values fixed', () => {
  const before = Date.now();
  const c = clean(ID, {
    messages: [user],
    ran: { model: 'm'.repeat(300), name: 'n'.repeat(300), mode: 'cloud', peers: [...Array(20).keys()].map((i) => `p${i}`.padEnd(200, 'x')).concat([5 as any]), names: 'pixel', here: 'yes', ctx: Infinity, at: 'now' },
  }, null);
  assert.ok(c.ran);
  assert.equal(c.ran.model.length, 200);
  assert.equal(c.ran.name.length, 200);
  assert.equal(c.ran.mode, null);
  assert.equal(c.ran.peers.length, 16);
  assert.ok(c.ran.peers.every((p) => p.length === 120));
  assert.deepEqual(c.ran.names, []);
  assert.equal(c.ran.here, false);
  assert.equal(c.ran.ctx, null);
  assert.ok(c.ran.at >= before && c.ran.at <= Date.now());
  for (const mode of ['phone', 'apart', 'split', 'here']) assert.equal(clean(ID, { messages: [user], ran: { model: 'm', mode } }, null).ran?.mode, mode);
});

test('ran: no model means no ran; a chat without one has none', () => {
  assert.equal(clean(ID, { messages: [user], ran: { name: 'x', mode: 'here' } }, null).ran, undefined);
  assert.equal(clean(ID, { messages: [user], ran: 'qwen' }, null).ran, undefined);
  assert.equal('ran' in clean(ID, { messages: [user] }, null), false);
});

test('ran: a put without ran (or with a bad or null one) keeps the kept one', () => {
  const store = new ChatStore(path.join(HOME, 'chats-ran'));
  store.put(ID, { messages: [user], ran: ranBody });
  assert.deepEqual(store.put(ID, { messages: [user, { role: 'assistant', content: 'hello' }] }).ran, ranBody);
  assert.deepEqual(store.put(ID, { messages: [user], ran: null }).ran, ranBody);
  assert.deepEqual(store.put(ID, { messages: [user], ran: { mode: 'here' } }).ran, ranBody);
  assert.deepEqual(store.get(ID)?.ran, ranBody);
  // a new good one replaces it
  const next = { ...ranBody, model: 'llama-3b', name: 'Llama 3B', mode: 'here', peers: [], names: [] };
  assert.deepEqual(store.put(ID, { messages: [user], ran: next }).ran, next);
  assert.deepEqual(store.get(ID)?.ran, next);
});

test('skill: kept on a system note, dropped on a user message, dropped for a bad id; off kept', () => {
  const store = new ChatStore(path.join(HOME, 'chats-skill'));
  const c = store.put(ID, {
    messages: [
      { role: 'system', content: 'You are a cheerful old pirate captain.', skill: { id: 'pirate', name: 'pirate', about: 'every answer from an old sea captain', evil: 1 } },
      { role: 'user', content: 'hi', skill: { id: 'pirate', name: 'pirate' } },
      { role: 'system', content: 'x', skill: { id: 'Bad Id!', name: 'nope' } },
      { role: 'system', content: 'x', skill: { id: 'a'.repeat(41), name: 'too long' } },
      { role: 'assistant', content: 'arr', skill: { id: 'pirate', name: 'pirate' } },
      { role: 'system', content: '', skill: { id: 'pirate', name: 'pirate', off: true } },
      { role: 'system', content: '', skill: { id: 'my-own-2', name: 'n'.repeat(80), about: 'a'.repeat(300), off: 'yes' } },
    ],
  });
  assert.deepEqual(c.messages[0].skill, { id: 'pirate', name: 'pirate', about: 'every answer from an old sea captain' });
  assert.equal(c.messages[1].skill, undefined);
  assert.equal(c.messages[2].skill, undefined);
  assert.equal(c.messages[2].role, 'system');
  assert.equal(c.messages[3].skill, undefined);
  assert.equal(c.messages[4].skill, undefined);
  assert.deepEqual(c.messages[5].skill, { id: 'pirate', name: 'pirate', off: true });
  assert.deepEqual(c.messages[6].skill, { id: 'my-own-2', name: 'n'.repeat(60), about: 'a'.repeat(200) });
  // it lives on the file too
  assert.deepEqual(store.get(ID)?.messages[5].skill, { id: 'pirate', name: 'pirate', off: true });
});
