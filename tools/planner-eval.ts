// Before/after: the old planSplit (cluster.ts until 5.11.2026: need = file × 1.1, fill the
// fastest first, share by speed) against the simulator's planner, both scored by the same
// cost model. Prints the markdown table in docs/PLANNER.md. Run from node/:
//   node --import tsx ../tools/planner-eval.ts
import { estimateSplit, estimateAlone, planShares, MB, type SimDevice, type SimModel, type SimNet } from '../app/src/llm/sim/model.ts';

const models: Record<string, SimModel> = {
  'qwen3 0.6b': { id: 'q06', fileMb: 639446688 / MB, layers: 28, hidden: 1024, vocab: 151936, bytesPerParam: 1, kvMbPer1k: 56 },
  'qwen2.5 1.5b': { id: 'q15', fileMb: 1117320736 / MB, layers: 28, hidden: 1536, vocab: 151936, bytesPerParam: 0.55, kvMbPer1k: 28 },
  'llama 3.2 3b': { id: 'l3b', fileMb: 2019377696 / MB, layers: 28, hidden: 3072, vocab: 128256, bytesPerParam: 0.55, kvMbPer1k: 112 },
  'qwen2.5 7b': { id: 'q7', fileMb: 4683074240 / MB, layers: 28, hidden: 3584, vocab: 152064, bytesPerParam: 0.55, kvMbPer1k: 56 },
};
const D = {
  s25: { id: 's25+', capMb: 6500 * 0.7, bw: 65.9, eff: 0.6 }, s25w: { id: 's25+', capMb: 6500 * 0.75, bw: 65.9, eff: 0.6 },
  pixel: { id: 'pixel 8', capMb: 3800 * 0.75, bw: 28, eff: 0.6 }, mid: { id: 'mid 6gb', capMb: 2600 * 0.75, bw: 14, eff: 0.6 }, old: { id: 'old 4gb', capMb: 1400 * 0.75, bw: 8, eff: 0.6 },
  midL: { id: 'mid 6gb', capMb: 2600 * 0.7, bw: 14, eff: 0.6 },
  emu: { id: 'emulator', capMb: 1100 * 0.7, bw: 12, eff: 0.6 }, mac: { id: 'mac m1', capMb: 4000 * 0.75, bw: 68, eff: 0.3 }, gpu: { id: '4090', capMb: 22000 * 0.75, bw: 1008, eff: 0.6 },
};
const N: Record<string, SimNet> = { 'wi-fi 5': { mbps: 30, rttMs: 3 }, 'wi-fi 2.4': { mbps: 5, rttMs: 8 }, 'emu nat': { mbps: 1.3, rttMs: 2 }, hotspot: { mbps: 8, rttMs: 12 } };

