// Asking the home router for a port (docs/INTERNET.md, layer 2). Opt-in only (`kula-node share
// --map-port`): the router is the one other machine asked, nothing outside is. Three ways, tried
// in this order, no dependency:
//
//   PCP      RFC 6887, udp 5351 on the gateway, version 2, the MAP opcode
//   NAT-PMP  RFC 6886, the same port, version 0; a PCP router answers an old client too, and an
//            old router answers a PCP request with version 0, which is the signal to fall back
//   UPnP-IGD ssdp M-SEARCH on 239.255.255.250:1900, the router's description over http, then
//            the soap AddPortMapping of WANIPConnection / WANPPPConnection. The description url
//            must be on the router's own private address: an answer that points anywhere else
//            is not followed.
//
// What it maps is the gate port, tcp, from the router's public side to this computer. It renews
// at half the lifetime the router granted, removes the mapping on stop, and says the external
// address the router reports; an external address that is itself private or shared (100.64/10,
// a second nat or carrier nat) is said too: the mapping then does not reach the internet.
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { isPrivateAddress } from './policy.js';

export const PMP_PORT = 5351;
export const SSDP_ADDR = '239.255.255.250';
export const SSDP_PORT = 1900;
// what is asked for; routers often grant less, renewal follows what was granted
export const LIFETIME_S = 3600;
// udp retries: 250 ms, doubled each time (RFC 6886 starts at 250 ms too); 4 tries ~ 3.75 s
const TRIES = 4;
const FIRST_WAIT_MS = 250;

export type MapVia = 'pcp' | 'natpmp' | 'upnp';

export interface Mapping {
  via: MapVia;
  gateway: string;
  internalPort: number;
  externalPort: number;
  externalIp: string | null;   // null: the router did not say
  lifetimeS: number;           // what the router granted; 0 for a upnp lease that never ends
  // the external address is itself private or shared: a second nat, a carrier nat; the
  // mapping then does not reach the internet
  behindAnotherNat: boolean;
  at: number;                  // when it was made or last renewed
}

export interface MapOptions {
  internalPort: number;
  gateway?: string | null;     // default: the system's default route
  pmpPort?: number;            // tests: a fake server on 127.0.0.1
  ssdp?: { host: string; port: number } | null;   // tests: unicast; null skips upnp
  timeoutMs?: number;          // per try of the first udp wait (doubles)
  tries?: number;
  lifetimeS?: number;
  // the address the router should map to; default: this computer's address towards the gateway
  clientIp?: string | null;
  minRenewMs?: number;         // the soonest a renewal runs (default 5 s; tests go lower)
}

// ---- the default gateway, from the system (no library: each system says it its own way)

export function parseProcRoute(text: string): string | null {
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3 || f[1] !== '00000000') continue;
    const hex = f[2];
    if (!/^[0-9A-Fa-f]{8}$/.test(hex)) continue;
    // little endian
    const b = [6, 4, 2, 0].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const ip = b.join('.');
    if (ip !== '0.0.0.0') return ip;
  }
  return null;
}

export function parseRouteGet(text: string): string | null {
  const m = /gateway:\s*(\d+\.\d+\.\d+\.\d+)/.exec(text);
  return m ? m[1] : null;
}

export function parseRoutePrint(text: string): string | null {
  // windows: "          0.0.0.0          0.0.0.0      192.168.1.1    192.168.1.20     25"
  const m = /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)\s/m.exec(text);
  return m ? m[1] : null;
}

const run = (cmd: string, args: string[]) => new Promise<string>((resolve) => {
  execFile(cmd, args, { timeout: 3000, encoding: 'utf8' }, (err, out) => resolve(err ? '' : String(out)));
});

export async function defaultGateway(): Promise<string | null> {
  if (process.platform === 'linux' || process.platform === 'android') {
    try { return parseProcRoute(fs.readFileSync('/proc/net/route', 'utf8')); } catch { return null; }
  }
  if (process.platform === 'win32') return parseRoutePrint(await run('route', ['print', '-4', '0.0.0.0']));
  return parseRouteGet(await run('route', ['-n', 'get', 'default']));
}

