// Which server this build talks to, and whether that can work. A release build that points
// at nothing, at the Mac's local server (a private address, localhost) or over plain http
// cannot be live for anyone who downloads it: say so on screen (NoServer in _layout.tsx)
// instead of an app that looks offline forever. tools/release-env.mjs refuses such a
// build before it is made; this is the second fence.
export type BackendProblem = 'missing' | 'devServer' | 'insecure';

const PRIVATE = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|\[?::1\]?|.*\.local$|.*\.localhost$)/i;

export function backendProblem(url: string | undefined, key: string | undefined, dev: boolean): BackendProblem | null {
  if (!url || !key) return 'missing';
  let host: string;
  let protocol: string;
  try {
    const u = new URL(url);
    host = u.hostname;
    protocol = u.protocol;
  } catch {
    return 'missing';
  }
  if (dev) return null; // Expo Go and expo start may use the local server
  if (PRIVATE.test(host)) return 'devServer';
  if (protocol !== 'https:') return 'insecure';
  return null;
}
