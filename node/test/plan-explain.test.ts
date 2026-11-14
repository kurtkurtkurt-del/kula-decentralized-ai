import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSplit, simModel, workerSide, gpuGuessGbs, explainPlan, tpsRange, VRAM_SHARE, type Peer } from '../src/planner.ts';

let n = 1;
const pc = (id: string, ram: number, bw: number, extra: Partial<Peer> = {}): Peer => ({ id, name: id, host: '10.0.0.' + n++, port: 50551, secret: '', kind: 'pc', ram, bw, added_at: 't', ...extra });
const q14 = simModel({ id: 'qwen2.5-14b-q4', size: 8_990_000_000, layers: 48, hidden: 5120, vocab: 152064, quant: 'Q4_K_M', kv_mb_per_1k: 192 });
const q06 = simModel({ id: 'qwen3-0.6b-q8', size: 639446688, layers: 28, hidden: 1024, vocab: 151936, quant: 'Q8_0', kv_mb_per_1k: 56 });
const link = (mbps: number, rttMs: number) => ({ mbps, rttMs, at: 't', error: null });

test('an NVIDIA card is the room and the speed of its computer; apple silicon and AMD stay on memory', () => {
  const rtx = workerSide(pc('w', 30000, 40, { gpu: 'NVIDIA GeForce RTX 4070', vram: 12282 }));
  assert.equal(rtx.on, 'gpu');
  assert.equal(rtx.capMb, 12282 * VRAM_SHARE, 'VRAM, not the 30 GB of RAM');
  assert.equal(rtx.bw, gpuGuessGbs('NVIDIA GeForce RTX 4070'));
  assert.equal(rtx.guessed, true);
  assert.equal(workerSide(pc('m', 16000, 60, { gpu: 'Apple M2', vram: 0 })).on, 'cpu');
  assert.equal(workerSide(pc('a', 16000, 40, { gpu: 'AMD Radeon RX 7800 XT', vram: 16384 })).on, 'cpu', 'AMD gets the cpu build');
  assert.equal(workerSide(pc('t', 16000, 40, { gpu: 'NVIDIA GeForce GT 710', vram: 1024 })).on, 'cpu', 'a card under 2 GB is not used');
  assert.ok(gpuGuessGbs('RTX 4090') > gpuGuessGbs('RTX 3060') && gpuGuessGbs('RTX 3060') > gpuGuessGbs('GTX 1650') && gpuGuessGbs('GTX 1650') > gpuGuessGbs('GTX 1050'));
});

test('the strongest takes the most: a card computer takes more layers than a slow laptop', () => {
  const card = pc('card', 32000, 40, { gpu: 'NVIDIA GeForce RTX 4070', vram: 12282, link: link(60, 3) });
  const lap = pc('laptop', 12000, 20, { link: link(60, 3) });
  const pl = planSplit({ model: q14, ctx: 2048, localFreeMb: 6000, localBw: 60, peers: [card, lap], net: { mbps: 60, rttMs: 3 }, share: true, all: true });
  const by = Object.fromEntries(pl.used.map((u) => [u.id, u]));
  assert.ok(by.card && by.laptop, 'both hold a part when all are asked for');
  assert.ok(by.card.layers > by.laptop.layers, `card ${by.card.layers} vs laptop ${by.laptop.layers}`);
  assert.ok(by.card.assignedMb <= 12282 * VRAM_SHARE + 1, 'never more than its VRAM share');
});

test('a device that would slow things down is left out, and the plan says why', () => {
  const fast = pc('fast', 16000, 60, { link: link(80, 2) });
  const slow = pc('slow', 16000, 4, { link: link(3, 40) });
  const pl = planSplit({ model: q14, ctx: 2048, localFreeMb: 5000, localBw: 60, peers: [fast, slow], net: { mbps: 3, rttMs: 40 }, share: true });
  assert.ok(pl.notNeeded.some((p) => p.id === 'slow'), `used ${pl.used.map((u) => u.id)} notNeeded ${pl.notNeeded.map((p) => p.id)}`);
  const lines = explainPlan(pl, 'Qwen2.5 14B');
  assert.ok(lines.some((l) => /^slow left out: the answers come faster without it .*network 3 MB\/s, 40 ms/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /^estimate: about [\d.]+–[\d.]+ tok\/s/.test(l)), lines.join('\n'));
});

test('when this computer alone is faster, the plan says so and suggests "here"', () => {
  const pl = planSplit({ model: q06, ctx: 2048, localFreeMb: 8000, localBw: 60, peers: [pc('other', 8000, 20, { link: link(20, 5) })], net: { mbps: 20, rttMs: 5 }, share: true });
  assert.equal(pl.fitsAlone, true);
  assert.equal(pl.aloneFaster, true);
  const lines = explainPlan(pl, 'Qwen3 0.6B');
  assert.ok(lines.some((l) => l.startsWith('suggestion: it fits on this computer alone and runs faster here')), lines.join('\n'));
});

test('tpsRange is a range, not one number', () => {
  assert.equal(tpsRange(10), '6–12');
  assert.equal(tpsRange(2), '1.2–2.3');
});
