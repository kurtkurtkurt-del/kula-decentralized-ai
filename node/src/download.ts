// A download that can be resumed: bytes go to `<dest>.part`, a Range request
// continues where a previous run stopped, and the file is renamed when whole.
// Plain http/https streams rather than fetch: node's fetch body can trip an
// internal assertion when a slow disk pauses it and the server hangs up.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';

export type Progress = (got: number, total: number) => void;

function request(url: string, headers: Record<string, string>, signal?: AbortSignal, hops = 0): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get(u, { headers, signal }, (res) => {
      const code = res.statusCode ?? 0;
      if (code >= 300 && code < 400 && res.headers.location && hops < 10) {
        res.resume();
        resolve(request(new URL(res.headers.location, u).toString(), headers, signal, hops + 1));
        return;
      }
      resolve(res);
    });
    req.on('error', reject);
  });
}

export async function download(url: string, dest: string, onProgress?: Progress, signal?: AbortSignal): Promise<void> {
  const part = `${dest}.part`;
  let have = 0;
  try { have = fs.statSync(part).size; } catch {}
  const headers: Record<string, string> = { 'user-agent': 'kula-node' };
  if (have > 0) headers.range = `bytes=${have}-`;
  const res = await request(url, headers, signal);
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
  let got = have;
  let last = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      got += chunk.length;
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
