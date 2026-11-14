// "share this computer" on the chat page: the same worker as `kula-node share` (share.ts),
// started and stopped from the page instead of a terminal. Another computer (or a phone)
// on the wi-fi hears it on mdns and adds it with the one-time code shown here; from then on
// that device may run model layers here through the gate. The gate binds the network on
// purpose (it is the only door in, behind tls and the pairing); llama.cpp's programs stay
// on 127.0.0.1 behind it, as with the terminal command.
import path from 'node:path';
import { share as startShare, type ShareHandle, type ShareOptions } from '../share.js';
import { home } from '../paths.js';
import { WINDOWS_FIREWALL_NOTE } from '../llama.js';

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
}

export type ShareStarter = (opts: ShareOptions) => Promise<ShareHandle>;

export class ShareHere {
  private handle: ShareHandle | null = null;
  private starting: Promise<void> | null = null;
  private error: string | null = null;

  constructor(private opts: { port?: number; models?: string; name?: string; start?: ShareStarter; log?: (s: string) => void } = {}) {}

  view(): ShareView {
    const h = this.handle;
    const c = h?.code() ?? null;
    return {
      on: !!h, starting: !!this.starting, name: h?.deviceName ?? null, host: h?.host ?? null, port: h?.gatePort ?? null,
      code: c?.pin ?? null, codeExpiresAt: c?.exp ?? null, error: this.error,
      note: process.platform === 'win32' ? WINDOWS_FIREWALL_NOTE : null,
    };
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
          });
          this.opts.log?.(`sharing this computer on port ${this.handle.gatePort}`);
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
    if (h) { await h(); this.opts.log?.('stopped sharing this computer'); }
    return this.view();
  }
}
