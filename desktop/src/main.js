// kula for the desktop (8.11.2026): kula-node's chat page in a window of its own, for macOS and
// Windows. The app runs kula-node itself (Electron's own Node, through utilityProcess), so
// there is no terminal and no browser tab:
//   1. find kula-node: your own checkout when ~/.kula-node/desktop-source names one (changes
//      show after a reload, nothing to rebuild), else the copy inside the app
//   2. first launch: `kula-node setup` (llama.cpp b11157) with its lines on the start screen
//   3. `kula-node ui --no-open`: the page on 127.0.0.1 (or the one already running), shown here
// Everything the page does stays as it is: 127.0.0.1 only, the random prefix, same-origin posts.
import { app, BrowserWindow, clipboard, shell, utilityProcess } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.KULA_UI_PORT) || 50590;
const kulaHome = process.env.KULA_NODE_HOME || path.join(os.homedir(), '.kula-node');

// where kula-node lives: a checkout named in ~/.kula-node/desktop-source (your own, for quick
// changes), the copy in the app's Resources, or ../node when run from the repo with npm start
function kulaRoot() {
  const pick = (dir) => dir && fs.existsSync(path.join(dir, 'dist', 'bin', 'kula-node.js')) ? dir : null;
  let named = process.env.KULA_NODE_SOURCE || null;
  if (!named) { try { named = fs.readFileSync(path.join(kulaHome, 'desktop-source'), 'utf8').trim(); } catch {} }
  // a personal build (npm run app:mine) names its checkout in the app's own package.json
  if (!named) { try { named = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')).kulaSource || null; } catch {} }
  return pick(named) || (app.isPackaged ? pick(path.join(process.resourcesPath, 'kula-node')) : null) || pick(path.resolve(here, '..', '..', 'node'));
}

const root = kulaRoot();

// an app opened from the Finder gets PATH=/usr/bin:/bin:/usr/sbin:/sbin: Homebrew's cmake,
// ninja and adb (/opt/homebrew/bin on Apple silicon, /usr/local/bin on Intel) would not be
// found by setup or the cable steps, however they were installed (10.11.2026)
const BREW_BINS = ['/opt/homebrew/bin', '/usr/local/bin'];
const PATH = process.platform === 'darwin'
  ? [...new Set([...(process.env.PATH || '').split(':').filter(Boolean), ...BREW_BINS, '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':')
  : process.env.PATH;
const onPath = (cmd) => PATH.split(path.delimiter).some((d) => { try { fs.accessSync(path.join(d, cmd), fs.constants.X_OK); return true; } catch { return false; } });
let win = null;
let page = null;          // the `kula-node ui` this app started (null when one was already running)
let quitting = false;

// kula-node with these arguments; each output line to onLine; resolves with the exit code
function run(args, onLine = () => {}) {
  const child = utilityProcess.fork(path.join(root, 'dist', 'bin', 'kula-node.js'), args, {
    cwd: root, stdio: 'pipe', serviceName: 'kula-node', env: { ...process.env, PATH, KULA_UI_NO_BROWSER: '1' },
  });
  let buf = '';
  const feed = (d) => { buf += d.toString(); const parts = buf.split(/\r?\n/); buf = parts.pop(); for (const l of parts) if (l.trim()) onLine(l); };
  child.stdout?.on('data', feed);
  child.stderr?.on('data', feed);
  const done = new Promise((resolve) => child.once('exit', (code) => { if (buf.trim()) onLine(buf); resolve(code); }));
  return { child, done };
}

const say = (fn, ...a) => { if (win && !win.isDestroyed()) win.webContents.executeJavaScript(`window.${fn} && window.${fn}(...${JSON.stringify(a)})`).catch(() => {}); };

function waitForChoice(choices = ['retry', 'skip']) {
  return new Promise((resolve) => {
    const onHash = (_e, url) => { const h = new URL(url).hash.slice(1); if (choices.includes(h)) { win.webContents.off('did-navigate-in-page', onHash); resolve(h); } };
    win.webContents.on('did-navigate-in-page', onHash);
  });
}

// what building llama.cpp on a Mac needs, looked at before setup starts rather than after it
// fails: Apple's command line tools (the compiler), then cmake (Homebrew). ninja only speeds it up.
export function macNeeds() {
  const clt = spawnSync('xcode-select', ['-p'], { stdio: 'ignore' }).status === 0;
  const brew = BREW_BINS.some((d) => fs.existsSync(path.join(d, 'brew')));
  return [
    { id: 'clt', ok: clt, what: 'Apple’s command line tools (the compiler)', how: 'press “install”: macOS asks once and downloads them (a few minutes)', action: clt ? null : 'install' },
    { id: 'cmake', ok: onPath('cmake'), what: 'cmake, to build llama.cpp', how: brew ? 'in Terminal: brew install cmake ninja' : 'first Homebrew (brew.sh), then in Terminal: brew install cmake ninja', action: onPath('cmake') ? null : 'copy', copy: 'brew install cmake ninja', link: brew ? null : 'https://brew.sh' },
  ];
}

async function macReady() {
  if (process.platform !== 'darwin') return true;
  for (;;) {
    const needs = macNeeds();
    if (needs.every((n) => n.ok)) return true;
    say('needs', needs);
    const choice = await waitForChoice(['check', 'skip', 'install-clt', 'copy-cmake']);
    if (choice === 'skip') return false;
    if (choice === 'install-clt') spawn('xcode-select', ['--install'], { stdio: 'ignore', detached: true }).unref();
    if (choice === 'copy-cmake') clipboard.writeText('brew install cmake ninja');
  }
}

async function ensureLlama() {
  const check = run(['setup', '--check'], (l) => console.log(`setup --check: ${l}`));
  const code = await check.done;
  console.log(`kula: setup --check exited ${code}`);
  if (code === 0) return;
  // the page still works with phones without llama.cpp; "here" and "split" will say setup is missing
  if (!(await macReady())) return;
  say('step', 'setting up llama.cpp b11157: once on this computer, a few minutes');
  for (;;) {
    // setup lines also go to stdout, so a run without anyone at the window (CI) shows its progress
    const s = run(['setup'], (l) => { console.log(`setup: ${l}`); say('line', l); });
    const code = await s.done;
    console.log(`kula: setup exited ${code}`);
    if (code === 0) { say('step', 'llama.cpp is ready'); return; }
    say('failed', process.platform === 'darwin'
      ? 'setup did not finish. the lines above say why (on a mac: xcode-select --install, then brew install cmake ninja).'
      : 'setup did not finish. the lines above say why.');
    if ((await waitForChoice()) === 'skip') return;   // the page still works with phones; "here" and "split" will say setup is missing
    say('step', 'trying again');
  }
}

async function openPage() {
  say('step', 'starting the chat page');
  const url = await new Promise((resolve, reject) => {
    const p = run(['ui', '--no-open', '--port', String(PORT)], (l) => {
      const m = /(http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\/)/.exec(l);
      if (m) resolve(m[1]);
      say('line', l);
    });
    page = p.child;
    p.done.then((code) => {
      page = null;
      // exit 0 right after printing an address: a page was already running and we use that one
      if (!quitting && code !== 0) reject(new Error(`the chat page stopped (code ${code})`));
    });
  });
  console.log(`kula: opening ${url}`);
  await win.loadURL(url);
  console.log('kula: page loaded');
  // KULA_SNAP=<file.png>: a picture of the window a few seconds after the page loaded (checks)
  if (process.env.KULA_SNAP) snap(process.env.KULA_SNAP);
}

// the first try 4 s after the load, then up to 5 more 2 s apart; each try repaints first and
// waits at most 5 s for the picture; the file is written only when the picture is not empty
function snap(file) {
  const TRIES = 6;
  const attempt = async (n) => {
    let why;
    try {
      if (!win || win.isDestroyed()) throw new Error('no window');
      win.webContents.invalidate();
      const img = await Promise.race([
        win.webContents.capturePage(),
        new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      if (img === null) why = 'no answer in 5 s';
      else if (img.isEmpty()) why = 'empty';
      else {
        const png = img.toPNG();
        fs.writeFileSync(file, png);
        console.log(`kula: snap ${png.length} bytes (try ${n})`);
        return;
      }
    } catch (e) {
      why = e.message;
    }
    console.log(`kula: snap try ${n}: ${why}`);
    if (n < TRIES) setTimeout(() => attempt(n + 1), 2000);
    else console.log('kula: snap gave up');
  };
  setTimeout(() => attempt(1), 4000);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 380, minHeight: 500, title: 'kula', backgroundColor: '#f7f7f4', show: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => console.error(`kula: could not load ${url}: ${desc} (${code})`));
  // links out of the page (the learn tab, the brain map, hugging face) open in the browser
  const local = (u) => { try { return new URL(u).hostname === '127.0.0.1'; } catch { return false; } };
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url) && !local(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!local(url) && !url.startsWith('file:')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.on('closed', () => { win = null; });
  return win.loadFile(path.join(here, 'start.html'));
}

async function start() {
  console.log(`kula: starting, kula-node at ${root ?? 'not found'}`);
  await createWindow();
  console.log('kula: window up');
  if (!root) { say('failed', 'kula-node was not found inside the app. download it again.'); return; }
  // the copy inside the app (Resources on a mac, resources on linux and windows) needs no path
  const rel = app.isPackaged ? path.relative(process.resourcesPath, root) : null;
  const inside = rel !== null && !rel.startsWith('..') && !path.isAbsolute(rel);
  say('step', inside ? 'kula is starting' : `kula is starting from ${root}`);
  try {
    await ensureLlama();
    await openPage();
  } catch (e) {
    console.error('kula: start failed: ' + e.message);
    say('failed', e.message);
  }
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(start);
  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => { if (!win) start(); });
  app.on('before-quit', () => { quitting = true; if (page) page.kill(); });
}
