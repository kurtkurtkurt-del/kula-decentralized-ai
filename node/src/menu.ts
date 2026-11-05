// `kula-node` with no arguments on a terminal: a short menu for the first
// run, so nobody has to read the help before anything happens.
import os from 'node:os';
import readline from 'node:readline';
import { findLlama, TAG } from './llama.js';
import { readPeers } from './peers.js';
import { VERSION, DIST } from './version.js';

export interface MenuItem { key: string; label: string; argv: string[] }

export function menuItems(): MenuItem[] {
  const llama = findLlama();
  const peers = (() => { try { return readPeers().length; } catch { return 0; } })();
  return [
    { key: '1', label: llama ? `setup     llama.cpp ${TAG} is ready (${llama.where})` : `setup     get llama.cpp ${TAG} (one download, checked by sha256)`, argv: ['setup'] },
    { key: '2', label: 'share     lend this computer to a phone cluster (shows a qr)', argv: ['share'] },
    { key: '3', label: peers ? `peers     ${peers} saved worker${peers === 1 ? '' : 's'}: probe them` : 'peers     no saved workers yet: scan the lan for phones and computers', argv: peers ? ['peers', 'probe'] : ['peers', 'scan'] },
    { key: '4', label: 'measure   this computer: ram, memory bandwidth, gpu, address', argv: ['info'] },
    { key: 'h', label: 'help      every command and flag', argv: ['help'] },
    { key: 'q', label: 'quit', argv: [] },
  ];
}

export function menuText(items = menuItems()): string {
  return [
    `kula-node ${VERSION} (${DIST}) on ${os.hostname()}`,
    '',
    ...items.map((i) => `  ${i.key}  ${i.label}`),
    '',
  ].join('\n');
}

function ask(q: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(q, (a) => { rl.close(); resolve(a.trim()); }));
}

// Returns the argv the user picked, or null for quit.
export async function menu(): Promise<string[] | null> {
  const items = menuItems();
  console.log(menuText(items));
  for (;;) {
    const a = (await ask('> ')).toLowerCase();
    if (a === '' || a === 'q' || a === 'quit' || a === 'exit') return null;
    const hit = items.find((i) => i.key === a || i.argv[0] === a);
    if (hit) return hit.argv.length ? hit.argv : null;
    console.log(`pick one of ${items.map((i) => i.key).join(' ')}`);
  }
}
