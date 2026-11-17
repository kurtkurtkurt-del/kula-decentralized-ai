// "share this computer" on the chat page: the same worker as `kula-node share` (share.ts),
// started and stopped from the page instead of a terminal. Another computer (or a phone)
// on the wi-fi hears it on mdns and adds it with the one-time code shown here; from then on
// that device may run model layers here through the gate. The gate binds the network on
// purpose (it is the only door in, behind tls and the pairing); llama.cpp's programs stay
// on 127.0.0.1 behind it, as with the terminal command.
//
// "make this computer an anchor" (docs/ANCHOR.md, a switch under it, off by default): sharing
// then runs with the anchor hub on, the gate on ipv6 and ipv4, and the router asked for the gate
// port; the page says in plain words what the router answered and makes invites for far devices.
// The switch is a setting (~/.kula-node/anchor.json): kula-node ui starts sharing with it again
// after a restart, and the computer stays awake while it is on (sharing keeps it awake).
import fs from 'node:fs';
import path from 'node:path';
import { share as startShare, type ShareHandle, type ShareOptions } from '../share.js';
import type { AnchorCaps, AnchorHub } from '../anchor.js';
import type { Mapping } from '../portmap.js';
import { reachableFromOutside, linkWords, isWhose, type Invite, type LinkView, type Whose } from '../join.js';
import { ANCHOR_CAPS } from '../anchor.js';
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

// ---- the anchor switch: its setting and its plain words

export interface AnchorSetting { on: boolean; caps?: Partial<AnchorCaps> }

export const anchorSettingFile = (dir: string = home()): string => path.join(dir, 'anchor.json');

export function readAnchorSetting(file: string): AnchorSetting {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { on: o?.on === true, ...(o?.caps && typeof o.caps === 'object' ? { caps: o.caps } : {}) };
  } catch {
    return { on: false };
  }
}

export function writeAnchorSetting(file: string, s: AnchorSetting): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// what the router answered: it mapped the port; it did not answer; it said no; it mapped, but the
// address it reports is itself private or shared (carrier nat: no door from the internet)
export type MapState = 'mapped' | 'silent' | 'refused' | 'cgnat';

export function mapState(pm: { asked: boolean; mapping: Mapping | null; why: string | null } | null | undefined): MapState | null {
  if (!pm?.asked) return null;
  if (pm.mapping) return pm.mapping.behindAnotherNat ? 'cgnat' : 'mapped';
  if (pm.why && /\b(pcp|nat-pmp|upnp):/.test(pm.why)) return 'refused';
  return 'silent';
}

export const CGNAT_WORDS = 'your provider does not give this home a public address: this computer cannot be an anchor from outside; it can still be a member of another anchor.';

const hp = (h: string, port: number) => `${h.includes(':') ? `[${h}]` : h}:${port}`;

export interface AnchorWordsInput {
  on: boolean; live: boolean; map: MapState | null; why: string | null;
  external: string | null; ipv6: string[]; lan: string | null; port: number | null;
  reachable: boolean | null; members: number;
}

// The anchor's state in plain words, for every state the switch can be in.
export function anchorWords(a: AnchorWordsInput): string {
  // the switch's own description says what it does: off is just off
  if (!a.on) return 'off.';
  if (!a.live) return 'starting: sharing this computer and asking the router for a door…';
  const port = a.port ?? SHARE_PORT;
  const lan = a.lan ? ` (address ${a.lan.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')})` : '';
  const byHand = `open port ${port} for this computer${lan} in your router's settings, called port forwarding. then make an invite.`;
  const parts: string[] = [];
  if (a.map === 'mapped') parts.push(a.external ? `the router opened the door: from the internet this computer answers at ${a.external}.` : `the router opened port ${port}, but did not say its address on the internet.`);
  else if (a.map === 'cgnat') parts.push(CGNAT_WORDS);
  else if (a.map === 'refused') parts.push(`the router said no${a.why ? ` (${a.why})` : ''}: ${byHand}`);
  else parts.push(`no answer from the router: ${byHand}`);
  if (a.ipv6.length) parts.push(`over ipv6 it may also answer at ${a.ipv6[0]}, if the router lets it in.`);
  if (a.reachable) parts.push('reached from outside: a device came in from the internet.');
  else if (a.map !== 'cgnat' || a.ipv6.length) parts.push('not confirmed from outside yet: that shows once a device registers here from away from this network.');
  if (a.members) parts.push(a.members === 1 ? '1 device is connected through it now.' : `${a.members} devices are connected through it now.`);
  return parts.join(' ');
}

export interface InviteView {
  whose: Whose;
  code: string;               // the text to copy ("paste a code" on the page; kula-node peers add <code> in a terminal)
  exp: number;
  lanOnly: boolean;            // no address from outside: works on this network only
  typed: { address: string; code: string; certificate: string };
  words: string;
}