// ---- udp: one request, retried, the first answer that `accept` takes

function udpAsk(host: string, port: number, msg: Buffer, accept: (b: Buffer) => boolean, tries: number, firstMs: number): Promise<{ answer: Buffer; local: string } | null> {
  return new Promise((resolve) => {
    let s: dgram.Socket;
    try { s = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4'); } catch { return resolve(null); }
    let timer: NodeJS.Timeout | null = null;
    let local = '';
    const done = (v: { answer: Buffer; local: string } | null) => {
      if (timer) clearTimeout(timer);
      try { s.close(); } catch {}
      resolve(v);
    };
    s.on('error', () => done(null));
    s.on('message', (b, from) => {
      // only the gateway itself is listened to
      if (from.address !== host && from.address !== `::ffff:${host}`) return;
      if (accept(b)) done({ answer: b, local });
    });
    let n = 0;
    const send = () => {
      if (n >= tries) return done(null);
      const wait = firstMs * 2 ** n;
      n++;
      s.send(msg, (err) => { if (err) done(null); });
      timer = setTimeout(send, wait);
    };
    try {
      s.connect(port, host, () => {
        try { local = s.address().address; } catch {}
        send();
      });
    } catch { done(null); }
  });
}

// ---- NAT-PMP (RFC 6886)

const PMP_RESULTS = ['success', 'unsupported version', 'not authorized', 'network failure', 'out of resources', 'unsupported opcode'];

export function pmpMapRequest(internalPort: number, externalPort: number, lifetimeS: number): Buffer {
  const b = Buffer.alloc(12);
  b[0] = 0;          // version
  b[1] = 2;          // map tcp
  b.writeUInt16BE(internalPort, 4);
  b.writeUInt16BE(externalPort, 6);
  b.writeUInt32BE(lifetimeS, 8);
  return b;
}

export const pmpAddressRequest = (): Buffer => Buffer.from([0, 0]);

export class MapRefused extends Error {}

async function natpmp(gw: string, o: Required<Pick<MapOptions, 'internalPort' | 'pmpPort' | 'tries' | 'lifetimeS' | 'timeoutMs'>>, externalPort: number, lifetimeS: number): Promise<{ externalPort: number; lifetimeS: number; externalIp: string | null } | null> {
  const r = await udpAsk(gw, o.pmpPort, pmpMapRequest(o.internalPort, externalPort, lifetimeS),
    // an error answer may stop after the result code; a success names our internal port
    (b) => b.length >= 4 && b[0] === 0 && b[1] === 130 && (b.readUInt16BE(2) !== 0 || (b.length >= 16 && b.readUInt16BE(8) === o.internalPort)), o.tries, o.timeoutMs);
  if (!r) return null;
  const code = r.answer.readUInt16BE(2);
  if (code !== 0) throw new MapRefused(`nat-pmp: ${PMP_RESULTS[code] ?? `result ${code}`}`);
  const got = { externalPort: r.answer.readUInt16BE(10), lifetimeS: r.answer.readUInt32BE(12), externalIp: null as string | null };
  if (lifetimeS === 0) return got;
  const a = await udpAsk(gw, o.pmpPort, pmpAddressRequest(), (b) => b.length >= 12 && b[0] === 0 && b[1] === 128, o.tries, o.timeoutMs);
  if (a && a.answer.readUInt16BE(2) === 0) got.externalIp = [...a.answer.subarray(8, 12)].join('.');
  return got;
}

// ---- PCP (RFC 6887): a 24 byte header and the 36 byte MAP opcode

const PCP_RESULTS = ['success', 'unsupported version', 'not authorized', 'malformed request', 'unsupported opcode', 'unsupported option', 'malformed option', 'network failure', 'no resources', 'unsupported protocol', 'user over quota', 'cannot provide external', 'address mismatch', 'excessive remote peers'];

// an address in PCP's 16 byte form: ipv4 as ::ffff:a.b.c.d
export function pcpAddr(ip: string): Buffer {
  const b = Buffer.alloc(16);
  if (net.isIPv4(ip)) {
    b[10] = 0xff; b[11] = 0xff;
    ip.split('.').forEach((x, i) => { b[12 + i] = Number(x); });
    return b;
  }
  const full = expandV6(ip);
  for (let i = 0; i < 8; i++) b.writeUInt16BE(parseInt(full[i], 16), i * 2);
  return b;
}

function expandV6(ip: string): string[] {
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = tail !== undefined ? Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((x) => x || '0');
}

export function pcpAddrText(b: Buffer): string {
  if (b.subarray(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) return [...b.subarray(12, 16)].join('.');
  const parts: string[] = [];
  for (let i = 0; i < 8; i++) parts.push(b.readUInt16BE(i * 2).toString(16));
  return parts.join(':');
}

export function pcpMapRequest(clientIp: string, nonce: Buffer, internalPort: number, externalPort: number, lifetimeS: number): Buffer {
  const b = Buffer.alloc(60);
  b[0] = 2;                    // version
  b[1] = 1;                    // request, MAP
  b.writeUInt32BE(lifetimeS, 4);
  pcpAddr(clientIp).copy(b, 8);
  nonce.copy(b, 24);           // 12 bytes
  b[36] = 6;                   // tcp
  b.writeUInt16BE(internalPort, 40);
  b.writeUInt16BE(externalPort, 42);
  // suggested external address: all zero for ipv6, ::ffff:0.0.0.0 for ipv4 (no wish)
  pcpAddr(net.isIPv4(clientIp) ? '0.0.0.0' : '::').copy(b, 44);
  return b;
}

type PcpAnswer = { kind: 'pmp-only' } | { kind: 'map'; externalPort: number; externalIp: string; lifetimeS: number };

async function pcp(gw: string, clientIp: string | null, nonce: Buffer, o: Required<Pick<MapOptions, 'internalPort' | 'pmpPort' | 'tries' | 'lifetimeS' | 'timeoutMs'>>, externalPort: number, lifetimeS: number): Promise<PcpAnswer | null> {
  // the client address must be the one the router sees: our side of the socket towards it
  let local = clientIp;
  if (!local) local = await localTowards(gw, o.pmpPort);
  if (!local) return null;
  const req = pcpMapRequest(local, nonce, o.internalPort, externalPort, lifetimeS);
  const r = await udpAsk(gw, o.pmpPort, req, (b) => {
    if (b.length >= 4 && b[0] === 0) return true;              // a NAT-PMP router: version 0 answer
    if (b.length < 24 || b[0] !== 2 || b[1] !== 0x81) return false;
    // a success carries our nonce back; an error may come with the header only
    return b.length >= 60 ? b.subarray(24, 36).equals(nonce) : b[3] !== 0;
  }, o.tries, o.timeoutMs);
  if (!r) return null;
  if (r.answer[0] === 0) return { kind: 'pmp-only' };
  const code = r.answer[3];
  if (code === 1) return { kind: 'pmp-only' };
  if (code !== 0) throw new MapRefused(`pcp: ${PCP_RESULTS[code] ?? `result ${code}`}`);
  return { kind: 'map', lifetimeS: r.answer.readUInt32BE(4), externalPort: r.answer.readUInt16BE(42), externalIp: pcpAddrText(r.answer.subarray(44, 60)) };
}

function localTowards(host: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    let s: dgram.Socket;
    try { s = dgram.createSocket(net.isIPv6(host) ? 'udp6' : 'udp4'); } catch { return resolve(null); }
    const done = (v: string | null) => { try { s.close(); } catch {} resolve(v); };
    s.on('error', () => done(null));
    try { s.connect(port, host, () => { try { done(s.address().address); } catch { done(null); } }); } catch { done(null); }
  });
}

