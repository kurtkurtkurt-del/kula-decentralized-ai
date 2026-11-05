// `kula-node ledger`: prints the ledger and, on request, checks it against
// this device's key.
import path from 'node:path';
import { home } from './paths.js';
import { loadOrCreate } from './audit/key.js';
import { chainFiles, readLines, verifyChain } from './audit/ledger.js';

export function ledgerFile(): string {
  return path.join(home(), 'ledger.jsonl');
}

export function ledgerCommand(opts: { verify: boolean; tail?: number }, out: (s: string) => void = console.log): number {
  const file = ledgerFile();
  const files = chainFiles(file);
  if (!opts.verify || opts.tail !== undefined) {
    const lines = opts.tail === undefined ? files.flatMap(readLines) : readLines(file).slice(-Math.max(0, opts.tail));
    for (const l of lines) out(l);
  }
  if (!opts.verify) return 0;
  const key = loadOrCreate();
  const r = verifyChain(file, key.publicKey);
  for (const f of r.files) {
    out(`${f.file}: ${f.count} lines${f.problems.length ? '' : ', ok'}`);
    for (const p of f.problems) out(`  line ${p.n}: bad ${p.reason}`);
  }
  out(r.ok ? `ledger ok: ${r.count} lines, one chain, signed by ${key.id}` : `ledger broken`);
  return r.ok ? 0 : 1;
}
