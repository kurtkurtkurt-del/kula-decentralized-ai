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

// on windows npm is npm.cmd, which only runs through a shell
const shell = process.platform === 'win32';
execFileSync('npm', ['run', 'build'], { cwd: node, stdio: 'inherit', shell });
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(node, 'dist'), path.join(out, 'dist'), { recursive: true });
fs.cpSync(path.join(node, 'src', 'ui', 'static'), path.join(out, 'src', 'ui', 'static'), { recursive: true });
fs.cpSync(path.join(node, 'src', 'dashboard', 'static'), path.join(out, 'src', 'dashboard', 'static'), { recursive: true });
const pkg = JSON.parse(fs.readFileSync(path.join(node, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', dependencies: pkg.dependencies }, null, 2));
fs.copyFileSync(path.join(node, 'package-lock.json'), path.join(out, 'package-lock.json'));
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: out, stdio: 'inherit', shell });

// windows: llama.cpp's release is built with msvc and needs its runtime (msvcp140, vcruntime140,
// vcruntime140_1), which a fresh windows does not have. Ship visual studio's redistributable copy
// in vcrt/ (app-local, as microsoft allows); kula-node setup places it beside llama-server.
if (process.platform === 'win32') {
  const from = vcRuntimeSource();
  const to = path.join(out, 'vcrt');
  fs.mkdirSync(to, { recursive: true });
  const dlls = fs.readdirSync(from).filter((f) => f.toLowerCase().endsWith('.dll'));
  for (const f of dlls) fs.copyFileSync(path.join(from, f), path.join(to, f));
  const have = new Set(dlls.map((f) => f.toLowerCase()));
  const miss = ['msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'].filter((f) => !have.has(f));
  if (miss.length) throw new Error(`the vc++ runtime in ${from} has no ${miss.join(', ')}`);
  console.log(`vc++ runtime: ${dlls.length} dlls from ${from}`);
}
console.log(`staged kula-node ${pkg.version} in ${out}`);

// KULA_VCRT_SRC, else the newest x64 Microsoft.VC*.CRT under the latest visual studio's VC\Redist\MSVC
function vcRuntimeSource() {
  if (process.env.KULA_VCRT_SRC) return process.env.KULA_VCRT_SRC;
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const vs = execFileSync(vswhere, ['-latest', '-products', '*', '-property', 'installationPath']).toString().trim();
  const redist = path.join(vs, 'VC', 'Redist', 'MSVC');
  const num = (v) => v.split('.').map(Number);
  const newer = (a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
  const versions = fs.readdirSync(redist).filter((d) => /^\d+\.\d+\.\d+$/.test(d)).sort(newer);
  for (const v of versions.reverse()) {
    const x64 = path.join(redist, v, 'x64');
    const crt = fs.existsSync(x64) && fs.readdirSync(x64).find((d) => /^Microsoft\.VC\d+\.CRT$/.test(d));
    if (crt) return path.join(x64, crt);
  }
  throw new Error(`no x64 Microsoft.VC*.CRT under ${redist} (versions: ${versions.join(', ') || 'none'}); set KULA_VCRT_SRC`);
}
