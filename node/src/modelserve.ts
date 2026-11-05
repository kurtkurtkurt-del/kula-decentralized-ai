// Apart mode hands every worker a url to fetch the model from. When the
// model is a local file this small http server offers it to the lan, under a
// random path so a scan of the port learns nothing. Only this one file is
// served; Range is honoured because the worker's download resumes.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export interface ModelServer {
  port: number;
  url: string; // what the worker is told: http://<host>:<port>/m/<token>/<name>
  close(): Promise<void>;
}

export async function serveModel(file: string, host: string, bind = '0.0.0.0', port = 0): Promise<ModelServer> {
  const st = fs.statSync(file);
  const name = path.basename(file);
  const token = randomBytes(12).toString('hex');
  const route = `/m/${token}/${encodeURIComponent(name)}`;
  const server = http.createServer((req, res) => {
    const url = (req.url ?? '').split('?')[0];
    if ((req.method !== 'GET' && req.method !== 'HEAD') || url !== route) { res.writeHead(404); res.end(); return; }
    const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    let from = 0;
    let to = st.size - 1;
    if (m) {
      from = Number(m[1]);
      if (m[2]) to = Math.min(Number(m[2]), to);
      if (from > to || from >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); res.end(); return; }
      res.writeHead(206, { 'content-length': to - from + 1, 'content-range': `bytes ${from}-${to}/${st.size}`, 'accept-ranges': 'bytes', 'content-type': 'application/octet-stream' });
    } else {
      res.writeHead(200, { 'content-length': st.size, 'accept-ranges': 'bytes', 'content-type': 'application/octet-stream' });
    }
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(file, { start: from, end: to });
    stream.pipe(res);
    req.on('close', () => stream.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bind, () => { server.off('error', reject); resolve(); });
  });
  const p = (server.address() as { port: number }).port;
  return {
    port: p,
    url: `http://${host}:${p}${route}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