export function inviteView(inv: Invite): InviteView {
  const until = new Date(inv.exp).toTimeString().slice(0, 5);
  return {
    whose: inv.whose, code: inv.code, exp: inv.exp, lanOnly: inv.lanOnly, typed: inv.typed,
    words: `for ${inv.whose === 'mine' ? 'a computer of yours: after it joins, press \'yes, it is mine\' on its row in devices here; until then it is limited like a friend\'s' :'a friend\'s computer (what it passes through here is limited each day)'}. it works once, until ${until}. on the other computer: devices → add a device → paste a code, and paste it there. or type it: devices → add a device → type it, with address ${inv.typed.address}, code ${inv.typed.code}, certificate ${inv.typed.certificate}, and turn on "an invite from an anchor".`
      + (inv.lanOnly ? ' it works only on this network for now: no door from the internet yet.' : ''),
  };
}

export interface AnchorShareView {
  on: boolean;                 // the switch (a setting)
  live: boolean;               // the hub runs now
  map: MapState | null;
  external: string | null;     // where the internet reaches it (the router's address and port)
  ipv6: string[];
  lan: string | null;
  reachable: boolean | null;   // true only once a member registered from a non-private address
  members: number;
  words: string;
  invite: InviteView | null;   // the invite still open
  capGb: number;               // what a friend's device may pass a day (the person's own: no limit)
}

// The anchor part of the share view, from a running share (or none).
export function anchorShareView(h: ShareHandle | null, setting: AnchorSetting): AnchorShareView {
  const hub = h?.anchor ?? null;
  const pm = h?.portMap?.() ?? null;
  const m = pm?.mapping ?? null;
  const addrs = h?.addrs?.() ?? [];
  const lanA = addrs.find((a) => a.via === 'lan');
  const members = hub ? hub.members() : [];
  const input: AnchorWordsInput = {
    on: setting.on, live: !!hub, map: hub ? mapState(pm) : null, why: pm?.why ?? null,
    external: m?.externalIp && !m.behindAnotherNat ? hp(m.externalIp, m.externalPort) : null,
    ipv6: addrs.filter((a) => a.via === 'ipv6').map((a) => hp(a.host, a.port)),
    lan: lanA ? hp(lanA.host, lanA.port) : h?.host ? hp(h.host, h.gatePort) : null,
    port: h?.gatePort ?? null,
    reachable: hub ? (reachableFromOutside(members) ? true : null) : null,
    members: members.length,
  };
  const inv = hub ? h?.openInvite?.() ?? null : null;
  const cap = (hub as { caps?: { bytesPerDay?: number } } | null)?.caps?.bytesPerDay ?? setting.caps?.bytesPerDay ?? ANCHOR_CAPS.bytesPerDay;
  return {
    on: input.on, live: input.live, map: input.map, external: input.external, ipv6: input.ipv6, lan: input.lan, reachable: input.reachable, members: input.members,
    words: anchorWords(input), invite: inv ? inviteView(inv) : null, capGb: Math.round((cap / 1e9) * 10) / 10,
  };
}

export interface JoinedView { name: string; state: LinkView['state'] | 'off'; words: string }

// A joined anchor the running share does not list (yet): while sharing starts, or in the moment
// after a join before the share reads the store, it is being linked; only without sharing is it
// not linked at all.
export function joinedWithoutLink(name: string, share: { on: boolean; starting: boolean }): JoinedView {
  if (share.on || share.starting) return { name, state: 'registering', words: `${name}: linking…` };
  return { name, state: 'off', words: `${name}: not linked while this computer does not share. press "start sharing" above to link to it.` };
}

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
  anchor: AnchorShareView;    // "make this computer an anchor"
  joined: JoinedView[];       // the anchors this computer joined, and its link to each
}

export type ShareStarter = (opts: ShareOptions) => Promise<ShareHandle>;

export class ShareHere {
  private handle: ShareHandle | null = null;
  private starting: Promise<void> | null = null;
  private error: string | null = null;
  private awake: KeepAwake | null = null;
  private publicNet = false;
  private setting: AnchorSetting;

  constructor(private opts: { port?: number; models?: string; name?: string; start?: ShareStarter; log?: (s: string) => void; awake?: () => KeepAwake; netCategories?: () => Promise<string[] | null>; settingFile?: string } = {}) {
    this.setting = readAnchorSetting(this.settingFile());
  }

  private settingFile(): string { return this.opts.settingFile ?? anchorSettingFile(); }

