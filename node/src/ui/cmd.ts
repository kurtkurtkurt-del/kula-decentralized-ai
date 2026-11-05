// `kula-node ui [--port 50590] [--no-open] [--new-token] [--new-prefix] [--lan]`: the chat page on
// 127.0.0.1 (and, with --lan or the page's switch, an invite for devices on this wi-fi). The
// address stays the same across restarts (~/.kula-node/ui-prefix); a second `kula-node ui` while
// one runs opens that one and exits 0. `--stop` stops the running one; `--install-mac [--login]`
// and `--uninstall-mac` make it one click on a mac (macapp.ts).
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import qrcode from 'qrcode-terminal';
import { Engine } from './engine.js';
import { ChatStore } from './store.js';
import { ProjectRunner } from './projects.js';
import { startUi, loadOrCreateToken, loadOrCreatePrefix, UI_PORT, PREFIX_RE } from './server.js';
import { installMac, uninstallMac, macPaths, type Run } from './macapp.js';
import { home, packageRoot } from '../paths.js';
import { isPacked, version } from '../build.js';

type Flags = Record<string, string | boolean>;
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (s: string) => console.error(`${stamp()}  ${s}`);

export function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try {
    const p = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' });
    p.on('error', () => log(`could not open a browser; open ${url} yourself`));
    p.unref();
  } catch { log(`could not open a browser; open ${url} yourself`); }
}

// the invite on the terminal: a qr to scan with any phone's camera, and the address under it
function printInvite(url: string | null): void {
  if (!url) return;
  // the url holds the invite token: a terminal gets it, a log file (mac app, login item) does not
  if (!process.stdout.isTTY) { console.log('invites on: the qr code is on the page (invite a device)'); return; }
  console.log('\ninvite a device on this wi-fi: scan this with its camera');
  qrcode.generate(url, { small: true }, (q) => console.log(q));
  console.log(`${url}\n(plain http on this network; "new invite" on the page ends it)\n`);
}

function get(port: number, p: string, timeoutMs: number): Promise<{ code: number; location?: string; body: string } | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (body.length < 4096) body += d; });
      res.on('end', () => resolve({ code: res.statusCode ?? 0, location: res.headers.location, body }));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

// Is kula's chat page answering on this port? `/` redirects to the page; `<page>health` says
// {"kula":"ui"}. Returns the page's url (with whatever prefix that one runs with) or null.
export async function findRunningUi(port: number, timeoutMs = 1500): Promise<string | null> {
  const root = await get(port, '/', timeoutMs);
  const m = root && root.code === 302 ? /^\/([0-9a-f]+)\/$/.exec(root.location ?? '') : null;
  if (!m || !PREFIX_RE.test(m[1])) return null;
  const h = await get(port, `/${m[1]}/health`, timeoutMs);
  try { if (h?.code === 200 && JSON.parse(h.body)?.kula === 'ui') return `http://127.0.0.1:${port}/${m[1]}/`; } catch {}
  return null;
}

const pidFile = () => path.join(home(), 'ui.pid');
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// stop the page this kula-node started (its pid is in ~/.kula-node/ui.pid)
export async function stopUi(port: number): Promise<number> {
  const url = await findRunningUi(port);
  let pid = 0;
  try { pid = Number(fs.readFileSync(pidFile(), 'utf8').trim()); } catch {}
  if (!url) { console.log(`no chat page answers on 127.0.0.1:${port}`); return 0; }
  if (!Number.isInteger(pid) || pid <= 1 || !alive(pid)) {
    console.error(`a chat page answers at ${url}, but not one this kula-node started (no ~/.kula-node/ui.pid): stop it where it runs`);
    return 1;
  }
  process.kill(pid, 'SIGTERM');
  for (let i = 0; i < 50 && (await findRunningUi(port, 500)); i++) await new Promise((r) => setTimeout(r, 100));
  if (await findRunningUi(port, 500)) { console.error(`it is still up (pid ${pid})`); return 1; }
  console.log('stopped the chat page');
  return 0;
}

