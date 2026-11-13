// Where kula-node keeps its things: ~/.kula-node by default (KULA_NODE_HOME overrides).
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isPacked } from './build.js';

export function home(): string {
  const h = process.env.KULA_NODE_HOME || path.join(os.homedir(), '.kula-node');
  fs.mkdirSync(h, { recursive: true });
  return h;
}

export function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

// The folder that holds node/ (works from src/ under tsx and from dist/ after a build).
// Packed into one executable there is no package folder: the executable's own folder stands in.
export function packageRoot(): string {
  if (isPacked()) return path.dirname(process.execPath);
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

// The repository root above node/, following git worktrees back to the main
// checkout, because a shared build lives next to the main checkout.
export function repoRoots(): string[] {
  if (isPacked()) return [];
  const roots = new Set<string>();
  const pkg = packageRoot();
  roots.add(path.dirname(pkg));
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: pkg, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      .toString().trim();
    if (common) roots.add(path.dirname(common));
  } catch {}
  return [...roots];
}
