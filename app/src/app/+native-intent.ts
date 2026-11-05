// Incoming links. pasaport://project/<slug> and pasaport://coops/join?c=… already are routes.
// The web addresses kula shares are rewritten to them: a project's page
// (…/explore/project/index.html?slug=…, lib/share.ts) and a coop invitation (…/g/?c=CODE,
// data/coops.ts inviteUrl). Anything else passes through.
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const m = /explore\/project\/(?:index\.html)?\?(?:.*&)?slug=([^&#]+)/.exec(path);
    if (m) return `/project/${decodeURIComponent(m[1])}`;
    const g = /(?:^|\/)g\/(?:index\.html)?\?(?:.*&)?c=([A-Za-z0-9]+)/.exec(path);
    if (g) return `/coops/join?c=${g[1].toUpperCase()}`;
  } catch {}
  return path;
}
