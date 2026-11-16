// "share this computer" on the chat page: the same worker as `kula-node share` (share.ts),
// started and stopped from the page instead of a terminal. Another computer (or a phone)
// on the wi-fi hears it on mdns and adds it with the one-time code shown here; from then on
// that device may run model layers here through the gate. The gate binds the network on
// purpose (it is the only door in, behind tls and the pairing); llama.cpp's programs stay
// on 127.0.0.1 behind it, as with the terminal command.
import path from 'node:path';
import { share as startShare, type ShareHandle, type ShareOptions } from '../share.js';
import type { AnchorHub } from '../anchor.js';
import { home } from '../paths.js';
import { WINDOWS_FIREWALL_NOTE } from '../llama.js';
import { keepAwake, type KeepAwake } from '../awake.js';
import { execFile } from 'node:child_process';

// Windows lets kula in only on networks it calls Private (the firewall prompt's "private
// networks"); a friend's wi-fi joined for the first time is often Public, and then no device
// reaches this computer. What Windows calls the connected networks, or null when unknown.
export function windowsNetworkCategories(run: typeof execFile = execFile): Promise<string[] | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetConnectionProfile | ForEach-Object { $_.NetworkCategory.ToString() }'], { timeout: 10000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout).split(/\r?\n/).map((x) => x.trim()).filter(Boolean));
    });
  });
}

export const WINDOWS_PUBLIC_NOTE = 'windows calls this wi-fi a public network, so other devices cannot reach kula here. in windows settings → network & internet → wi-fi → this network, choose "private network", then stop and start sharing again.';

export const SHARE_PORT = 50551;

export interface ShareView {
  on: boolean;
  starting: boolean;
  name: string | null;
  host: string | null;        // the lan address other devices reach this computer at
  port: number | null;
  code: string | null;        // the one-time pairing code, while one is open
  codeExpiresAt: number | null;
  error: string | null;
  note: string | null;        // windows: what the firewall will ask
  paired: number;             // devices that may already use this computer without a code
}

export type ShareStarter = (opts: ShareOptions) => Promise<ShareHandle>;

export class ShareHere {
  private handle: ShareHandle | null = null;
  private starting: Promise<void> | null = null;
  private error: string | null = null;
  private awake: KeepAwake | null = null;
  private publicNet = false;

  constructor(private opts: { port?: number; models?: string; name?: string; start?: ShareStarter; log?: (s: string) => void; awake?: () => KeepAwake; netCategories?: () => Promise<string[] | null> } = {}) {}

  view(): ShareView {
    const h = this.handle;
    const c = h?.code() ?? null;
    return {
      on: !!h, starting: !!this.starting, name: h?.deviceName ?? null, host: h?.host ?? null, port: h?.gatePort ?? null,
      code: c?.pin ?? null, codeExpiresAt: c?.exp ?? null, error: this.error,
      note: process.platform === 'win32' ? (this.publicNet ? `${WINDOWS_PUBLIC_NOTE}\n\n${WINDOWS_FIREWALL_NOTE}` : WINDOWS_FIREWALL_NOTE) : null,
      paired: h?.paired() ?? 0,
    };
  }

  // this computer's anchor while sharing runs with one (docs/ANCHOR.md); null otherwise. The
  // engine reaches devices registered here in one hop and reads its counters (engine.anchor)
  anchorHub(): AnchorHub | null {
    return this.handle?.anchor ?? null;
  }

  // the qr's json (kula-peer v3: name, address, certificate fingerprint, the open code)
  qr(): string | null {
    const t = this.handle?.qr();
    return t ? t : null;
  }

  async start(): Promise<ShareView> {
    if (this.handle) return this.view();
    if (!this.starting) {
      this.error = null;
      this.starting = (async () => {
        try {
          this.handle = await (this.opts.start ?? startShare)({
            port: this.opts.port ?? (Number(process.env.KULA_SHARE_PORT) || SHARE_PORT),
            models: this.opts.models ?? path.join(home(), 'models'),
            name: this.opts.name,
            noQr: true,
            dashboard: false,
            // the local network only: no ipv6 socket, so no global ipv6 address in the qr and no
            // way in from the internet where a router lets ipv6 through (the button says wi-fi)
            dualStack: false,
          });
          this.opts.log?.(`sharing this computer on port ${this.handle.gatePort}`);
          // no sleep while it lends itself: a sleeping worker drops out mid-answer (awake.ts)
          this.awake = (this.opts.awake ?? (() => keepAwake(this.opts.log)))();
          const cats = await (this.opts.netCategories ?? windowsNetworkCategories)();
          this.publicNet = !!cats?.length && cats.includes('Public');
          if (this.publicNet) this.opts.log?.(WINDOWS_PUBLIC_NOTE);
        } catch (e) {
          const m = (e as Error).message;
          this.error = /EADDRINUSE/.test(m) ? 'the share port is taken: is kula-node share already running in a terminal? stop it there first' : m;
        } finally {
          this.starting = null;
        }
      })();
    }
    await this.starting;
    return this.view();
  }

  async stop(): Promise<ShareView> {
    if (this.starting) await this.starting;
    const h = this.handle;
    this.handle = null;
    this.awake?.stop();
    this.awake = null;
    if (h) { await h(); this.opts.log?.('stopped sharing this computer'); }
    return this.view();
  }
}