// ---- UPnP-IGD

const IGD_SERVICES = ['urn:schemas-upnp-org:service:WANIPConnection:2', 'urn:schemas-upnp-org:service:WANIPConnection:1', 'urn:schemas-upnp-org:service:WANPPPConnection:1'];

export interface IgdControl { url: string; service: string }

// the control url of the first WAN*Connection service in a device description
export function igdControl(xml: string, base: string): IgdControl | null {
  for (const block of xml.split(/<service>/i).slice(1)) {
    const type = /<serviceType>\s*([^<]+?)\s*<\/serviceType>/i.exec(block)?.[1];
    const ctl = /<controlURL>\s*([^<]+?)\s*<\/controlURL>/i.exec(block)?.[1];
    if (!type || !ctl || !IGD_SERVICES.includes(type)) continue;
    try { return { url: new URL(ctl, base).toString(), service: type }; } catch { return null; }
  }
  return null;
}

const xmlEsc = (s: string) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

function soapBody(service: string, action: string, args: [string, string | number][]): string {
  return `<?xml version="1.0"?>\r\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service}">${args.map(([k, v]) => `<${k}>${xmlEsc(String(v))}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`;
}

async function soap(ctl: IgdControl, action: string, args: [string, string | number][], timeoutMs: number): Promise<{ ok: boolean; text: string }> {
  const r = await fetch(ctl.url, {
    method: 'POST',
    headers: { 'content-type': 'text/xml; charset="utf-8"', soapaction: `"${ctl.service}#${action}"` },
    body: soapBody(ctl.service, action, args),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = (await r.text()).slice(0, 64 * 1024);
  return { ok: r.ok, text };
}

const tag = (xml: string, name: string) => new RegExp(`<(?:\\w+:)?${name}>\\s*([^<]*?)\\s*</(?:\\w+:)?${name}>`, 'i').exec(xml)?.[1] ?? null;

// The search: the first answer whose LOCATION is http on the answering address itself, and
// that address private (the router on this lan). Anything else is ignored, never fetched.
function ssdpSearch(target: { host: string; port: number }, timeoutMs: number): Promise<{ location: string; from: string } | null> {
  return new Promise((resolve) => {
    let s: dgram.Socket;
    try { s = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch { return resolve(null); }
    const done = (v: { location: string; from: string } | null) => { clearTimeout(t); try { s.close(); } catch {} resolve(v); };
    const t = setTimeout(() => done(null), timeoutMs);
    s.on('error', () => done(null));
    s.on('message', (b, from) => {
      const text = b.toString('utf8', 0, Math.min(b.length, 4096));
      const loc = /^location:\s*(\S+)/im.exec(text)?.[1];
      if (!loc) return;
      let u: URL;
      try { u = new URL(loc); } catch { return; }
      const h = u.hostname.replace(/^\[|\]$/g, '');
      if (u.protocol !== 'http:' || h !== from.address || !isPrivateAddress(h)) return;
      done({ location: u.toString(), from: from.address });
    });
    const msg = Buffer.from(['M-SEARCH * HTTP/1.1', `HOST: ${SSDP_ADDR}:${SSDP_PORT}`, 'MAN: "ssdp:discover"', 'MX: 2', 'ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1', '', ''].join('\r\n'));
    s.bind(0, () => {
      s.send(msg, target.port, target.host, () => {});
      setTimeout(() => { try { s.send(msg, target.port, target.host, () => {}); } catch {} }, 500).unref();
    });
  });
}

async function upnpFind(target: { host: string; port: number }, timeoutMs: number): Promise<{ ctl: IgdControl; gw: string } | null> {
  const found = await ssdpSearch(target, timeoutMs);
  if (!found) return null;
  try {
    const r = await fetch(found.location, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    const xml = (await r.text()).slice(0, 256 * 1024);
    const ctl = igdControl(xml, found.location);
    if (!ctl) return null;
    // the control url must stay on the router too
    if (new URL(ctl.url).hostname.replace(/^\[|\]$/g, '') !== found.from) return null;
    return { ctl, gw: found.from };
  } catch { return null; }
}

async function upnpMap(ctl: IgdControl, clientIp: string, internalPort: number, externalPort: number, lifetimeS: number, timeoutMs: number): Promise<{ lifetimeS: number }> {
  const args = (lease: number): [string, string | number][] => [
    ['NewRemoteHost', ''], ['NewExternalPort', externalPort], ['NewProtocol', 'TCP'], ['NewInternalPort', internalPort],
    ['NewInternalClient', clientIp], ['NewEnabled', 1], ['NewPortMappingDescription', 'kula gate'], ['NewLeaseDuration', lease],
  ];
  let r = await soap(ctl, 'AddPortMapping', args(lifetimeS), timeoutMs);
  // 725 OnlyPermanentLeasesSupported: an old router; the lease is then removed on stop
  if (!r.ok && tag(r.text, 'errorCode') === '725') { r = await soap(ctl, 'AddPortMapping', args(0), timeoutMs); lifetimeS = 0; }
  if (!r.ok) throw new MapRefused(`upnp: ${tag(r.text, 'errorDescription') ?? 'refused'}${tag(r.text, 'errorCode') ? ` (${tag(r.text, 'errorCode')})` : ''}`);
  return { lifetimeS };
}

async function upnpExternal(ctl: IgdControl, timeoutMs: number): Promise<string | null> {
  try {
    const r = await soap(ctl, 'GetExternalIPAddress', [], timeoutMs);
    const ip = r.ok ? tag(r.text, 'NewExternalIPAddress') : null;
    return ip && net.isIP(ip) ? ip : null;
  } catch { return null; }
}

// ---- the port mapper: map once, renew at half the lifetime, remove on stop

export interface PortMapper {
  mapping(): Mapping | null;
  stop(): Promise<void>;
}

export const isShared = (ip: string | null): boolean => ip !== null && isPrivateAddress(ip);

// One status line for the share log.
export function mapLine(m: Mapping | null, why?: string): string {
  if (!m) return `port map: none${why ? ` (${why})` : ''}; the gate is reached on this network only`;
  const ext = m.externalIp ? `${m.externalIp.includes(':') ? `[${m.externalIp}]` : m.externalIp}:${m.externalPort}` : `port ${m.externalPort} (external address not said)`;
  const renew = m.lifetimeS > 0 ? `renews every ${Math.max(1, Math.round(m.lifetimeS / 2 / 60))} min` : 'a lease without end, removed on stop';
  const nat = m.behindAnotherNat ? '; that address is itself behind another nat (carrier nat?): not reachable from the internet' : '';
  return `port map: router ${m.gateway} (${m.via}) maps ${ext} to this computer's ${m.internalPort}, ${renew}${nat}`;
}

