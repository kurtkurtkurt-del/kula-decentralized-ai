// The version string. A packed binary (tools/pack.mjs) has it baked in by
// esbuild; a checkout reads node/package.json so the two never drift.
import fs from 'node:fs';
import path from 'node:path';
import { packageRoot, isPacked } from './paths.js';

declare const __KULA_VERSION__: string | undefined;

function fromPackage(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')) as { version?: string };
    if (pkg.version) return pkg.version;
  } catch {}
  return '0.0.0';
}

export const VERSION: string = typeof __KULA_VERSION__ === 'string' ? __KULA_VERSION__ : fromPackage();

// "packed" for a single-file binary, "source" for a checkout under tsx/dist.
export const DIST: 'packed' | 'source' = isPacked() ? 'packed' : 'source';
