// the suite in two phases (L8 P48): the light files first, then the heavy replays, so a long
// replay never holds a core while a wall-clock assert runs. Both phases always run.
// `node tools/test.mjs --only=light` (or `--only=heavy`) runs one.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** the files that replay for minutes: the bench files and the learning replay */
const isHeavy = (name) => name.startsWith('godseye-bench') || name === 'godseye-learning.test.ts';

/** every `*.test.ts` name in exactly one of light and heavy; anything else in neither */
export function partition(files) {
  const light = [];
  const heavy = [];
  for (const f of files) {
    const name = path.basename(f);
    if (!name.endsWith('.test.ts')) continue;
    (isHeavy(name) ? heavy : light).push(f);
  }
  return { light, heavy };
}

function main() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const only = process.argv.slice(2).find((a) => a.startsWith('--only='))?.slice('--only='.length);
  if (only !== undefined && only !== 'light' && only !== 'heavy') {
    console.error(`--only takes light or heavy, not ${only}`);
    process.exit(2);
  }
  const files = fs.readdirSync(path.join(root, 'test')).sort().map((f) => `test/${f}`);
  const phases = partition(files);
  const results = [];
  const t0 = Date.now();
  for (const name of ['light', 'heavy']) {
    if (only !== undefined && only !== name) continue;
    const list = phases[name];
    const t = Date.now();
    const r = spawnSync(process.execPath, ['--import', 'tsx', '--test', '--test-force-exit', '--test-timeout=120000', ...list], { stdio: 'inherit', cwd: root });
    const code = r.status ?? 1;
    results.push({ name, n: list.length, code, ms: Date.now() - t });
  }
  for (const p of results) console.log(`phase ${p.name}: ${p.n} files, exit ${p.code}, ${p.ms} ms`);
  console.log(`total: ${results.reduce((a, p) => a + p.n, 0)} files, ${Date.now() - t0} ms`);
  process.exit(results.some((p) => p.code !== 0) ? 1 : 0);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
