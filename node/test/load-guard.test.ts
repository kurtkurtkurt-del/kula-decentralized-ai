import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApiServer, cleanStaleParts, PART_MAX_AGE_MS } from '../src/api.ts';

async function sse(url: string, body: unknown): Promise<any[]> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  return text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)));
}

const otherSha = 'ab'.repeat(32);

test('security 2.1: a device through the gate cannot delete or replace a model that is already here', async () => {
  const models = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-guard-'));
  const file = path.join(models, 'mine.gguf');
  fs.writeFileSync(file, 'the owner\'s own model');
  const api = await startApiServer({ models, llama: null, fromGate: () => true, masterOf: () => null });
  try {
    const ev = await sse(`http://127.0.0.1:${api.port}/load`, { name: 'mine.gguf', sha256: otherSha, url: 'https://example.invalid/x.gguf', size: 1 });
    const err = ev.find((e) => e.error)?.error ?? '';
    assert.match(err, /already on this computer; it is not replaced/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'the owner\'s own model', 'the file is untouched');
  } finally { await api.close(); }
});

test('this computer\'s own engine (not through the gate) still replaces a file that differs', async () => {
  const models = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-guard-'));
  const file = path.join(models, 'broken.gguf');
  fs.writeFileSync(file, 'half a model');
  const api = await startApiServer({ models, llama: null, fromGate: () => false, masterOf: () => null });
  try {
    await sse(`http://127.0.0.1:${api.port}/load`, { name: 'broken.gguf', sha256: otherSha, url: 'https://example.invalid/x.gguf', size: 1 });
    assert.equal(fs.existsSync(file), false, 'the broken file is gone, to be fetched again');
  } finally { await api.close(); }
});

test('security 2.5: half downloads older than a day are cleaned, recent ones stay to resume', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-parts-'));
  const old = path.join(dir, 'old.gguf.part');
  const fresh = path.join(dir, 'fresh.gguf.part');
  const model = path.join(dir, 'model.gguf');
  for (const f of [old, fresh, model]) fs.writeFileSync(f, 'x');
  const past = (Date.now() - PART_MAX_AGE_MS - 60_000) / 1000;
  fs.utimesSync(old, past, past);
  fs.utimesSync(model, past, past);
  assert.deepEqual(cleanStaleParts(dir), ['old.gguf.part']);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['fresh.gguf.part', 'model.gguf']);
  assert.deepEqual(cleanStaleParts(path.join(dir, 'nope')), []);
});
