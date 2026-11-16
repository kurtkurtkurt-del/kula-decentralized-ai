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

// kula-node going away takes its children along: an rpc server left behind holds model layers in
// memory and listens on 127.0.0.1 with no gate in front of it (found 16 Nov: a SIGTERM to a sharing
// kula-node left its ggml-rpc-servers re-parented to pid 1). 'exit' alone is not enough: a default
// SIGTERM, SIGINT or SIGHUP ends the process without firing it. So while a child is guarded the guard
// listens to those signals too, kills every guarded child, and then, when nothing else in kula
// handles that signal (the share and ui commands do: they stop in order), raises it again so the
// process ends as it would have without the guard.
const guarded = new Set<ChildProcess>();
const guardSignals: NodeJS.Signals[] = process.platform === 'win32' ? ['SIGTERM', 'SIGINT'] : ['SIGTERM', 'SIGINT', 'SIGHUP'];
const killGuarded = () => {
  for (const p of guarded) { try { if (!exited(p)) p.kill('SIGKILL'); } catch {} }
  guarded.clear();
};
const onSignal = (sig: NodeJS.Signals) => {
  killGuarded();
  // asked when the signal comes, not when the child started: share and ui add their listener later
  const others = process.listeners(sig).filter((l) => l !== signalHandlers[sig]).length;
  if (others > 0) return;
  unhook();
  process.kill(process.pid, sig);
};
const signalHandlers: Partial<Record<NodeJS.Signals, () => void>> = {};
for (const sig of guardSignals) signalHandlers[sig] = () => onSignal(sig);
let hooked = false;
function hook(): void {
  if (hooked) return;
  hooked = true;
  process.once('exit', killGuarded);
  // first in line, so a `once` listener elsewhere is still counted when this one runs
  for (const sig of guardSignals) process.prependListener(sig, signalHandlers[sig]!);
}
function unhook(): void {
  if (!hooked) return;
  hooked = false;
  process.off('exit', killGuarded);
  for (const sig of guardSignals) process.off(sig, signalHandlers[sig]!);
}

/** kill this child when kula-node exits or gets SIGTERM, SIGINT or SIGHUP (no SIGHUP on Windows) */
export function guardChild(proc: ChildProcess): void {
  if (exited(proc)) return;
  guarded.add(proc);
  hook();
  proc.once('exit', () => {
    guarded.delete(proc);
    // nothing left to guard: the process's signals behave as they did before
    if (guarded.size === 0) unhook();
  });
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
  // kula-node going away (an exception, a signal, a parent that relays no signal) takes its children along
  guardChild(proc);
  proc.on('exit', (code, sig) => { log(`${name} exited (${code ?? sig})`); });
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