export async function startPortMapper(o: MapOptions, log: (s: string) => void = () => {}): Promise<{ mapper: PortMapper | null; why: string | null }> {
  const gw = o.gateway ?? (await defaultGateway());
  const opts = { internalPort: o.internalPort, pmpPort: o.pmpPort ?? PMP_PORT, tries: o.tries ?? TRIES, lifetimeS: o.lifetimeS ?? LIFETIME_S, timeoutMs: o.timeoutMs ?? FIRST_WAIT_MS };
  const nonce = randomBytes(12);
  let refused: string | null = null;
  let via: MapVia | null = null;
  let current: Mapping | null = null;
  let ctl: IgdControl | null = null;
  let clientIp: string | null = o.clientIp ?? null;

  const make = (v: MapVia, g: string, externalPort: number, externalIp: string | null, lifetimeS: number): Mapping => ({
    via: v, gateway: g, internalPort: opts.internalPort, externalPort, externalIp, lifetimeS, behindAnotherNat: isShared(externalIp), at: Date.now(),
  });

  // one attempt with the way that worked (or each in turn the first time)
  const attempt = async (lifetimeS: number, want: number): Promise<Mapping | null> => {
    if (gw && (via === null || via === 'pcp' || via === 'natpmp')) {
      try {
        if (via !== 'natpmp') {
          const a = await pcp(gw, clientIp, nonce, opts, want, lifetimeS);
          if (a?.kind === 'map') { via = 'pcp'; return make('pcp', gw, a.externalPort, a.externalIp, a.lifetimeS); }
          if (via === 'pcp' && !a) return null;
        }
        const b = await natpmp(gw, opts, want, lifetimeS);
        if (b) { via = 'natpmp'; return make('natpmp', gw, b.externalPort, b.externalIp, b.lifetimeS); }
        if (via === 'natpmp') return null;
      } catch (e) {
        if (!(e instanceof MapRefused)) throw e;
        refused = e.message;
        if (via) return null;
      }
    }
    if (o.ssdp === null) return null;
    if (via !== null && via !== 'upnp') return null;
    if (!ctl) {
      const f = await upnpFind(o.ssdp ?? { host: SSDP_ADDR, port: SSDP_PORT }, Math.max(1000, opts.timeoutMs * 8));
      if (!f) return null;
      ctl = f.ctl;
      clientIp ??= await localTowards(f.gw, 9);
      if (!clientIp) return null;
    }
    try {
      const r = await upnpMap(ctl, clientIp!, opts.internalPort, want, lifetimeS, 3000);
      via = 'upnp';
      return make('upnp', new URL(ctl.url).hostname, want, await upnpExternal(ctl, 3000), r.lifetimeS);
    } catch (e) {
      if (e instanceof MapRefused) { refused = e.message; return null; }
      return null;
    }
  };

  const first = await attempt(opts.lifetimeS, opts.internalPort).catch(() => null);
  if (!first) {
    const why = refused ?? (gw ? `the router at ${gw} did not answer pcp, nat-pmp or upnp` : 'no default gateway found');
    return { mapper: null, why };
  }
  current = first;

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const schedule = () => {
    if (stopped || !current || current.lifetimeS <= 0) return;
    const ms = Math.max(o.minRenewMs ?? 5_000, (current.lifetimeS * 1000) / 2);
    timer = setTimeout(async () => {
      if (stopped || !current) return;
      // the same external port again: the address in the qrs already handed out stays right
      const next = await attempt(opts.lifetimeS, current.externalPort).catch(() => null);
      if (stopped) return;
      if (next) {
        const moved = next.externalPort !== current.externalPort || next.externalIp !== current.externalIp;
        current = next;
        if (moved) log(`${mapLine(current)} (it moved: the qr from before no longer points here)`);
      } else {
        log(`port map: renewal at ${gw ?? 'the router'} failed${refused ? ` (${refused})` : ''}; trying again`);
        current = { ...current, lifetimeS: Math.max(120, Math.round(current.lifetimeS / 2)) };   // again in a minute at the soonest
      }
      schedule();
    }, ms);
    timer.unref();
  };
  schedule();

  return {
    why: null,
    mapper: {
      mapping: () => current,
      async stop() {
        if (stopped) return;
        stopped = true;
        if (timer) clearTimeout(timer);
        const m = current;
        if (!m) return;
        try {
          if (m.via === 'pcp') await pcp(m.gateway, clientIp, nonce, { ...opts, tries: 2 }, 0, 0);
          else if (m.via === 'natpmp') await natpmp(m.gateway, { ...opts, tries: 2 }, 0, 0);
          else if (ctl) await soap(ctl, 'DeletePortMapping', [['NewRemoteHost', ''], ['NewExternalPort', m.externalPort], ['NewProtocol', 'TCP']], 3000);
        } catch {}
      },
    },
  };
}
