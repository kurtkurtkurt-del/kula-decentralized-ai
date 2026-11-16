// A kula-node that gets SIGTERM, SIGINT or SIGHUP takes the children it started along (16 Nov: a
// sharing kula-node got SIGTERM and its ggml-rpc-servers stayed, re-parented to pid 1, an rpc server on
// 127.0.0.1 with no gate in front of it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const childrenUrl = pathToFileURL(path.resolve(here, '../src/children.ts')).href;

// a stand-in for kula-node: starts a harmless long-running program through startChild (it listens on
// the port startChild waits for), prints its pid; `handles` adds a listener of its own, as share does
function standIn(handles?: NodeJS.Signals): ChildProcess {
  const script = `
    const { startChild, freePort } = await import(${JSON.stringify(childrenUrl)});
    const port = await freePort();
    const prog = "require('net').createServer().listen(" + port + ", '127.0.0.1'); setInterval(() => {}, 1e6)";
    const c = await startChild('stand-in', process.execPath, ['-e', prog], port, () => {}, 20000);
    ${handles ? `process.once(${JSON.stringify(handles)}, () => { console.log('handled'); setTimeout(() => process.exit(0), 300); });` : ''}
    console.log('pid ' + c.proc.pid);
    setInterval(() => {}, 1e6);
  `;
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    stdio: ['ignore', 'pipe', 'inherit'],
    cwd: path.resolve(here, '..'),
  });
}

function grandchildPid(p: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error(`no pid within 20 s: ${out}`)), 20000);
    p.stdout!.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /pid (\d+)/.exec(out);
      if (m) { clearTimeout(t); resolve(Number(m[1])); }
    });
    p.once('exit', (code, sig) => { clearTimeout(t); reject(new Error(`stand-in ended (${code ?? sig}) before printing a pid: ${out}`)); });
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

function ended(p: ChildProcess): Promise<{ code: number | null; sig: NodeJS.Signals | null }> {
  if (p.exitCode !== null || p.signalCode !== null) return Promise.resolve({ code: p.exitCode, sig: p.signalCode });
  return new Promise((resolve) => p.once('exit', (code, sig) => resolve({ code, sig })));
}

const signals: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGTERM', 'SIGINT'] : ['SIGTERM', 'SIGINT', 'SIGHUP'];

for (const sig of signals) {
  test(`${sig} to kula-node: its child is gone within 3 s and kula-node still ends by ${sig}`, async () => {
    const p = standIn();
    let pid = 0;
    try {
      pid = await grandchildPid(p);
      assert.equal(alive(pid), true);
      p.kill(sig);
      assert.equal(await goneWithin(pid, 3000), true, `child ${pid} still runs after ${sig}`);
      const end = await ended(p);
      if (process.platform !== 'win32') assert.deepEqual(end, { code: null, sig }, 'ended by the signal, as without the guard');
    } finally {
      try { p.kill('SIGKILL'); } catch {}
      if (pid && alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  });
}

// Windows ends a process on SIGTERM from outside without running its listeners
test('SIGTERM when kula already handles it (share): the child is killed, the handler still decides the end', { skip: process.platform === 'win32' }, async () => {
  const p = standIn('SIGTERM');
  let pid = 0;
  let out = '';
  p.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
  try {
    pid = await grandchildPid(p);
    p.kill('SIGTERM');
    assert.equal(await goneWithin(pid, 3000), true, `child ${pid} still runs after SIGTERM`);
    const end = await ended(p);
    assert.match(out, /handled/);
    assert.deepEqual(end, { code: 0, sig: null }, 'the handler exits on its own, the guard does not re-raise');
  } finally {
    try { p.kill('SIGKILL'); } catch {}
    if (pid && alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch {}
  }
});
