// The command line: setup, share, probe, peers, paired, chat, ledger; a short menu when run bare.
import fs from 'node:fs';
import readline from 'node:readline';
import { probe, type Channel, type TlsClient } from './gate.js';
import { loadOrCreateIdentity } from './tls.js';
import { loadOrCreate as loadDeviceKey } from './audit/key.js';
import { setup, planSetup, findLlama, candidates, TAG, WINDOWS_FIREWALL_NOTE } from './llama.js';
import { share } from './share.js';
import { home, packageRoot } from './paths.js';
import { version, isPacked } from './build.js';
import { ledgerCommand } from './ledgercmd.js';
import { loadStatusList, refreshStatusList, statusFile, STATUS_URL } from './attest.js';
import { pairedCommand } from './unpair.js';
import { collectInfo, infoText } from './info.js';
import { peersCommand, chatCommand } from './mastercmd.js';
import { benchCommand } from './bench.js';
import { uiCommand } from './ui/cmd.js';

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
      tls is the default: protocol v2 between device certificates, a qr (v3) with the
      certificate's fingerprint and a one-time code. v1 is off unless a secret is given on
      purpose (old phones), and goes off for good once a device has paired.
      --no-tls          the old v1-only gate: a qr (v2) with a fresh secret each run; prompts and
                        answers then cross the network in plain text
      --secret-file <path>   v1 cluster secret (hex) from a file only you can read (mode 600)
      KULA_SECRET=<hex> the same from the environment
      --secret <hex>    the same on the command line (works, but every user sees it in ps)
      --lie-ram <MB>    advertise a false amount of free ram (for audit tests)
      --no-qr           print the json payload only
      --relay <wss://…> also register with that relay so a device far away (behind nat) can come in
                        with a six digit code; the qr carries it. needs tls (docs/RELAY.md)
      --dashboard <n>   local dashboard port on 127.0.0.1 (default 50580); --no-dashboard turns it off
  kula-node probe <host> <port> <secret> [--json]   handshake on both channels, print OK/NO
      secret "env" reads $KULA_SECRET (a secret typed here shows in ps); "-" is none
      --fp <hex> [--pin <code>]   probe over tls (v2) against that certificate fingerprint; secret may be "-"
  kula-node paired list [--json]     the devices (phones, computers) that can use this computer
                                     without a code: fingerprint, name, address, when paired, last seen
  kula-node paired remove <fp prefix>   take one device's access away (6+ hex characters of its
                                     fingerprint): a running share refuses it at once and closes its
                                     connections; one signed ledger line. it pairs again only with a fresh code
  kula-node ledger [--verify] [--tail N]   print the signed ledger; --verify checks the chain and signatures
  kula-node attestation [refresh]    Google's revocation list for phones' hardware proofs (owner-blind):
                                     whether a copy is kept here and from when; refresh fetches it
                                     (an internet call, only when you run it) into ~/.kula-node
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
  kula-node bench [--model <file.gguf>] [--peer id…] [options]   measure, save to ~/.kula-node/bench/<date>.json
      local prompt and generation tok/s (3 runs, median), memory bandwidth, gate round trip,
      tunnel speed (10 MB), each peer's tok/s in apart mode, split load time and token time
      --runs <n> (3)  --tokens <n> (64)  --ctx <n> (2048)  --tunnel-mb <n> (10, at most 64)
      --no-apart  --no-split  --json (print the record)  --out <dir>

the chat page (a model on your phone, the chat on this computer):
  kula-node ui [--port <n>] [--no-open] [--new-token] [--new-prefix] [--lan]   http://127.0.0.1:50590/<random>/
      the <random> part is kept in ~/.kula-node/ui-prefix, so the address stays the same
      (bookmark it); --new-prefix makes a new one. a second \`kula-node ui\` while one runs
      opens that one. --stop stops it.
      --install-mac [--login]   ~/Applications/kula.app: one click starts the page (in the
                        background, if it is not up) and opens it; --login also starts it at
                        login (a LaunchAgent). --uninstall-mac removes both.
      on the phone: share this phone; on the page: connect, add the phone, pick a model, chat.
      also an openai-compatible endpoint at http://127.0.0.1:50590/v1 (bearer token printed
      at start, kept in ~/.kula-node/ui-token; --new-token makes a new one). chats are kept
      in ~/.kula-node/chats. 127.0.0.1 only, unless:
      --lan             invite mode: also listen on this computer's wi-fi address and print an
                        invite qr; any device on that network scans it and chats (plain http on
                        the lan: others on that wi-fi could read the chat text). the page has
                        the same switch, and "new invite" ends every guest's session.

the dashboard: while share or chat runs, http://127.0.0.1:50580/<random>/ (the exact
url is printed) shows this computer, the gate, the peers, the ledger, a chat box
and the pairing qr. it answers on 127.0.0.1 only.

files live in ${home()} (KULA_NODE_HOME overrides)
`;

// flags that never take a value, so `--json host` does not swallow the host
const BOOLEAN = new Set(['json', 'help', 'check', 'dry-run', 'no-qr', 'no-dashboard', 'verify', 'no-local', 'keep-local', 'code', 'tls', 'no-tls', 'no-apart', 'no-split', 'no-bandwidth', 'no-open', 'new-token', 'lan', 'new-prefix', 'stop', 'install-mac', 'uninstall-mac', 'login']);

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

const HEX_SECRET = /^[0-9a-f]{16,128}$/i;
const PS_NOTE = 'is visible to every user of this computer (ps); use KULA_SECRET=<hex> or --secret-file <path> (mode 600) instead';

