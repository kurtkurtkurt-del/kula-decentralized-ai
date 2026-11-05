// A download that can be resumed: bytes go to `<dest>.part`, a Range request
// continues where a previous run stopped, and the file is renamed when whole.
// Plain http/https streams rather than fetch: node's fetch body can trip an
// internal assertion when a slow disk pauses it and the server hangs up.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import dns from 'node:dns';
import { isPrivateAddress, urlProblem, overSize, MAX_REDIRECTS, KEEP_FREE_BYTES } from './policy.js';

export type Progress = (got: number, total: number) => void;

// Resolves like dns.lookup, then refuses an address a model cannot live at (a name for
// 127.0.0.1 or 192.168.x.x is the usual way around a check on the url text alone).
function publicLookup(host: string, options: any, cb: any) {
  const done = typeof options === 'function' ? options : cb;
  const opts = typeof options === 'function' ? {} : options;
  dns.lookup(host, opts, (err: any, address: any, family?: any) => {
    if (err) return done(err);
    const addrs = Array.isArray(address) ? address.map((a: any) => a.address) : [address];
    if (addrs.some((a: string) => isPrivateAddress(a))) return done(new Error(`${host} resolves to a private address`));
    done(null, address, family);
  });
}

// Every hop, the first and each redirect, goes through the url policy; at most MAX_REDIRECTS.
function request(url: string, headers: Record<string, string>, signal: AbortSignal | undefined, allowPrivate: boolean, hops = 0): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const why = urlProblem(url, allowPrivate);
    if (why) return reject(new Error(why));
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, { headers, signal, lookup: allowPrivate ? undefined : (publicLookup as any) }, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        if (hops >= MAX_REDIRECTS) return reject(new Error('too many redirects'));
        let next: string;
        try { next = new URL(res.headers.location, u).toString(); } catch { return reject(new Error('bad redirect')); }
        resolve(request(next, headers, signal, allowPrivate, hops + 1));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
  });
}

function freeBytes(dir: string): number | null {
  try { const s = fs.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}

// `size` is what the master said the file is: the body may not run past it (a server that
// streams for ever would otherwise fill the disk), and the disk must keep KEEP_FREE_BYTES.
export interface DownloadLimits { size?: number; allowPrivate?: boolean }

export async function download(url: string, dest: string, onProgress?: Progress, signal?: AbortSignal, limits: DownloadLimits = {}): Promise<void> {
  const size = limits.size ?? 0;
  const allowPrivate = limits.allowPrivate ?? false;
  const part = `${dest}.part`;
  let have = 0;
  try { have = fs.statSync(part).size; } catch {}
  const headers: Record<string, string> = { 'user-agent': 'kula-node' };
  if (have > 0) headers.range = `bytes=${have}-`;
  const res = await request(url, headers, signal, allowPrivate);
  const code = res.statusCode ?? 0;
  if (code === 416) {
    // nothing left to fetch: the part is already the whole file
    res.resume();
    fs.renameSync(part, dest);
    return;
  }
  if (code < 200 || code >= 300) {
    res.resume();
    throw new Error(`download failed: ${code} ${res.statusMessage ?? ''}`.trim());
  }
  const resumed = code === 206;
  if (!resumed && have > 0) { fs.rmSync(part); have = 0; }
  const len = Number(res.headers['content-length'] ?? 0);
  const total = resumed ? have + len : len;
  if (size > 0 && total > 0 && overSize(total, size)) { res.destroy(); throw new Error(`size mismatch: server says ${total} bytes, expected ${size}`); }
  const need = (total > 0 ? total : size) - have;
  const free = freeBytes(path.dirname(part));
  if (free !== null && need > 0 && free - need < KEEP_FREE_BYTES) { res.destroy(); throw new Error('not enough free disk space'); }
  let got = have;
  let last = 0;
  let sinceCheck = 0;
  const dir = path.dirname(part);
  const count = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      got += chunk.length;
      if (overSize(got, size) || (total > 0 && got > total)) return cb(new Error(`download ran past ${size || total} bytes`));
      // a body of unknown length (chunked, no size from the master) is held by the disk itself
      sinceCheck += chunk.length;
      if (sinceCheck > 32 * 1024 * 1024) {
        sinceCheck = 0;
        const f = freeBytes(dir);
        if (f !== null && f < KEEP_FREE_BYTES) return cb(new Error('not enough free disk space'));
      }
      const now = Date.now();
      if (onProgress && now - last > 200) { last = now; onProgress(got, total); }
      cb(null, chunk);
    },
  });
  await pipeline(res, count, fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' }), { signal });
  if (total && got !== total) throw new Error(`download stopped early: ${got} of ${total} bytes`);
  onProgress?.(got, total);
  fs.renameSync(part, dest);
}

export function sha256Of(file: string, onProgress?: Progress): Promise<string> {
  return new Promise((resolve, reject) => {
    const total = fs.statSync(file).size;
    let got = 0;
    const h = createHash('sha256');
    fs.createReadStream(file)
      .on('data', (d: string | Buffer) => { h.update(d); got += d.length; onProgress?.(got, total); })
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}
