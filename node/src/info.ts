// `kula-node info`: what this computer would tell a cluster about itself (the idea from the
// cloud packaging branch, claude/node-pack).
import os from 'node:os';
import { findLlama, TAG, cacheDir } from './llama.js';
import { lanIPv4, freeRamMB, totalRamMB, measureBandwidth, detectGpu } from './sysinfo.js';
import { home } from './paths.js';

export interface Info {
  hostname: string; host: string | null; ramFreeMB: number; ramTotalMB: number; bandwidthGBs: number;
  gpu: string | null; vramMB: number; llama: { tag: string; where: string | null; cache: string }; home: string;
}

export async function collectInfo(opts: { bandwidth?: boolean } = {}): Promise<Info> {
  const llama = findLlama();
  const [gpu, bw] = await Promise.all([detectGpu(), opts.bandwidth === false ? Promise.resolve(0) : measureBandwidth()]);
  return {
    hostname: os.hostname(), host: lanIPv4(), ramFreeMB: freeRamMB(), ramTotalMB: totalRamMB(), bandwidthGBs: bw,
    gpu: gpu.name, vramMB: gpu.vramMB, llama: { tag: TAG, where: llama?.where ?? null, cache: cacheDir() }, home: home(),
  };
}

export function infoText(head: string, i: Info): string {
  return [
    `${head} on ${i.hostname}`,
    `  address     ${i.host ?? 'no lan ipv4 (the phone will not reach this computer)'}`,
    `  ram         ${i.ramFreeMB} MB free of ${i.ramTotalMB} MB`,
    `  bandwidth   ${i.bandwidthGBs ? `${i.bandwidthGBs} GB/s` : 'not measured'}`,
    `  gpu         ${i.gpu ? `${i.gpu}${i.vramMB ? `, ${i.vramMB} MB` : ''}` : 'none found'}`,
    `  llama.cpp   ${i.llama.where ? `${i.llama.tag} at ${i.llama.where}` : `${i.llama.tag} not set up (kula-node setup)`}`,
    `  files       ${i.home}`,
  ].join('\n');
}