// The v1 secret for share, from --secret-file or --secret (not both), else $KULA_SECRET; a
// flag wins over the environment. Never echoes the secret: an error names where it came
// from, not what it was.
export function secretFrom(flags: Record<string, string | boolean>, env: NodeJS.ProcessEnv = process.env, warn: (s: string) => void = (s) => console.error(s)): { secret?: string; error?: string } {
  const file = flags['secret-file'];
  const arg = flags.secret;
  if (file === true) return { error: '--secret-file needs a path' };
  if (arg === true) return { error: '--secret needs a value' };
  if (typeof file === 'string' && typeof arg === 'string') return { error: 'give the secret one way: --secret-file or --secret' };
  if (typeof file === 'string') {
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { return { error: `--secret-file: cannot read ${file}` }; }
    if (process.platform !== 'win32' && (st.mode & 0o044)) return { error: `--secret-file: ${file} can be read by other users; chmod 600 ${file}` };
    let text: string;
    try { text = fs.readFileSync(file, 'utf8').trim(); } catch { return { error: `--secret-file: cannot read ${file}` }; }
    if (!HEX_SECRET.test(text)) return { error: `--secret-file: ${file} must hold one hex secret (16 to 128 characters)` };
    return { secret: text.toLowerCase() };
  }
  if (typeof arg === 'string') {
    if (!HEX_SECRET.test(arg)) return { error: '--secret must be hex' };
    warn(`warning: --secret ${PS_NOTE}`);
    return { secret: arg.toLowerCase() };
  }
  const e = env.KULA_SECRET;
  if (e !== undefined && e !== '') {
    if (!HEX_SECRET.test(e.trim())) return { error: 'KULA_SECRET must be hex (16 to 128 characters)' };
    return { secret: e.trim().toLowerCase() };
  }
  return {};
}

// probe's secret word: "env" is $KULA_SECRET, "-" none (tls only), anything else the secret
// itself (with the ps warning).
export function probeSecret(word: string, env: NodeJS.ProcessEnv = process.env, warn: (s: string) => void = (s) => console.error(s)): { secret?: string; error?: string } {
  if (word === '-') return { secret: '-' };
  if (word === 'env') {
    const e = env.KULA_SECRET?.trim();
    return e ? { secret: e } : { error: 'probe: secret "env" but KULA_SECRET is not set' };
  }
  warn('warning: a secret on the command line is visible to every user of this computer (ps); set KULA_SECRET=<hex> and write "env" in its place');
  return { secret: word };
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
    { key: '4', argv: ['ui'], label: 'ui', note: 'the chat page: talk to a model on your phone from here' },
    { key: '5', argv: ['help'], label: 'help', note: 'every command and flag' },
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
    console.log('\nrun one of: kula-node setup | kula-node share | kula-node peers list | kula-node ui | kula-node help');
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
  if (cmd === 'paired') return pairedCommand(rest[0], rest.slice(1), flags);
  if (cmd === 'chat') return chatCommand(flags);
  if (cmd === 'bench') return benchCommand(flags);
  if (cmd === 'ui') return uiCommand(flags);

  if (cmd === 'attestation') return attestationCommand(rest[0]);
  if (cmd === 'ledger') {
    return ledgerCommand({ verify: flags.verify === true, tail: flags.tail !== undefined ? num(flags.tail, 20) : undefined });
  }

  if (cmd === 'probe') {
    const [host, portS, word] = rest;
    if (!host || !portS || !word) { console.error('usage: kula-node probe <host> <port> <secret | env | -> [--json]'); return 2; }
    const ps = probeSecret(word);
    if (ps.error) { console.error(ps.error); return 2; }
    const secret = ps.secret!;
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
    const got = secretFrom(flags);
    if (got.error) { console.error(got.error); return 2; }
    const secret = got.secret;
    if (flags['no-tls'] === true && typeof flags.relay === 'string') { console.error('--relay needs tls: drop --no-tls'); return 2; }
    if (flags['no-tls'] === true) console.error('warning: --no-tls: v1 only, prompts and answers cross the network in plain text');
    if (process.platform === 'win32') console.error(WINDOWS_FIREWALL_NOTE);
    const stop = await share({
      port: num(flags.port, 50551),
      name: typeof flags.name === 'string' ? flags.name : undefined,
      models: typeof flags.models === 'string' ? flags.models : '~/.kula-node/models',
      secret,
      lieRam: flags['lie-ram'] !== undefined ? num(flags['lie-ram'], 0) : undefined,
      noQr: flags['no-qr'] === true,
      // tls unless --no-tls; --tls is still taken (it was the switch before tls was the default)
      tls: flags['no-tls'] !== true,
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

// The revocation list the owner-blind check reads (attest.ts). Nothing fetches it on its own: no
// outside network unless the person asks, here.
async function attestationCommand(sub: string | undefined): Promise<number> {
  if (sub === 'refresh') {
    try {
      const l = await refreshStatusList();
      console.log(`fetched ${STATUS_URL}: ${l.serials.size} revoked keys, kept in ${statusFile()}`);
      return 0;
    } catch (e) { console.error(`could not fetch it: ${(e as Error).message}`); return 1; }
  }
  if (sub !== undefined) { console.error('usage: kula-node attestation [refresh]'); return 2; }
  const l = loadStatusList();
  console.log(l
    ? `Google's revocation list from ${new Date(l.fetched).toISOString().slice(0, 10)}: ${l.serials.size} revoked keys (${statusFile()})`
    : 'no copy of Google\'s revocation list here: phones\' proofs are checked without it. kula-node attestation refresh fetches it (an internet call).');
  return 0;
}
