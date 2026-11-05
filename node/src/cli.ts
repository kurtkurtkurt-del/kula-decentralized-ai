// The command line: setup, share, probe.
import { probe, type Channel, type TlsClient } from './gate.js';
import { loadOrCreateIdentity } from './tls.js';
import { loadOrCreate as loadDeviceKey } from './audit/key.js';
import { setup, TAG } from './llama.js';
import { share } from './share.js';
import { home } from './paths.js';
import { ledgerCommand } from './ledgercmd.js';
import { peersCommand, chatCommand } from './mastercmd.js';

const HELP = `kula-node: make this computer a worker in a kula cluster

usage:
  kula-node setup [--check] [--dry-run]   get llama.cpp ${TAG} (build on macOS, download on linux/windows)
      --dry-run         only say which archive would be fetched
  kula-node share [options]          open the gate and wait for the phone
      --port <n>        gate port (default 50551)
      --name <s>        name shown to the phone (default: this computer's hostname)
      --models <dir>    where models are kept (default ~/.kula-node/models)
      --secret <hex>    cluster secret (default: a fresh one each run)
      --lie-ram <MB>    advertise a false amount of free ram (for audit tests)
      --no-qr           print the json payload only
      --tls             protocol v2: tls between device certificates, qr v3 with a one-time code;
                        v1 is then off unless --secret is given (old phones)
      --relay <wss://…> also register with that relay so a device far away (behind nat) can come in
                        with a six digit code; the qr carries it. implies --tls (docs/RELAY.md)
      --dashboard <n>   local dashboard port on 127.0.0.1 (default 50580); --no-dashboard turns it off
  kula-node probe <host> <port> <secret>   handshake on both channels, print OK/NO
      --fp <hex> [--pin <code>]   probe over tls (v2) against that certificate fingerprint; secret may be "-"
  kula-node ledger [--verify] [--tail N]   print the signed ledger; --verify checks the chain and signatures

running a cluster from this computer:
  kula-node peers add <qr json | code | host:port:secret>   remember a worker (~/.kula-node/peers.json, mode 600)
  kula-node peers add <6 digits> [pin] --relay <wss://…>    a worker far away, by its relay code (and pairing code); $KULA_RELAY is the default relay
  kula-node peers list [--code]      the peer book; --code prints each peer as a pasteable code
  kula-node peers rm <id | name>     forget a worker
  kula-node peers probe [id…]        tcp + handshake on both channels, 2 s each (--timeout <ms>)
  kula-node peers scan               listen for _kula._tcp on the lan for 3 s (--timeout <ms>)
  kula-node chat --model <file.gguf> --mode apart|split [options]
      --peer <id>[,id…]  which workers (default: every saved one); may be repeated
      --batch [file]     send 8 prompts (or one per line of file) and print tok/s per device
      --prompt <s>       one prompt, then exit (default: an interactive chat)
      --ctx <n>          context size (default 4096)      --max-tokens <n>  (default 256)
      --no-local         apart: do not run the model here, use the workers only
      --model-url <url>  apart: let workers fetch the model from there instead of from this computer
      --keep-local       split: when the model fits here, do not share it anyway
      --probe-ms <n>     how long a worker has to answer before it is dropped (default 2000)
      a peer far away (relay) is used in apart mode only; split mode leaves it out and says so
      --dashboard <n>    local dashboard port on 127.0.0.1 (default 50580); --no-dashboard turns it off

the dashboard: while share or chat runs, http://127.0.0.1:50580/<random>/ (the exact
url is printed) shows this computer, the gate, the peers, the ledger, a chat box
and the pairing qr. it answers on 127.0.0.1 only.

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
      let val: string | boolean = true;
      if (v !== undefined) val = v;
      else if (i + 1 < tail.length && !tail[i + 1].startsWith('--')) val = tail[++i];
      // a flag given twice (--peer a --peer b) keeps both, comma joined
      flags[k] = typeof flags[k] === 'string' && typeof val === 'string' ? `${flags[k]},${val}` : val;
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
    const dryRun = flags['dry-run'] === true;
    const got = await setup({ check: flags.check === true, dryRun });
    return got || dryRun ? 0 : 1;
  }

  if (cmd === 'peers') return peersCommand(rest[0], rest.slice(1), flags);
  if (cmd === 'chat') return chatCommand(flags);

  if (cmd === 'ledger') {
    return ledgerCommand({ verify: flags.verify === true, tail: flags.tail !== undefined ? num(flags.tail, 20) : undefined });
  }

  if (cmd === 'probe') {
    const [host, portS, secret] = rest;
    if (!host || !portS || !secret) { console.error('usage: kula-node probe <host> <port> <secret>'); return 2; }
    const port = Number(portS);
    let tlsOpts: TlsClient | null = null;
    if (typeof flags.fp === 'string') {
      if (!/^[0-9a-f]{64}$/i.test(flags.fp)) { console.error('--fp must be 64 hex characters'); return 2; }
      tlsOpts = { identity: loadOrCreateIdentity(home(), loadDeviceKey()), fp: flags.fp.toLowerCase(), pin: typeof flags.pin === 'string' ? flags.pin : null };
    }
    let bad = 0;
    for (const channel of ['rpc', 'api'] as Channel[]) {
      const r = await probe(host, port, secret, channel, num(flags.timeout, 2000), tlsOpts);
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
      tls: flags.tls === true || typeof flags.relay === 'string',
      relay: typeof flags.relay === 'string' ? flags.relay : undefined,
      dashboard: flags['no-dashboard'] === true ? false : flags.dashboard !== undefined ? num(flags.dashboard, 50580) : undefined,
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
