// What kind of kula-node this is: run from the sources (tsx / dist) or packed
// into one executable by tools/pack.mjs, which replaces the two names below
// with literals at bundle time.
import fs from 'node:fs';
import path from 'node:path';

declare const __KULA_NODE_VERSION__: string | undefined;
declare const __KULA_PACKED__: boolean | undefined;

export function isPacked(): boolean {
  return typeof __KULA_PACKED__ === 'boolean' && __KULA_PACKED__;
}

let cached: string | null = null;

// The version from node/package.json (baked in when packed).
export function version(pkgRoot: string): string {
  if (typeof __KULA_NODE_VERSION__ === 'string') return __KULA_NODE_VERSION__;
  if (cached) return cached;
  try {
    cached = String(JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version);
  } catch { cached = '0.0.0'; }
  return cached;
}
