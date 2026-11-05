// The chat page's stable address and the mac app: the prefix is kept and reused, --new-prefix
// makes a new one, a second `kula-node ui` while one runs opens that one and exits 0, the
// health route says what it is and nothing more; --install-mac writes a bundle that plutil
// accepts with an executable launcher (and an icon when sips/iconutil exist), --login a valid
// LaunchAgent (launchctl faked), and --uninstall-mac removes both. Everything in a temp HOME.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const USER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-mac-home-'));
const HOME = path.join(USER_HOME, '.kula-node');
process.env.KULA_NODE_HOME = HOME;

const { startUi, loadOrCreatePrefix, PREFIX_RE } = await import('../src/ui/server.ts');
const { uiCommand, findRunningUi } = await import('../src/ui/cmd.ts');
const { Engine } = await import('../src/ui/engine.ts');
const { ChatStore } = await import('../src/ui/store.ts');
const mac = await import('../src/ui/macapp.ts');

after(() => fs.rmSync(USER_HOME, { recursive: true, force: true }));

const has = (bin: string) => fs.existsSync(bin);
const quiet = async <T>(f: () => Promise<T>): Promise<T> => {
  const l = console.log, e = console.error;
  console.log = () => {}; console.error = () => {};
  try { return await f(); } finally { console.log = l; console.error = e; }
};
function fetchText(url: string): Promise<{ code: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ code: res.statusCode ?? 0, body: b })); }).on('error', reject);
  });
}

test('the prefix is kept in ~/.kula-node/ui-prefix (600) and reused; --new-prefix rotates it', () => {
  const a = loadOrCreatePrefix();
  assert.match(a, PREFIX_RE);
  assert.equal(loadOrCreatePrefix(), a);
  const file = path.join(HOME, 'ui-prefix');
  assert.equal(fs.readFileSync(file, 'utf8').trim(), a);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const b = loadOrCreatePrefix(true);
  assert.notEqual(b, a);
  assert.equal(loadOrCreatePrefix(), b);
  fs.writeFileSync(file, 'not a prefix\n');
  assert.match(loadOrCreatePrefix(), PREFIX_RE);
});

test('a restart keeps the address; health says kula and nothing more; a bad prefix is refused', async () => {
  const prefix = loadOrCreatePrefix();
  const mk = () => startUi({ port: 0, engine: new Engine(), store: new ChatStore(path.join(HOME, 'chats-t')), token: 'kula-' + 'a'.repeat(40), prefix });
  const one = await mk();
  assert.equal(one.url, `http://127.0.0.1:${one.port}/${prefix}/`);
  const h = await fetchText(`${one.url}health`);
  assert.equal(h.code, 200);
  assert.deepEqual(JSON.parse(h.body), { kula: 'ui' });
  assert.equal((await fetchText(`http://127.0.0.1:${one.port}/health`)).code, 404); // outside the prefix: nothing
  assert.equal(await findRunningUi(one.port), one.url);
  await one.close();
  assert.equal(await findRunningUi(one.port, 300), null);
  const two = await mk();
  assert.equal(two.prefix, prefix);
  await two.close();
  await assert.rejects(startUi({ port: 0, engine: new Engine(), prefix: '../x' }), /24 hex/);
});

