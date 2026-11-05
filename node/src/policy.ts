// What a /load request may ask for. The master is paired, but a paired phone that was
// taken over, or a bug in it, must not turn this computer into a proxy into the lan or
// fill its disk: only http(s) to a public address, a sha256 that is one, and a size the
// body must keep to. The Kotlin twin is Guard.kt (UrlPolicy, ModelName).
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

// null when the url may be fetched, else why not. Hostnames are not resolved here: a name
// that resolves to a private address is caught by the connect-time check in download.ts.
// `allowPrivate` is for tests, which serve files from 127.0.0.1.
export function urlProblem(url: string, allowPrivate = false): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return 'bad url'; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'url must be http(s)';
  if (u.username || u.password) return 'url must not carry credentials';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) return 'bad url';
  if (allowPrivate) return null;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return 'url points at a local host';
  if (net.isIP(host) && isPrivateAddress(host)) return 'url points at a private address';
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
