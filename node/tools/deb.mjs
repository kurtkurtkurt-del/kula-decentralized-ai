#!/usr/bin/env node
// A .deb around one packed linux binary, made with tar and ar only (nfpm is
// not needed; packaging/nfpm.yaml does the same with nfpm).
//
//   node tools/deb.mjs --bin dist/pack/kula-node-0.1.0-linux-x64 [--out dist/pack]
//
// Writes kula-node_<version>_<amd64|arm64>.deb next to the binary: it puts
// /usr/bin/kula-node in place, nothing else, and removes cleanly.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}\n${r.stderr}`);
}

export function makeDeb(bin, outDir, version = pkg.version) {
  const m = /linux-(x64|arm64)/.exec(path.basename(bin));
  if (!m) throw new Error(`${bin}: the name must say linux-x64 or linux-arm64`);
  const arch = m[1] === 'x64' ? 'amd64' : 'arm64';
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-deb-'));
  const data = path.join(work, 'data');
  const ctrl = path.join(work, 'control');
  fs.mkdirSync(path.join(data, 'usr', 'bin'), { recursive: true });
  fs.mkdirSync(ctrl);
  fs.copyFileSync(bin, path.join(data, 'usr', 'bin', 'kula-node'));
  fs.chmodSync(path.join(data, 'usr', 'bin', 'kula-node'), 0o755);
  const kb = Math.ceil(fs.statSync(bin).size / 1024);
  fs.writeFileSync(path.join(ctrl, 'control'), [
    'Package: kula-node', `Version: ${version}`, 'Section: utils', 'Priority: optional', `Architecture: ${arch}`,
    `Installed-Size: ${kb}`, 'Maintainer: kurtkurtkurt-del <noreply@github.com>',
    'Homepage: https://github.com/kurtkurtkurt-del/kula-decentralized-ai',
    'Description: Make this computer a worker in a kula phone cluster.',
    ' One binary. llama.cpp is fetched on first use with "kula-node setup".', '',
  ].join('\n'));
  fs.writeFileSync(path.join(work, 'debian-binary'), '2.0\n');
  const tarOwner = ['--owner=0', '--group=0', '--numeric-owner'];
  sh('tar', ['-czf', path.join(work, 'control.tar.gz'), ...tarOwner, '-C', ctrl, 'control'], work);
  sh('tar', ['-czf', path.join(work, 'data.tar.gz'), ...tarOwner, '-C', data, 'usr'], work);
  const out = path.join(outDir, `kula-node_${version}_${arch}.deb`);
  fs.rmSync(out, { force: true });
  sh('ar', ['rc', out, 'debian-binary', 'control.tar.gz', 'data.tar.gz'], work);
  fs.rmSync(work, { recursive: true, force: true });
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const get = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
  const bin = get('--bin');
  if (!bin) { console.error('usage: node tools/deb.mjs --bin <kula-node-<v>-linux-<arch>> [--out dir]'); process.exit(2); }
  const out = makeDeb(path.resolve(bin), path.resolve(get('--out') ?? path.dirname(bin)));
  console.log(out);
}