test('findRunningUi does not mistake another server for the page', async () => {
  const s = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(302, { location: '/0123456789abcdef01234567/' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as any).port;
  assert.equal(await findRunningUi(port), null);
  s.close();
});

test('a second `kula-node ui` while one runs opens that one and exits 0; something else on the port fails', async () => {
  const prefix = loadOrCreatePrefix();
  const running = await startUi({ port: 0, engine: new Engine(), store: new ChatStore(path.join(HOME, 'chats-t')), token: 'kula-' + 'b'.repeat(40), prefix });
  const opened: string[] = [];
  const code = await quiet(() => uiCommand({ port: String(running.port) }, { open: (u) => opened.push(u) }));
  assert.equal(code, 0);
  assert.deepEqual(opened, [running.url]);
  // --no-open: says where it is, opens nothing
  assert.equal(await quiet(() => uiCommand({ port: String(running.port), 'no-open': true }, { open: (u) => opened.push(u) })), 0);
  assert.equal(opened.length, 1);
  await running.close();

  const other = http.createServer((_q, res) => res.end('hi'));
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  const port = (other.address() as any).port;
  assert.equal(await quiet(() => uiCommand({ port: String(port) }, { open: (u) => opened.push(u) })), 1);
  assert.equal(opened.length, 1);
  other.close();
});

test('uiCommand serves at the kept prefix across restarts and writes/removes its pid file', async () => {
  const prefix = loadOrCreatePrefix();
  for (let round = 0; round < 2; round++) {
    let stop!: () => void;
    const until = new Promise<void>((r) => { stop = r; });
    const opened: string[] = [];
    // a free port picked up front (port 0 means "any port, never a running page")
    const probe = http.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as any).port;
    await new Promise<void>((r) => probe.close(() => r()));
    const done = quiet(() => uiCommand({ port: String(port) }, { open: (u) => opened.push(u), until }));
    let url: string | null = null;
    for (let i = 0; i < 100 && !url; i++) { url = await findRunningUi(port, 300); if (!url) await new Promise((r) => setTimeout(r, 50)); }
    assert.equal(url, `http://127.0.0.1:${port}/${prefix}/`);
    assert.deepEqual(opened, [url]);
    assert.equal(fs.readFileSync(path.join(HOME, 'ui.pid'), 'utf8').trim(), String(process.pid));
    stop();
    assert.equal(await done, 0);
    assert.equal(fs.existsSync(path.join(HOME, 'ui.pid')), false);
  }
});

function fakeRun() {
  const calls: string[][] = [];
  const run = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (cmd.endsWith('launchctl')) return { code: 0, out: '' };
    return mac.realRun(cmd, args); // sips and iconutil for real
  };
  return { run, calls };
}

