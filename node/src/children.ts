// Running ggml-rpc-server and llama-server as children, on free local ports.
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';

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
    if (child.exitCode !== null) throw new Error(`exited with ${child.exitCode} before listening`);
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
  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
  proc.on('exit', (code, sig) => log(`${name} exited (${code ?? sig})`));
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
      if (proc.exitCode !== null) return resolve();
      const t = setTimeout(() => { proc.kill('SIGKILL'); }, 3000);
      proc.once('exit', () => { clearTimeout(t); resolve(); });
      proc.kill('SIGTERM');
    }),
  };
}