  view(): ShareView {
    const h = this.handle;
    const c = h?.code() ?? null;
    return {
      on: !!h, starting: !!this.starting, name: h?.deviceName ?? null, host: h?.host ?? null, port: h?.gatePort ?? null,
      code: c?.pin ?? null, codeExpiresAt: c?.exp ?? null, error: this.error,
      note: process.platform === 'win32' ? (this.publicNet ? `${WINDOWS_PUBLIC_NOTE}\n\n${WINDOWS_FIREWALL_NOTE}` : WINDOWS_FIREWALL_NOTE) : null,
      paired: h?.paired() ?? 0,
      anchor: anchorShareView(h, this.setting),
      joined: (h?.links?.() ?? []).map((l) => ({ name: l.name, state: l.state, words: linkWords(l) })),
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
      const anchor = this.setting.on;
      this.starting = (async () => {
        try {
          this.handle = await (this.opts.start ?? startShare)({
            port: this.opts.port ?? (Number(process.env.KULA_SHARE_PORT) || SHARE_PORT),
            models: this.opts.models ?? path.join(home(), 'models'),
            name: this.opts.name,
            noQr: true,
            dashboard: false,
            // without the anchor: the local network only, no ipv6 socket, so no global ipv6 address
            // in the qr and no way in from the internet where a router lets ipv6 through (the button
            // says wi-fi). With it: ipv6 and ipv4, and the router asked for the gate port
            dualStack: anchor,
            ...(anchor ? { mapPort: true, anchor: this.setting.caps && Object.keys(this.setting.caps).length ? this.setting.caps : true } : {}),
          });
          this.opts.log?.(`sharing this computer on port ${this.handle.gatePort}${anchor ? ', as an anchor' : ''}`);
          if (anchor) this.opts.log?.(`anchor: ${anchorShareView(this.handle, this.setting).words}`);
          // no sleep while it lends itself: a sleeping worker drops out mid-answer (awake.ts)
          this.awake = (this.opts.awake ?? (() => keepAwake(this.opts.log)))();
          const cats = await (this.opts.netCategories ?? windowsNetworkCategories)();
          this.publicNet = !!cats?.length && cats.includes('Public');
          if (this.publicNet) this.opts.log?.(WINDOWS_PUBLIC_NOTE);
        } catch (e) {
          const m = (e as Error).message;
          this.error = /EADDRINUSE/.test(m) ? 'another program already uses the port for sharing: is kula already sharing in a terminal window? stop it there first' : m;
        } finally {
          this.starting = null;
        }
      })();
    }
    await this.starting;
    return this.view();
  }

  // `byPerson`: the person pressed stop: the anchor goes off too (it needs sharing), so it does
  // not come back by itself at the next start of kula. kula closing keeps the setting.
  async stop(byPerson = false): Promise<ShareView> {
    if (this.starting) await this.starting;
    if (byPerson && this.setting.on) this.saveSetting({ ...this.setting, on: false });
    const h = this.handle;
    this.handle = null;
    this.awake?.stop();
    this.awake = null;
    if (h) { await h(); this.opts.log?.('stopped sharing this computer'); }
    return this.view();
  }

  private saveSetting(s: AnchorSetting) {
    this.setting = s;
    try { writeAnchorSetting(this.settingFile(), s); } catch (e) { this.opts.log?.(`anchor: the setting could not be kept: ${(e as Error).message}`); }
  }

  // The switch. On: sharing (re)starts with the anchor; off: sharing goes on without it (a
  // restart: the gate's socket and the router's door change). Kept as a setting.
  async setAnchor(on: boolean): Promise<ShareView> {
    if (this.starting) await this.starting;
    if (on === this.setting.on && (!on || this.handle?.anchor)) return this.view();
    this.saveSetting({ ...this.setting, on });
    this.opts.log?.(on ? 'anchor: turned on' : 'anchor: turned off');
    const sharing = !!this.handle;
    if (sharing) await this.stop();
    if (on || sharing) await this.start();
    return this.view();
  }

  // kula-node ui started: the anchor was on when it last ran, so it is on again (it needs sharing)
  async resume(): Promise<ShareView> {
    if (this.setting.on && !this.handle) return this.start();
    return this.view();
  }

  // A new invite for a far device (the old one stops working). Only while the anchor is on.
  // `whose`: the person's own computer (never byte-capped) or a friend's (capped a day).
  invite(whose: Whose = 'friend'): InviteView {
    const h = this.handle;
    if (!h?.anchor || !h.invite) throw new Error('turn on "make this computer an anchor" first');
    if (!isWhose(whose)) throw new Error('whose device: mine or friend');
    return inviteView(h.invite(whose));
  }

  // "a friend's device may pass up to N GB a day through this computer": kept with the switch and
  // set on the running anchor at once (the person's own devices are never capped)
  setFriendCap(gb: number): ShareView {
    if (!Number.isFinite(gb) || gb <= 0 || gb > 100_000) throw new Error('a number of GB above 0');
    const bytesPerDay = Math.round(gb * 1e9);
    this.saveSetting({ ...this.setting, caps: { ...(this.setting.caps ?? {}), bytesPerDay } });
    this.handle?.anchor?.setCaps({ bytesPerDay });
    this.opts.log?.(`anchor: a friend's device may pass up to ${gb} GB a day`);
    return this.view();
  }

  // the open invite's text for its qr; null when none is open
  inviteText(): string | null {
    const inv = this.handle?.anchor ? this.handle.openInvite?.() ?? null : null;
    return inv ? inv.text : null;
  }

  // a computer joined an anchor (the store changed): the running share registers there now;
  // without sharing nothing registers, so sharing starts (the anchor reaches this computer only
  // through its gate)
  async joined(): Promise<ShareView> {
    if (this.starting) await this.starting;
    if (this.handle) { this.handle.rejoin?.(); return this.view(); }
    this.opts.log?.('joined an anchor: sharing this computer so the anchor can reach it');
    return this.start();
  }
}
