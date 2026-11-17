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

// An address this computer must never dial for someone else's say-so (a signed address record,
// addressbook.ts): loopback, 0.0.0.0/8, ::, link-local (169.254/16, fe80::/10) and multicast
// and above (224.0.0.0 up, ff00::/8), in plain and ipv4-mapped forms. A lan address is not one.
export function undialable(ip: string): boolean {
  const p = plainIp(ip);
  const v = net.isIP(p);
  if (v === 4) {
    const [a, b] = p.split('.').map(Number);
    return a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224;
  }
  if (v !== 6) return true;
  const g = ipv6Groups(p);
  if (!g) return true;
  // ipv4-mapped in any spelling ("::ffff:7f00:1")
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return undialable(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  // :: and ::1
  if (g.slice(0, 7).every((x) => x === 0) && g[7] <= 1) return true;
  return (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00;
}

// an ipv6 literal as its eight 16-bit groups (an embedded ipv4 tail as two); null when it is not one
function ipv6Groups(ip: string): number[] | null {
  let s = ip.split('%')[0];
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number);
    s = `${s.slice(0, tail.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const part = (h: string) => (h ? h.split(':').map((x) => parseInt(x, 16)) : []);
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const g = [...head, ...new Array(halves.length === 2 ? fill : 0).fill(0), ...rest];
  return g.length === 8 && g.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? g : null;
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