// the old planner, verbatim in spirit: need = file × 1.1, no ctx, no output-layer rule
function legacy(model: SimModel, local: SimDevice, workers: SimDevice[], share: boolean): { rows: { dev: SimDevice; mb: number }[]; needMb: number } | 'toobig' {
  const needMb = Math.round(model.fileMb * 1.1);
  const rows = [{ dev: local, mb: 0, cap: local.capMb }, ...workers.map((w) => ({ dev: w, mb: 0, cap: w.capMb }))];
  const total = rows.reduce((a, r) => a + r.cap, 0);
  if (needMb > total) return 'toobig';
  const fitsAlone = needMb <= local.capMb;
  if (fitsAlone && !share) rows[0].mb = needMb;
  else if (fitsAlone && share) {
    const sumBw = rows.reduce((a, r) => a + r.dev.bw, 0);
    let left = needMb;
    for (const r of rows) r.mb = Math.min(r.cap, (needMb * r.dev.bw) / sumBw);
    left -= rows.reduce((a, r) => a + r.mb, 0);
    for (const r of [...rows].sort((a, b) => b.dev.bw - a.dev.bw)) {
      if (left <= 0) break;
      const extra = Math.min(r.cap - r.mb, left);
      r.mb += extra;
      left -= extra;
    }
  } else {
    let left = needMb;
    for (const r of [...rows].sort((a, b) => b.dev.bw - a.dev.bw)) {
      const take = Math.min(r.cap, left);
      r.mb = take;
      left -= take;
      if (left <= 0) break;
    }
  }
  return { rows: rows.map(({ dev, mb }) => ({ dev, mb })), needMb };
}
const scoreLegacy = (model: SimModel, rows: { dev: SimDevice; mb: number }[], net: SimNet) => {
  const used = rows.filter((r, i) => i === 0 || r.mb > 0);
  return used.length === 1 ? estimateAlone(model, rows[0].dev) : estimateSplit(model, used, net);
};
const cases: { name: string; model: string; local: SimDevice; workers: SimDevice[]; net: string; share: boolean; ctx?: number }[] = [
  { name: 'emulator + mac, nat', model: 'qwen3 0.6b', local: D.emu, workers: [D.mac], net: 'emu nat', share: true },
  { name: 's25+ alone fits, share with 3 phones', model: 'qwen2.5 1.5b', local: D.s25, workers: [D.pixel, D.mid, D.old], net: 'wi-fi 5', share: true },
  { name: 's25+ + mac, wi-fi 5', model: 'llama 3.2 3b', local: D.s25, workers: [D.mac], net: 'wi-fi 5', share: true },
  { name: 's25+ + mac, wi-fi 2.4', model: 'llama 3.2 3b', local: D.s25, workers: [D.mac], net: 'wi-fi 2.4', share: true },
  { name: 'mid 6gb + 3 phones, 7b, wi-fi 5', model: 'qwen2.5 7b', local: D.midL, workers: [D.s25w, D.pixel, D.old], net: 'wi-fi 5', share: true },
  { name: 'mid 6gb + 3 phones, 7b, hotspot', model: 'qwen2.5 7b', local: D.midL, workers: [D.s25w, D.pixel, D.old], net: 'hotspot', share: true },
  { name: 'mid 6gb + 4090, 7b, wi-fi 5', model: 'qwen2.5 7b', local: D.midL, workers: [D.gpu], net: 'wi-fi 5', share: true },
  { name: 'mid 6gb + 4090, 7b, ctx 8192', model: 'qwen2.5 7b', local: D.midL, workers: [D.gpu], net: 'wi-fi 5', share: true, ctx: 8192 },
  { name: 'old 4gb + pixel, 3b, wi-fi 2.4', model: 'llama 3.2 3b', local: { ...D.old, capMb: 1400 * 0.7 }, workers: [D.pixel], net: 'wi-fi 2.4', share: true },
];
const fmt = (rows: { dev: SimDevice; mb: number }[]) => rows.filter((r) => r.mb > 0).map((r) => `${r.dev.id} ${Math.round(r.mb)}`).join(' · ');
console.log('| case | model | before: shares (mb) | before tok/s · load | after: shares (mb) | after tok/s · load | note |');
console.log('|---|---|---|---|---|---|---|');
for (const c of cases) {
  const m = models[c.model];
  const ctx = c.ctx ?? 2048;
  const old = legacy(m, c.local, c.workers, c.share);
  let before = 'toobig', beforeEst = '—';
  if (old !== 'toobig') {
    const e = scoreLegacy(m, old.rows, N[c.net]);
    before = fmt(old.rows);
    beforeEst = `${e.tps} · ${e.loadS} s`;
  }
  let after = '', afterEst = '', note = '';
  try {
    const p = planShares({ model: m, ctx, local: c.local, workers: c.workers, net: N[c.net], share: c.share });
    after = fmt([{ dev: c.local, mb: p.localMb }, ...p.used.map((u) => ({ dev: c.workers.find((w) => w.id === u.id)!, mb: u.assignedMb }))]);
    afterEst = `${p.est.tps} · ${p.est.loadS} s`;
    if (p.aloneFaster && p.estAlone) note = `alone ${p.estAlone.tps} tok/s is faster`;
    if (old !== 'toobig' && old.rows.filter((r) => r.mb > 0).length > 1 + p.used.length) note += (note ? '; ' : '') + 'fewer devices';
    const oldLocal = old !== 'toobig' ? old.rows[0].mb : 0;
    if (old !== 'toobig' && oldLocal < 300 + (m.vocab * m.hidden * m.bytesPerParam) / MB) note += (note ? '; ' : '') + 'before: no room for the output layer here';
  } catch (e) {
    after = (e as Error).message;
    afterEst = '—';
  }
  console.log(`| ${c.name} | ${c.model}${c.ctx ? ` ctx ${c.ctx}` : ''} | ${before} | ${beforeEst} | ${after} | ${afterEst} | ${note} |`);
}
