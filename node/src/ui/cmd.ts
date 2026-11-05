// `kula-node ui [--port 50590] [--no-open] [--new-token] [--lan]`: the chat page on 127.0.0.1
// (and, with --lan or the page's switch, an invite for devices on this wi-fi).
import { spawn } from 'node:child_process';
import qrcode from 'qrcode-terminal';
import { Engine } from './engine.js';
import { startUi, loadOrCreateToken, UI_PORT } from './server.js';

type Flags = Record<string, string | boolean>;
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (s: string) => console.error(`${stamp()}  ${s}`);

export function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try {
    const p = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' });
    p.on('error', () => log(`could not open a browser; open ${url} yourself`));
    p.unref();
  } catch { log(`could not open a browser; open ${url} yourself`); }
}

// the invite on the terminal: a qr to scan with any phone's camera, and the address under it
function printInvite(url: string | null): void {
  if (!url) return;
  console.log('\ninvite a device on this wi-fi: scan this with its camera');
  qrcode.generate(url, { small: true }, (q) => console.log(q));
  console.log(`${url}\n(plain http on this network; "new invite" on the page ends it)\n`);
}

export async function uiCommand(flags: Flags): Promise<number> {
  const port = flags.port !== undefined && flags.port !== true ? Number(flags.port) : UI_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error('--port must be a port number'); return 2; }
  const engine = new Engine({ peersFile: typeof flags.file === 'string' ? flags.file : undefined, log });
  const token = loadOrCreateToken(flags['new-token'] === true);
  let ui;
  try {
    ui = await startUi({ port, engine, token, log, onInvite: printInvite });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') { console.error(`port ${port} is taken (another kula-node ui?): stop it, or pass --port <n>`); return 1; }
    throw e;
  }
  console.log(`the chat page: ${ui.url}  (this computer only)`);
  console.log(`openai endpoint: ${ui.openaiBase}  token: ${ui.token}`);
  console.log('on the phone: kula → share this phone; then "connect" on the page. ctrl-c stops.');
  if (flags.lan === true) {
    const info = await ui.invite.set(true);
    if (info.error) console.error(`invite mode did not start: ${info.error}`);
  }
  if (flags['no-open'] !== true) openBrowser(ui.url);
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
  log('stopping');
  await ui.close();
  await engine.close();
  return 0;
}