test('--install-mac writes kula.app (valid plist, executable launcher, icon); --login a LaunchAgent; --uninstall-mac removes both', { skip: process.platform !== 'darwin' && 'macOS only' }, async () => {
  const { run, calls } = fakeRun();
  const icon = path.resolve(import.meta.dirname, '..', '..', 'app', 'assets', 'icon.png');
  const start = ['/usr/local/bin/node', "/repo with 'quote'/node/dist/bin/kula-node.js"];
  const r = mac.installMac({ userHome: USER_HOME, kulaHome: HOME, start, port: 50590, icon, version: '0.1.0', login: true, uid: 501, run });
  const app = path.join(USER_HOME, 'Applications', 'kula.app');
  assert.equal(r.app, app);
  const info = path.join(app, 'Contents', 'Info.plist');
  if (has('/usr/bin/plutil')) {
    execFileSync('/usr/bin/plutil', ['-lint', info]);
    const j = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', info]).toString());
    assert.equal(j.CFBundleIdentifier, 'app.kula.ui');
    assert.equal(j.CFBundleExecutable, 'kula');
    assert.equal(j.LSUIElement, true);
  }
  const launcher = path.join(app, 'Contents', 'MacOS', 'kula');
  assert.equal(r.launcher, launcher);
  assert.ok(fs.statSync(launcher).mode & 0o100, 'the launcher is executable');
  assert.equal(spawnSync('/bin/bash', ['-n', launcher]).status, 0, 'the launcher parses');
  const sh = fs.readFileSync(launcher, 'utf8');
  assert.match(sh, /'\/repo with '\\''quote'\\''\/node\/dist\/bin\/kula-node\.js' 'ui' '--no-open' '--port' '50590'/);
  assert.ok(!/0\.0\.0\.0/.test(sh));
  if (has('/usr/bin/sips') && has('/usr/bin/iconutil')) {
    assert.ok(r.icon && fs.statSync(r.icon).size > 1000, 'kula.icns made');
  }
  // the LaunchAgent
  const agent = path.join(USER_HOME, 'Library', 'LaunchAgents', 'app.kula.ui.plist');
  assert.equal(r.agent, agent);
  assert.equal(r.loaded, true);
  if (has('/usr/bin/plutil')) {
    execFileSync('/usr/bin/plutil', ['-lint', agent]);
    const j = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', agent]).toString());
    assert.equal(j.Label, 'app.kula.ui');
    assert.deepEqual(j.ProgramArguments, [...start, 'ui', '--no-open', '--port', '50590']);
    assert.equal(j.RunAtLoad, true);
    assert.deepEqual(j.KeepAlive, { SuccessfulExit: false });
    assert.equal(j.Nice, 5);
    assert.equal(j.ProcessType, 'Background');
    assert.equal(j.StandardOutPath, path.join(HOME, 'ui.log'));
    assert.equal(j.EnvironmentVariables.KULA_NODE_HOME, HOME);
  }
  assert.ok(calls.some((c) => c[0] === '/bin/launchctl' && c[1] === 'bootstrap' && c[2] === 'gui/501' && c[3] === agent));
  assert.ok(!calls.some((c) => c[0].endsWith('lsregister')), 'a temp HOME leaves Launch Services alone');

  // reinstall without --login keeps working (and says the old agent is still there)
  const again = mac.installMac({ userHome: USER_HOME, kulaHome: HOME, start, port: 50590, icon: null, run });
  assert.equal(again.agent, null);
  assert.ok(again.notes.some((n) => n.includes('login item')));
  assert.ok(!fs.existsSync(`${app}.new`));

  const gone = mac.uninstallMac({ userHome: USER_HOME, kulaHome: HOME, uid: 501, run });
  assert.deepEqual(gone.sort(), [agent, app].sort());
  assert.ok(!fs.existsSync(app) && !fs.existsSync(agent));
  assert.ok(calls.some((c) => c[0] === '/bin/launchctl' && c[1] === 'bootout' && c[2] === 'gui/501/app.kula.ui'));
  assert.deepEqual(mac.uninstallMac({ userHome: USER_HOME, kulaHome: HOME, run }), []);
});

test('the installed launcher finds a running page and prints its address (KULA_UI_NO_BROWSER)', { skip: process.platform !== 'darwin' && 'macOS only' }, async () => {
  const { run } = fakeRun();
  const prefix = loadOrCreatePrefix();
  const ui = await startUi({ port: 0, engine: new Engine(), store: new ChatStore(path.join(HOME, 'chats-t')), token: 'kula-' + 'c'.repeat(40), prefix });
  // the start command would fail loudly if the launcher ever got that far
  const r = mac.installMac({ userHome: USER_HOME, kulaHome: HOME, start: ['/usr/bin/false'], port: ui.port, icon: null, run });
  const out = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = spawn(r.launcher, [], { env: { HOME: USER_HOME, KULA_UI_NO_BROWSER: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '';
    p.stdout.on('data', (d) => { o += d; });
    p.on('close', (code) => resolve({ code, out: o }));
  });
  await ui.close();
  assert.equal(out.code, 0);
  assert.equal(out.out.trim(), ui.url);
  mac.uninstallMac({ userHome: USER_HOME, kulaHome: HOME, run });
});

test('the cli knows the new flags as flags, not as taking a value', async () => {
  const { parse } = await import('../src/cli.ts');
  const p = parse(['ui', '--install-mac', '--login', '--new-prefix', '--stop', '--uninstall-mac', 'x']);
  assert.deepEqual(p.flags, { 'install-mac': true, login: true, 'new-prefix': true, stop: true, 'uninstall-mac': true });
  assert.deepEqual(p.rest, ['x']);
});
