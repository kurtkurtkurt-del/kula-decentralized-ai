// A download that can be resumed: bytes go to `<dest>.part`, a Range request
// continues where a previous run stopped, and the file is renamed when whole.
import fs from 'node:fs';
import { createHash } from 'node:crypto';

export type Progress = (got: number, total: number) => void;

export async function download(url: string, dest: string, onProgress?: Progress, signal?: AbortSignal): Promise<void> {
  const part = `${dest}.part`;
  let have = 0;
  try { have = fs.statSync(part).size; } catch {}
  const headers: Record<string, string> = { 'user-agent': 'kula-node' };
  if (have > 0) headers.range = `bytes=${have}-`;
  const res = await fetch(url, { headers, redirect: 'follow', signal });
  if (res.status === 416) {
    // nothing left to fetch: the part is already the whole file
    fs.renameSync(part, dest);
    return;
  }
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const resumed = res.status === 206;
  if (!resumed && have > 0) { fs.rmSync(part); have = 0; }
  const len = Number(res.headers.get('content-length') ?? 0);
  const total = resumed ? have + len : len;
  const out = fs.createWriteStream(part, { flags: resumed ? 'a' : 'w' });
  let got = have;
  let last = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      got += value.length;
      const now = Date.now();
      if (onProgress && (now - last > 200 || got === total)) { last = now; onProgress(got, total); }
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()));
  }
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