// how the mac app starts kula-node: this very binary when packed; the packed binary in
// node/dist-bin when one was made; else node and the built dist (built here first)
function macStart(build: boolean): { start: string[]; icon: string | null } {
  if (isPacked()) return { start: [process.execPath], icon: null };
  const root = packageRoot();
  const icon = path.join(path.dirname(root), 'app', 'assets', 'icon.png');
  const bin = path.join(root, 'dist-bin', `kula-node-mac-${process.arch}`);
  if (fs.existsSync(bin)) return { start: [bin], icon };
  // a stable node path (the shell's, e.g. /usr/local/bin/node), not a versioned cellar one
  const which = spawnSync('/bin/sh', ['-c', 'command -v node'], { encoding: 'utf8' });
  const node = which.status === 0 && which.stdout.trim().startsWith('/') ? which.stdout.trim() : process.execPath;
  const js = path.join(root, 'dist', 'bin', 'kula-node.js');
  if (build) {
    console.log('building kula-node (npm run build) …');
    const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    const r = spawnSync('/usr/bin/nice', ['-n', '5', process.execPath, tsc, '-p', 'tsconfig.json'], { cwd: root, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('the build failed: run `npm ci && npm run build` in node/ and try again');
  }
  if (!fs.existsSync(js)) throw new Error(`${js} is missing: run \`npm run build\` in node/`);
  return { start: [node, js], icon };
}

export interface UiDeps {
  open?: (url: string) => void;      // the browser; tests pass a fake
  until?: Promise<void>;             // stop when this settles (tests); default: ctrl-c / SIGTERM
  run?: Run;                         // launchctl, sips, iconutil (tests)
  userHome?: string;                 // ~ for ~/Applications and ~/Library (tests)
  build?: boolean;                   // install-mac builds node/dist first (default true)
}

export async function uiCommand(flags: Flags, deps: UiDeps = {}): Promise<number> {
  const port = flags.port !== undefined && flags.port !== true ? Number(flags.port) : UI_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error('--port must be a port number'); return 2; }
  const open = deps.open ?? openBrowser;

  if (flags['install-mac'] === true || flags['uninstall-mac'] === true) {
    if (process.platform !== 'darwin' && !deps.run) { console.error('--install-mac / --uninstall-mac are for macOS'); return 2; }
    const userHome = deps.userHome ?? os.homedir();
    if (flags['uninstall-mac'] === true) {
      const gone = uninstallMac({ userHome, kulaHome: home(), run: deps.run });
      console.log(gone.length ? `removed:\n${gone.map((g) => `  ${g}`).join('\n')}` : 'nothing to remove');
      if (await findRunningUi(port)) console.log(`the chat page still runs; \`kula-node ui --stop\` stops it`);
      return 0;
    }
    if (port === 0) { console.error('--install-mac needs a fixed --port'); return 2; }
    let how;
    try { how = macStart(deps.build !== false); } catch (e) { console.error((e as Error).message); return 1; }
    const r = installMac({ userHome, kulaHome: home(), start: how.start, port, icon: how.icon, version: version(packageRoot()), login: flags.login === true, run: deps.run });
    console.log(`made ${r.app}`);
    console.log(`  starts: ${how.start.join(' ')} ui --no-open --port ${port}`);
    if (r.icon) console.log(`  icon: ${r.icon}`);
    if (r.agent) console.log(`login item: ${r.agent}${r.loaded ? ' (loaded: the page is starting now and at every login)' : ''}`);
    for (const n of r.notes) console.log(`note: ${n}`);
    console.log(`log: ${macPaths(userHome, home()).log}`);
    console.log('\nopen it: Spotlight (cmd-space) → "kula", or double-click it in ~/Applications.');
    console.log('keep it in the Dock: open ~/Applications in Finder (shift-cmd-h, then Applications) and drag kula onto the Dock.');
    console.log('the page stays at the same address; bookmark it. `kula-node ui --stop` stops it; --uninstall-mac removes all this.');
    return 0;
  }

  if (flags.stop === true) return stopUi(port);

  const rotate = flags['new-prefix'] === true;
  const prefix = loadOrCreatePrefix(rotate);

  // one is already up: open that one (port 0 means "any free port", never a running page)
  const already = async () => {
    const url = port ? await findRunningUi(port) : null;
    if (!url) return false;
    console.log(`the chat page already runs: ${url}`);
    if (!url.includes(`/${prefix}/`)) console.log('(at its old address: stop it with `kula-node ui --stop` and start again for the new one)');
    if (flags['no-open'] !== true) open(url);
    return true;
  };
  if (await already()) return 0;

  const engine = new Engine({ peersFile: typeof flags.file === 'string' ? flags.file : undefined, log });
  const token = loadOrCreateToken(flags['new-token'] === true);
  let ui;
  try {
    const store = new ChatStore();
    const projects = new ProjectRunner(engine, store, undefined, { log });
    ui = await startUi({ port, engine, store, token, prefix, log, onInvite: printInvite, projects });
    projects.start();
  } catch (e) {
    await engine.close();
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      if (await already()) return 0;
      console.error(`port ${port} is taken by something else: stop it, or pass --port <n>`);
      return 1;
    }
    throw e;
  }
  const pid = pidFile();
  try { fs.writeFileSync(pid, `${process.pid}\n`, { mode: 0o600 }); } catch {}
  console.log(`the chat page: ${ui.url}  (this computer only; the address stays the same, bookmark it)`);
  // the token goes to a terminal, never to a log file (the mac app and the login item log stdout)
  console.log(`openai endpoint: ${ui.openaiBase}  token: ${process.stdout.isTTY ? ui.token : `in ${path.join(home(), 'ui-token')}`}`);
  console.log('on the phone: kula → share this phone; then "connect" on the page. ctrl-c stops.');
  if (flags.lan === true) {
    const info = await ui.invite.set(true);
    if (info.error) console.error(`invite mode did not start: ${info.error}`);
  }
  if (flags['no-open'] !== true) open(ui.url);
  await (deps.until ?? new Promise<void>((resolve) => {
    const done = () => resolve();
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  }));
  log('stopping');
  await ui.close();
  await engine.close();
  try { if (fs.readFileSync(pid, 'utf8').trim() === String(process.pid)) fs.rmSync(pid); } catch {}
  return 0;
}
