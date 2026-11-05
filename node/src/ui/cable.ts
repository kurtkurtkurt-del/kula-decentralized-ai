// Phones on a usb cable, through adb (Android's platform-tools). No wi-fi, no relay, nothing
// outside this computer: adb forwards a port on 127.0.0.1 to the phone's gate (50551), and
// the gate's own tls and one-time code do the rest exactly as on the lan. What this file does
// with adb: list the devices, ask whether kula is installed, make and remove forwards, and
// open the phone's share screen with a deep link. Every call is execFile with an argument
// array (no shell on this computer) and a timeout. Nothing here changes a phone's settings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const KULA_PACKAGE = 'app.pasaport.android';
export const GATE_PORT = 50551;
// the share screen; start=1 starts sharing if it is not on (app/src/app/share.tsx)
export const SHARE_LINK = 'pasaport://share?start=1';

export const NO_ADB_HELP = 'to see phones on a cable this computer needs adb, from Android\'s platform-tools: download them from developer.android.com/tools/releases/platform-tools (Google\'s official page), unzip, and put the folder on your PATH (or install Android Studio). on the phone, turn on USB debugging: settings → about phone → tap "build number" seven times, then settings → developer options → USB debugging.';
export const UNAUTHORIZED_HELP = 'allow USB debugging on the phone: unlock it and tap "allow" on the prompt about this computer (unplug and plug in again if no prompt shows).';
export const OFFLINE_HELP = 'adb sees the phone but cannot talk to it: unplug it and plug it in again.';

export type CableState = 'device' | 'unauthorized' | 'offline' | string;
export interface CableDevice { serial: string; state: CableState; model: string | null; usb: boolean }
export interface Forward { serial: string; local: number; remote: string }

const SERIAL = /^[A-Za-z0-9._:-]{1,64}$/;
export const isSerial = (s: unknown): s is string => typeof s === 'string' && SERIAL.test(s);

// `adb devices -l`:
//   List of devices attached
//   R3CY10FLZLB            device usb:1-1 product:e2sxxx model:SM_S936B device:e2s transport_id:3
//   0123456789ABCDEF       unauthorized usb:1-2 transport_id:4
// plus "* daemon started" lines when the server was not running. A state may be two words
// ("no permissions" on linux), so the state is everything up to the first key:value field.
export function parseDevices(out: string): CableDevice[] {
  const list: CableDevice[] = [];
  for (const raw of out.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('*') || /^list of devices/i.test(line) || line.startsWith('adb ')) continue;
    const parts = line.split(/\s+/);
    const serial = parts[0];
    if (!isSerial(serial) || parts.length < 2) continue;
    const words: string[] = [];
    const fields = new Map<string, string>();
    for (const p of parts.slice(1)) {
      const m = /^([a-z_]+):(.*)$/.exec(p);
      if (m && !p.startsWith('(')) fields.set(m[1], m[2]);
      else if (!fields.size) words.push(p);
    }
    const state = words.join(' ').replace(/\s*\(.*$/, '').replace(/;.*$/, '') || 'unknown';
    const model = fields.get('model')?.replace(/_/g, ' ').trim() || null;
    list.push({ serial, state, model, usb: fields.has('usb') || !serial.includes(':') });
  }
  return list;
}

// `adb forward --list`: "R3CY10FLZLB tcp:50551 tcp:50551" per line
export function parseForwards(out: string): Forward[] {
  const list: Forward[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\S+)\s+tcp:(\d{1,5})\s+(\S+)\s*$/.exec(line.trim());
    if (m) list.push({ serial: m[1], local: Number(m[2]), remote: m[3] });
  }
  return list;
}

// `adb forward tcp:0 tcp:50551` prints the port it picked
export function parseForwardPort(out: string): number {
  const m = /^\s*(\d{1,5})\s*$/m.exec(out);
  const n = m ? Number(m[1]) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`adb did not say which port it forwarded (${out.trim().slice(0, 80) || 'nothing'})`);
  return n;
}

