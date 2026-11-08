// Puts kula-node (built JavaScript, the chat page's static files, its few runtime packages)
// into build/kula-node, which electron-builder copies into the app's Resources. No compile of
// llama.cpp here: every computer does that once, on first launch (`kula-node setup`).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const node = path.resolve(here, '..', '..', 'node');
const out = path.resolve(here, '..', 'build', 'kula-node');

execFileSync('npm', ['run', 'build'], { cwd: node, stdio: 'inherit' });
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(node, 'dist'), path.join(out, 'dist'), { recursive: true });
fs.cpSync(path.join(node, 'src', 'ui', 'static'), path.join(out, 'src', 'ui', 'static'), { recursive: true });
fs.cpSync(path.join(node, 'src', 'dashboard', 'static'), path.join(out, 'src', 'dashboard', 'static'), { recursive: true });
const pkg = JSON.parse(fs.readFileSync(path.join(node, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', dependencies: pkg.dependencies }, null, 2));
fs.copyFileSync(path.join(node, 'package-lock.json'), path.join(out, 'package-lock.json'));
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: out, stdio: 'inherit' });
console.log(`staged kula-node ${pkg.version} in ${out}`);
