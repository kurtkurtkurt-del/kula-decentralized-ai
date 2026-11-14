// Running ggml-rpc-server and llama-server as children, on free local ports.
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

// A child has ended when it exited with a code OR was killed by a signal (then exitCode stays null
// and signalCode says which: llama-server aborting on a worker that went away is SIGABRT).
export function exited(p: { exitCode: number | null; signalCode: NodeJS.Signals | null }): boolean {
  return p.exitCode !== null || p.signalCode !== null;
}

// On linux the llama.cpp programs' libraries (and the CUDA runtime placed beside
// them) are searched in the program's own folder too: a library's own search path
// does not cover its dependencies' dependencies (libcublas -> libcublasLt).
export function childEnv(bin: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (platform !== 'linux') return env;
  return { ...env, LD_LIBRARY_PATH: [path.dirname(bin), env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export function portOpen(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, timeoutMs);
    s.once('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.once('error', () => { clearTimeout(t); resolve(false); });
  });
}

export async function waitForPort(child: ChildProcess, port: number, timeoutMs: number): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (exited(child)) throw new Error(`exited with ${child.exitCode ?? child.signalCode} before listening`);
    if (await portOpen(port)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`did not listen on ${port} within ${timeoutMs} ms`);
}

export interface Child {
  proc: ChildProcess;
  port: number;
  stop(): Promise<void>;
}

export async function startChild(name: string, bin: string, args: string[], port: number, log: (s: string) => void, readyMs = 60000): Promise<Child> {
  log(`${name}: ${bin} ${args.join(' ')}`);
  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(bin), windowsHide: true });
  const tail: string[] = [];
  const onLine = (d: Buffer) => {
    for (const line of d.toString().split('\n')) {
      if (!line.trim()) continue;
      tail.push(line); if (tail.length > 20) tail.shift();
      if (process.env.KULA_NODE_VERBOSE) log(`  ${name}| ${line}`);
    }
  };
  proc.stdout?.on('data', onLine);
  proc.stderr?.on('data', onLine);
  // kula-node going away (an exception, a parent that relays no signal) takes its children along
  const orphanGuard = () => { try { proc.kill('SIGKILL'); } catch {} };
  process.once('exit', orphanGuard);
  proc.on('exit', (code, sig) => { process.off('exit', orphanGuard); log(`${name} exited (${code ?? sig})`); });
  try {
    await waitForPort(proc, port, readyMs);
  } catch (e) {
    proc.kill();
    throw new Error(`${name}: ${(e as Error).message}\n${tail.join('\n')}`);
  }
  log(`${name} listening on 127.0.0.1:${port}`);
  return {
    proc,
    port,
    stop: () => new Promise<void>((resolve) => {
      if (exited(proc)) return resolve();
      const t = setTimeout(() => { proc.kill('SIGKILL'); }, 3000);
      proc.once('exit', () => { clearTimeout(t); resolve(); });
      proc.kill('SIGTERM');
    }),
  };
}
