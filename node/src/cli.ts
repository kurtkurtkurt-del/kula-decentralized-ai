// The command line: setup, share, probe.
import { probe, type Channel } from './gate.js';
import { setup, TAG } from './llama.js';
import { share } from './share.js';
import { home } from './paths.js';

const HELP = `kula-node: make this computer a worker in a kula cluster

usage:
  kula-node setup [--check]          get llama.cpp ${TAG} (build on macOS, download on linux/windows)
  kula-node share [options]          open the gate and wait for the phone
      --port <n>        gate port (default 50551)
      --name <s>        name shown to the phone (default: this computer's hostname)
      --models <dir>    where models are kept (default ~/.kula-node/models)
      --secret <hex>    cluster secret (default: a fresh one each run)
      --lie-ram <MB>    advertise a false amount of free ram (for audit tests)
      --no-qr           print the json payload only
  kula-node probe <host> <port> <secret>   handshake on both channels, print OK/NO

files live in ${home()} (KULA_NODE_HOME overrides)
`;

function parse(argv: string[]): { cmd: string; flags: Record<string, string | boolean>; rest: string[] } {
  const [cmd = 'help', ...tail] = argv;
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (i + 1 < tail.length && !tail[i + 1].startsWith('--')) flags[k] = tail[++i];
      else flags[k] = true;
    } else rest.push(a);
  }
  return { cmd, flags, rest };
}

function num(v: string | boolean | undefined, dflt: number): number {
  if (v === undefined || v === true) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${v}`);
  return n;
}

export async function main(argv: string[]): Promise<number> {
  const { cmd, flags, rest } = parse(argv);
  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || flags.help) { console.log(HELP); return 0; }
  if (cmd === '--version' || cmd === 'version') { console.log(`kula-node 0.1.0 (llama.cpp ${TAG})`); return 0; }

  if (cmd === 'setup') {
    const got = await setup({ check: flags.check === true });
    return got ? 0 : 1;
  }

  if (cmd === 'probe') {
    const [host, portS, secret] = rest;
    if (!host || !portS || !secret) { console.error('usage: kula-node probe <host> <port> <secret>'); return 2; }
    const port = Number(portS);
    let bad = 0;
    for (const channel of ['rpc', 'api'] as Channel[]) {
      const r = await probe(host, port, secret, channel, num(flags.timeout, 2000));
      if (r.ok) console.log(`${channel}: OK (${r.ms} ms)`);
      else { console.log(`${channel}: NO ${r.reason}`); bad++; }
    }
    return bad ? 1 : 0;
  }

  if (cmd === 'share') {
    const secret = typeof flags.secret === 'string' ? flags.secret : undefined;
    if (secret !== undefined && !/^[0-9a-f]{16,128}$/i.test(secret)) { console.error('--secret must be hex'); return 2; }
    const stop = await share({
      port: num(flags.port, 50551),
      name: typeof flags.name === 'string' ? flags.name : undefined,
      models: typeof flags.models === 'string' ? flags.models : '~/.kula-node/models',
      secret: secret?.toLowerCase(),
      lieRam: flags['lie-ram'] !== undefined ? num(flags['lie-ram'], 0) : undefined,
      noQr: flags['no-qr'] === true,
    });
    await new Promise<void>((resolve) => {
      const done = () => { stop().finally(resolve); };
      process.once('SIGINT', done);
      process.once('SIGTERM', done);
    });
    return 0;
  }

  console.error(`unknown command: ${cmd}\n`);
  console.log(HELP);
  return 2;
}
