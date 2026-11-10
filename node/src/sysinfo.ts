// What the worker tells the cluster about itself: lan address, free memory,
// memory bandwidth (a short copy benchmark on a worker thread) and the gpu.
import os from 'node:os';
import dgram from 'node:dgram';
import { execFile, execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// The address this computer sends from towards `host` (the route's own choice; with two
// interfaces it may not be lanIPv4()). A udp "connect" sends nothing. null when unknown.
export function sourceAddressTo(host: string): Promise<string | null> {
  return new Promise((resolve) => {
    let s: dgram.Socket;
    try { s = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4'); } catch { return resolve(null); }
    const done = (v: string | null) => { try { s.close(); } catch {} resolve(v); };
    s.on('error', () => done(null));
    try {
      s.connect(9, host, () => { try { done(s.address().address); } catch { done(null); } });
    } catch { done(null); }
  });
}

export function lanIPv4(): string | null {
  const all: { name: string; address: string }[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) all.push({ name, address: a.address });
    }
  }
  if (!all.length) return null;
  // prefer ordinary lan ranges over docker / vpn style interfaces
  const score = (x: { name: string; address: string }) => {
    let s = 0;
    if (/^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(x.address)) s += 2;
    if (/^(en|eth|wl|wlan|Wi-Fi|Ethernet)/i.test(x.name)) s += 1;
    if (/^(docker|br-|veth|utun|tun|tap|vbox|vmnet)/i.test(x.name)) s -= 3;
    return s;
  };
  all.sort((a, b) => score(b) - score(a));
  return all[0].address;
}

// Memory a model could take now. os.freemem() is the figure everywhere except
// macOS, where it counts only untouched pages (often under 100 MB on a busy
// machine): there, free + inactive + purgeable pages from vm_stat is what the
// system would hand out.
export function freeRamMB(): number {
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('vm_stat', { encoding: 'utf8', timeout: 3000 });
      const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 16384);
      const pages = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(out)?.[1] ?? 0);
      const avail = pages('Pages free') + pages('Pages inactive') + pages('Pages purgeable') + pages('Pages speculative');
      if (avail > 0) return Math.floor((avail * pageSize) / (1024 * 1024));
    } catch {}
  }
  return Math.floor(os.freemem() / (1024 * 1024));
}

export function totalRamMB(): number {
  return Math.floor(os.totalmem() / (1024 * 1024));
}

// Copies 64 MB back and forth 4 times on a worker thread and reports GB/s of
// bytes moved (read + write counted once each).
export function measureBandwidth(sizeMB = 64, passes = 4): Promise<number> {
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    const n = workerData.sizeMB * 1024 * 1024;
    const a = new Uint8Array(n); const b = new Uint8Array(n);
    a.fill(1); b.fill(2); // touch the pages first
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < workerData.passes; i++) { b.set(a); a.set(b); }
    const ns = Number(process.hrtime.bigint() - t0);
    const bytes = n * 2 * 2 * workerData.passes;
    parentPort.postMessage(bytes / ns); // bytes per ns == GB/s
  `;
  return new Promise((resolve) => {
    const w = new Worker(code, { eval: true, workerData: { sizeMB, passes } });
    const t = setTimeout(() => { w.terminate(); resolve(0); }, 20000);
    w.once('message', (gbps: number) => { clearTimeout(t); resolve(Math.round(gbps * 100) / 100); w.terminate(); });
    w.once('error', () => { clearTimeout(t); resolve(0); });
  });
}

export interface Gpu { name: string | null; vramMB: number }

export async function detectGpu(): Promise<Gpu> {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execFileP('system_profiler', ['SPDisplaysDataType', '-json'], { timeout: 8000 });
      const list = (JSON.parse(stdout).SPDisplaysDataType ?? []) as Record<string, string>[];
      const g = list[0];
      if (!g) return { name: null, vramMB: 0 };
      const vram = g.spdisplays_vram ?? g.spdisplays_vram_shared ?? '';
      const m = /(\d+)\s*(GB|MB)/i.exec(vram);
      const vramMB = m ? Number(m[1]) * (m[2].toUpperCase() === 'GB' ? 1024 : 1) : 0;
      return { name: g.sppci_model ?? g._name ?? null, vramMB };
    }
    const { stdout } = await execFileP('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { timeout: 8000 });
    const line = stdout.trim().split('\n')[0];
    if (!line) return { name: null, vramMB: 0 };
    const [name, mem] = line.split(',').map((s) => s.trim());
    return { name, vramMB: Number(mem) || 0 };
  } catch {
    return { name: null, vramMB: 0 };
  }
}
