// god's eye, one source for two homes (11.11.2026, docs/BEYIN.md): the app bundles kula-node's
// own node/src/godseye through @godseye/core, never a copy. What reaches the phone must be plain
// TypeScript: no node: module, no package, nothing of kula-node; the computer's files, node:crypto
// and black box (node.ts, box.ts) stay out. And it compiles under the app's own tsconfig with no
// node types at all, so a Buffer, a process or a NodeJS.Timeout slipping in fails here.
import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const APP = path.resolve(__dirname, '../..');
const GODSEYE = path.resolve(APP, '../node/src/godseye');
const ENTRY = path.join(GODSEYE, 'core.ts');

/** every file core.ts reaches, by its relative imports (type-only ones too: tsc follows them) */
function reach(): { files: string[]; bad: string[] } {
  const seen = new Set<string>();
  const bad: string[] = [];
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)) {
      const spec = m[1];
      const rel = path.relative(GODSEYE, file);
      if (!spec.startsWith('.')) { bad.push(`${rel} imports ${spec}`); continue; }
      const target = path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts'));
      if (!target.startsWith(GODSEYE + path.sep)) { bad.push(`${rel} imports ${spec}, outside god's eye`); continue; }
      walk(target);
    }
  };
  walk(ENTRY);
  return { files: [...seen].map((f) => path.relative(GODSEYE, f)).sort(), bad };
}

describe('the eye the phone bundles', () => {
  it('reaches only plain files of god\'s eye: no node:, no package, not node.ts nor box.ts', () => {
    const { files, bad } = reach();
    expect(bad).toEqual([]);
    expect(files).toEqual(expect.arrayContaining(['core.ts', 'eye.ts', 'types.ts', 'platform.ts', 'hash.ts', 'boxfacts.ts', 'branches/index.ts', 'branches/trust.ts', 'branches/guard.ts']));
    expect(files).not.toContain('node.ts');
    expect(files).not.toContain('box.ts');
    expect(files.filter((f) => f.startsWith('branches/')).length).toBeGreaterThanOrEqual(13);   // the twelve and their helpers
  });

  it('is the same source the app imports: @godseye points at node/src/godseye, not a copy', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(APP, 'tsconfig.json'), 'utf8'));
    expect(cfg.compilerOptions.paths['@godseye/*']).toEqual(['../node/src/godseye/*']);
    expect(fs.existsSync(path.join(APP, 'src', 'godseye'))).toBe(false);
  });

  it('compiles under the app\'s tsconfig without node\'s types', () => {
    const parsed = ts.getParsedCommandLineOfConfigFile(path.join(APP, 'tsconfig.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
    expect(parsed).toBeDefined();
    const program = ts.createProgram([ENTRY], { ...parsed!.options, types: [], noEmit: true });
    const diags = ts.getPreEmitDiagnostics(program).map((d) => {
      const where = d.file ? `${path.relative(APP, d.file.fileName)}: ` : '';
      return where + ts.flattenDiagnosticMessageText(d.messageText, '\n');
    });
    expect(diags).toEqual([]);
  }, 60_000);
});