// adb on PATH first, then where the Android SDK puts it on each system.
export function findAdb(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (f: string) => boolean = isFile): string | null {
  const exe = platform === 'win32' ? 'adb.exe' : 'adb';
  const sep = platform === 'win32' ? ';' : ':';
  const dirs: string[] = [];
  for (const d of (env.PATH ?? env.Path ?? '').split(sep)) if (d) dirs.push(d);
  for (const sdk of [env.ANDROID_HOME, env.ANDROID_SDK_ROOT]) if (sdk) dirs.push(path.join(sdk, 'platform-tools'));
  const homeDir = env.HOME || env.USERPROFILE || os.homedir();
  if (platform === 'darwin') dirs.push(path.join(homeDir, 'Library', 'Android', 'sdk', 'platform-tools'));
  if (platform === 'linux') dirs.push(path.join(homeDir, 'Android', 'Sdk', 'platform-tools'));
  if (platform === 'win32' && env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools'));
  for (const d of dirs) {
    const f = path.join(d, exe);
    if (exists(f)) return f;
  }
  return null;
}

function isFile(f: string): boolean {
  try { return fs.statSync(f).isFile(); } catch { return false; }
}

export interface AdbOptions { bin?: string | null; env?: NodeJS.ProcessEnv; timeoutMs?: number }

export class Adb {
  readonly bin: string | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  // forwards this process made: removed again on close; one somebody else made is left alone
  private readonly made = new Set<string>();

  constructor(o: AdbOptions = {}) {
    this.env = o.env ?? process.env;
    this.bin = o.bin !== undefined ? o.bin : findAdb(this.env);
    this.timeoutMs = o.timeoutMs ?? 8000;
  }

  get present(): boolean { return !!this.bin; }

  run(args: string[], timeoutMs = this.timeoutMs): Promise<string> {
    const bin = this.bin;
    if (!bin) return Promise.reject(new Error(NO_ADB_HELP));
    return new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1 << 20, env: this.env, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          const why = String(stderr || '').trim().split('\n').pop() || ((err as { killed?: boolean }).killed ? 'timed out' : err.message);
          return reject(new Error(`adb ${args.filter((a) => a !== '-s').slice(0, 2).join(' ')}: ${why}`));
        }
        resolve(String(stdout));
      });
    });
  }

  async devices(): Promise<CableDevice[]> {
    return parseDevices(await this.run(['devices', '-l'], 5000));
  }

  // pm's filter is a substring match: the exact line decides
  async installed(serial: string, pkg = KULA_PACKAGE): Promise<boolean> {
    const out = await this.run(['-s', serial, 'shell', 'pm', 'list', 'packages', pkg]);
    return out.split(/\r?\n/).some((l) => l.trim() === `package:${pkg}`);
  }

  async forwards(): Promise<Forward[]> {
    return parseForwards(await this.run(['forward', '--list']));
  }

  // The local port that reaches the phone's gate: an existing forward for this phone is
  // reused (one made by hand with `adb forward tcp:50551 tcp:50551` too), else adb picks one.
  async forward(serial: string, remotePort = GATE_PORT): Promise<{ port: number; made: boolean }> {
    if (!isSerial(serial)) throw new Error('bad serial');
    const have = (await this.forwards().catch(() => [])).find((f) => f.serial === serial && f.remote === `tcp:${remotePort}`);
    if (have) return { port: have.local, made: false };
    const port = parseForwardPort(await this.run(['-s', serial, 'forward', 'tcp:0', `tcp:${remotePort}`]));
    this.made.add(`${serial} ${port}`);
    return { port, made: true };
  }

  async removeForward(serial: string, port: number): Promise<void> {
    if (!isSerial(serial) || !Number.isInteger(port)) return;
    this.made.delete(`${serial} ${port}`);
    await this.run(['-s', serial, 'forward', '--remove', `tcp:${port}`]).catch(() => {});
  }

  // The share screen through its deep link. `adb shell` hands its words to the phone's shell
  // as one line, so the link is quoted there ("?" is a glob character).
  async openShare(serial: string, link = SHARE_LINK): Promise<void> {
    if (!isSerial(serial)) throw new Error('bad serial');
    if (!/^[a-z]+:\/\/[A-Za-z0-9/?=&._-]+$/.test(link)) throw new Error('bad link');
    await this.run(['-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${link}'`, KULA_PACKAGE]);
  }

  // the forwards this process made, gone (the page is closing)
  async close(): Promise<void> {
    for (const k of [...this.made]) {
      const [serial, port] = k.split(' ');
      await this.removeForward(serial, Number(port));
    }
  }
}

// What a device row says about its state, in plain words; null when it is ready.
export function stateHelp(state: CableState): string | null {
  if (state === 'device') return null;
  if (state === 'unauthorized') return UNAUTHORIZED_HELP;
  if (state === 'offline') return OFFLINE_HELP;
  if (/permission/.test(state)) return 'this computer may not open the usb device: on linux, add a udev rule for Android phones (see developer.android.com/studio/run/device).';
  return `adb says "${state}": unplug the phone and plug it in again.`;
}
