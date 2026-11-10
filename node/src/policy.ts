// What a /load request may ask for. The master is paired, but a paired phone that was
// taken over, or a bug in it, must not turn this computer into a proxy into the lan or
// fill its disk: only http(s) to a public address (or the master's own lan address, see
// urlProblem), a sha256 that is one, and a size the body must keep to. The Kotlin twin is
// Guard.kt (UrlPolicy, ModelName).
import net from 'node:net';

export const SHA256_RE = /^[0-9a-f]{64}$/;
export const MAX_REDIRECTS = 5;
// a download may not grow past the size the master gave by more than this
export const SIZE_SLACK = 0.02;
// what is left on the disk after a download, at least
export const KEEP_FREE_BYTES = 512 * 1024 * 1024;

// Loopback, link-local, private and multicast ranges: a model never lives there.
export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (v === 6) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    if (l.startsWith('::ffff:')) {
      const rest = l.slice(7);
      if (rest.includes('.')) return isPrivateAddress(rest);
      // the hex form, "::ffff:a00:1"
      const [hi, lo] = rest.split(':').map((h) => parseInt(h || '0', 16));
      return isPrivateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb') || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('ff');
  }
  return false;
}

// An address as one form: "::ffff:10.0.0.5" and "10.0.0.5" are the same peer, ipv6 lowercase.
export function plainIp(ip: string): string {
  const l = ip.replace(/^\[|\]$/g, '').toLowerCase();
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
  return m ? m[1] : l;
}

export function isLoopback(ip: string): boolean {
  const p = plainIp(ip);
  return p === '::1' || (net.isIPv4(p) && p.startsWith('127.'));
}

// The host of a url as an ip literal, or null when it is a name (or no url).
export function urlIp(url: string): string | null {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return net.isIP(host) ? plainIp(host) : null;
  } catch { return null; }
}

// null when the url may be fetched, else why not. Hostnames are not resolved here: a name
// that resolves to a private address is caught by the connect-time check in download.ts.
// `allowPrivate` is for tests, which serve files from 127.0.0.1. `masterIp` is the one
// exception: the address of the master that sent this /load (the gate saw it), so a master
// on the same wi-fi can hand out the model from its own lan address. Only that ip literal,
// never a name, never loopback (a relayed connection reaches the gate from 127.0.0.1).
// the same words as the phone's Guard.kt (UrlPolicy.NOT_PUBLIC)
export const NOT_PUBLIC = "url must be public or the master's own address";

export function urlProblem(url: string, allowPrivate = false, masterIp: string | null = null): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return 'bad url'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'url must be http(s)';
  if (u.username || u.password) return 'url must not carry credentials';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) return 'bad url';
  if (allowPrivate) return null;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return 'url points at a local host';
  if (net.isIP(host) && isPrivateAddress(host)) {
    if (masterIp && !isLoopback(masterIp) && plainIp(host) === plainIp(masterIp)) return null;
    return NOT_PUBLIC;
  }
  return null;
}

// 0 means unknown (the free-space checks still apply while the body streams)
export function sizeProblem(size: unknown): string | null {
  const n = Number(size);
  if (!Number.isFinite(n) || n < 0 || n !== Math.floor(n)) return 'need size (bytes)';
  return null;
}

// true when `got` bytes are more than `size` allows
export function overSize(got: number, size: number): boolean {
  return size > 0 && got > size * (1 + SIZE_SLACK) + 1024;
}
