// The command line: setup, share, probe, peers, chat, ledger; a short menu when run bare.
import readline from 'node:readline';
import { probe, type Channel, type TlsClient } from './gate.js';
import { loadOrCreateIdentity } from './tls.js';
import { loadOrCreate as loadDeviceKey } from './audit/key.js';
import { setup, planSetup, findLlama, candidates, TAG, WINDOWS_FIREWALL_NOTE } from './llama.js';
import { share } from './share.js';
import { home, packageRoot } from './paths.js';
import { version, isPacked } from './build.js';
import { ledgerCommand } from './ledgercmd.js';
import { collectInfo, infoText } from './info.js';
import { peersCommand, chatCommand } from './mastercmd.js';

const HELP = `kula-node: make this computer a worker in a kula cluster

usage:
  kula-node                          a short menu (setup, share, peers, help)
  kula-node setup [--check] [--dry-run] [--json]   get llama.cpp ${TAG} (build on macOS, download on linux/windows)
      --check           only say whether it is here
      --dry-run         only say what would be fetched, how big, and its sha256
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
  kula-node probe <host> <port> <secret> [--json]   handshake on both channels, print OK/NO
      --fp <hex> [--pin <code>]   probe over tls (v2) against that certificate fingerprint; secret may be "-"
  kula-node ledger [--verify] [--tail N]   print the signed ledger; --verify checks the chain and signatures
  kula-node --version [--json]
  kula-node info [--json] [--no-bandwidth]   address, ram, memory bandwidth, gpu, llama.cpp: what a cluster would see

running a cluster from this computer:
  kula-node peers add <qr json | code | host:port:secret>   remember a worker (~/.kula-node/peers.json, mode 600)
  kula-node peers add <6 digits> [pin] --relay <wss://…>    a worker far away, by its relay code (and pairing code); $KULA_RELAY is the default relay
  kula-node peers list [--code] [--json]   the peer book; --code prints each peer as a pasteable code
  kula-node peers rm <id | name>     forget a worker
  kula-node peers probe [id…] [--json]   tcp + handshake on both channels, 2 s each (--timeout <ms>)
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

// flags that never take a value, so `--json host` does not swallow the host
const BOOLEAN = new Set(['json', 'help', 'check', 'dry-run', 'no-qr', 'no-dashboard', 'verify', 'no-local', 'keep-local', 'code']);

export function parse(argv: string[]): { cmd: string; flags: Record<string, string | boolean>; rest: string[] } {
  const [cmd = 'help', ...tail] = argv;
  const flags: Record<string, string | boolean> = {};
  const rest: string[] = [];
  for (let i = 0; i < tail.length; i++) {
    const a = tail[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      let val: string | boolean = true;
      if (v !== undefined) val = v;
      else if (!BOOLEAN.has(k) && i + 1 < tail.length && !tail[i + 1].startsWith('--')) val = tail[++i];
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

export function versionInfo() {
  return { name: 'kula-node', version: version(packageRoot()), llama: TAG, node: process.versions.node, platform: process.platform, arch: process.arch, packed: isPacked() };
}

export interface MenuItem { key: string; argv: string[]; label: string; note: string }

// The bare `kula-node` menu. setup is the default until llama.cpp is here, then share.
export function menuItems(llamaWhere: string | null): MenuItem[] {
  return [
    { key: '1', argv: ['setup'], label: 'setup', note: llamaWhere ? `llama.cpp ${TAG} is here (${llamaWhere})` : `get llama.cpp ${TAG}, needed once; start here` },
    { key: '2', argv: ['share'], label: 'share', note: 'open the gate and pair a phone (shows a qr code)' },
    { key: '3', argv: ['peers', 'list'], label: 'peers', note: 'the workers this computer knows' },
    { key: '4', argv: ['help'], label: 'help', note: 'every command and flag' },
  ];
}

export function menuText(items: MenuItem[], dflt: string): string {
  const lines = [`kula-node ${version(packageRoot())}: make this computer a worker in a kula cluster`, ''];
  for (const it of items) lines.push(`  ${it.key}) ${it.label.padEnd(6)} ${it.note}${it.key === dflt ? '   <- enter' : ''}`);
  lines.push('  q) quit');
  return lines.join('\n');
}

// What an answer at the menu prompt means: an argv, 'quit', or null (ask again).
export function pickMenu(answer: string, items: MenuItem[], dflt: string): string[] | 'quit' | null {
  const a = answer.trim().toLowerCase();
  if (a === 'q' || a === 'quit' || a === 'exit') return 'quit';
  const key = a === '' ? dflt : a;
  const it = items.find((x) => x.key === key || x.label === key);
  return it ? it.argv : null;
}

async function menu(): Promise<number> {
  const found = findLlama();
  const items = menuItems(found?.where ?? null);
  const dflt = found ? '2' : '1';
  console.log(menuText(items, dflt));
  if (!process.stdin.isTTY) {
    console.log('\nrun one of: kula-node setup | kula-node share | kula-node peers list | kula-node help');
    return 0;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let pick: string[] | 'quit' | null = null;
  try {
    while (pick === null) {
      const answer = await new Promise<string>((resolve) => rl.question(`choose [1-${items.length}, q]: `, resolve));
      pick = pickMenu(answer, items, dflt);
      if (pick === null) console.log('  type a number from the list, or q');
    }
  } finally { rl.close(); }
  if (pick === 'quit') return 0;
  console.log(`\n$ kula-node ${pick.join(' ')}\n`);
  const code = await main(pick);
  // a double-clicked kula-node.exe closes its window on exit; let the person read first
  if (process.platform === 'win32') {
    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise<string>((resolve) => rl2.question('\npress enter to close ', resolve));
    rl2.close();
  }
  return code;
}

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 0) return menu();
  const { cmd, flags, rest } = parse(argv);
  const json = flags.json === true;
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    const v = versionInfo();
    // --json is a flag of the command, so `--version --json` reaches here as cmd + flag
    console.log(json ? JSON.stringify(v) : `kula-node ${v.version} (llama.cpp ${v.llama}, node ${v.node}, ${v.platform}-${v.arch}${v.packed ? ', single binary' : ''})`);
    return 0;
  }
  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || flags.help) { console.log(HELP); return 0; }

  if (cmd === 'info') {
    const v = versionInfo();
    const i = await collectInfo({ bandwidth: flags['no-bandwidth'] !== true });
    console.log(json ? JSON.stringify({ ...v, ...i }) : infoText(`kula-node ${v.version} (node ${v.node}, ${v.platform}-${v.arch}${v.packed ? ', single binary' : ''})`, i));
    return 0;
  }

  if (cmd === 'setup') {
    const dryRun = flags['dry-run'] === true;
    const check = flags.check === true;
    if (json && (check || dryRun)) {
      const found = findLlama();
      if (check || found) {
        console.log(JSON.stringify({ tag: TAG, found: !!found, where: found?.where ?? null, rpcServer: found?.rpcServer ?? null, llamaServer: found?.llamaServer ?? null, candidates: candidates() }, null, 2));
        return check && !found ? 1 : 0;
      }
      console.log(JSON.stringify(await planSetup(), null, 2));
      return 0;
    }
    // with --json the progress goes to stderr and stdout gets one object at the end
    const log = json ? (s: string) => console.error(s) : undefined;
    const got = await setup({ check, dryRun, log });
    if (json) console.log(JSON.stringify({ tag: TAG, ok: !!got, where: got?.where ?? null, rpcServer: got?.rpcServer ?? null, llamaServer: got?.llamaServer ?? null }));
    return got || dryRun ? 0 : 1;
  }

  if (cmd === 'peers') return peersCommand(rest[0], rest.slice(1), flags);
  if (cmd === 'chat') return chatCommand(flags);

  if (cmd === 'ledger') {
    return ledgerCommand({ verify: flags.verify === true, tail: flags.tail !== undefined ? num(flags.tail, 20) : undefined });
  }

  if (cmd === 'probe') {
    const [host, portS, secret] = rest;
    if (!host || !portS || !secret) { console.error('usage: kula-node probe <host> <port> <secret> [--json]'); return 2; }
    const port = Number(portS);
    let tlsOpts: TlsClient | null = null;
    if (typeof flags.fp === 'string') {
      if (!/^[0-9a-f]{64}$/i.test(flags.fp)) { console.error('--fp must be 64 hex characters'); return 2; }
      tlsOpts = { identity: loadOrCreateIdentity(home(), loadDeviceKey()), fp: flags.fp.toLowerCase(), pin: typeof flags.pin === 'string' ? flags.pin : null };
    }
    let bad = 0;
    const out: Record<string, unknown> = {};
    for (const channel of ['rpc', 'api'] as Channel[]) {
      const r = await probe(host, port, secret, channel, num(flags.timeout, 2000), tlsOpts);
      out[channel] = r;
      if (!r.ok) bad++;
      if (json) continue;
      if (r.ok) console.log(`${channel}: OK (${r.ms} ms)`);
      else console.log(`${channel}: NO ${r.reason}`);
    }
    if (json) console.log(JSON.stringify({ host, port, ...out }));
    return bad ? 1 : 0;
  }

  if (cmd === 'share') {
    const secret = typeof flags.secret === 'string' ? flags.secret : undefined;
    if (secret !== undefined && !/^[0-9a-f]{16,128}$/i.test(secret)) { console.error('--secret must be hex'); return 2; }
    if (process.platform === 'win32') console.error(WINDOWS_FIREWALL_NOTE);
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
