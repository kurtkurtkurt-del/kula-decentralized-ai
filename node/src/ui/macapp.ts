// `kula-node ui --install-mac [--login]` / `--uninstall-mac`: the chat page as one click on a mac.
//
// ~/Applications/kula.app is a minimal bundle whose executable is a shell launcher: the page
// already answers → open it; else start `kula-node ui --no-open` in the background (through
// the LaunchAgent when there is one), wait until it answers (≤15 s), open it, exit. With
// --login a LaunchAgent (app.kula.ui) keeps the page up from login on, low priority, restarted
// only after a crash. Every path is absolute and baked in at install time: an app started from
// Finder or the Dock does not get the shell's PATH. Nothing here binds anything: the page stays
// on 127.0.0.1 (server.ts), the launcher only talks to 127.0.0.1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const APP_ID = 'app.kula.ui';
export const APP_NAME = 'kula.app';

export interface MacPaths {
  app: string;          // ~/Applications/kula.app
  agent: string;        // ~/Library/LaunchAgents/app.kula.ui.plist
  log: string;          // ~/.kula-node/ui.log
}

export function macPaths(userHome: string, kulaHome: string): MacPaths {
  return {
    app: path.join(userHome, 'Applications', APP_NAME),
    agent: path.join(userHome, 'Library', 'LaunchAgents', `${APP_ID}.plist`),
    log: path.join(kulaHome, 'ui.log'),
  };
}

export type Run = (cmd: string, args: string[]) => { code: number; out: string };
export const realRun: Run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status ?? (r.error ? 127 : 1), out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

export interface InstallOptions {
  userHome: string;       // os.homedir()
  kulaHome: string;       // home(): ~/.kula-node (KULA_NODE_HOME)
  start: string[];        // how to start kula-node: [node, …/dist/bin/kula-node.js] or [the packed binary]
  port: number;
  icon?: string | null;   // a png (app/assets/icon.png) made into Contents/Resources/kula.icns
  version?: string;
  login?: boolean;        // also the LaunchAgent
  uid?: number;
  run?: Run;              // sips, iconutil, launchctl, lsregister (tests pass a fake)
}

export interface InstallResult { app: string; launcher: string; icon: string | null; agent: string | null; loaded: boolean; notes: string[] }

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// one shell word, single quoted
export const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const plistDoc = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}</dict>
</plist>
`;
const kv = (k: string, v: string) => `  <key>${xml(k)}</key>\n  <string>${xml(v)}</string>\n`;
const kb = (k: string, v: boolean) => `  <key>${xml(k)}</key>\n  <${v}/>\n`;

export function infoPlist(version = '0.1.0', withIcon = true): string {
  return plistDoc(
    kv('CFBundleName', 'kula') + kv('CFBundleDisplayName', 'kula') + kv('CFBundleIdentifier', APP_ID) +
    kv('CFBundleExecutable', 'kula') + kv('CFBundlePackageType', 'APPL') + kv('CFBundleInfoDictionaryVersion', '6.0') +
    kv('CFBundleShortVersionString', version) + kv('CFBundleVersion', version) +
    (withIcon ? kv('CFBundleIconFile', 'kula') : '') +
    kv('LSMinimumSystemVersion', '11.0') + kb('LSUIElement', true) + kb('NSHighResolutionCapable', true),
  );
}

// PATH for the started page: where node lives first (llama.cpp and adb are found by kula-node
// itself), then the system's.
function pathFor(start: string[]): string {
  const dirs = [path.dirname(start[0]), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return [...new Set(dirs)].join(':');
}

export function agentPlist(o: { start: string[]; port: number; kulaHome: string; log: string }): string {
  const args = [...o.start, 'ui', '--no-open', '--port', String(o.port)];
  return plistDoc(
    kv('Label', APP_ID) +
    `  <key>ProgramArguments</key>\n  <array>\n${args.map((a) => `    <string>${xml(a)}</string>\n`).join('')}  </array>\n` +
    `  <key>EnvironmentVariables</key>\n  <dict>\n    <key>KULA_NODE_HOME</key>\n    <string>${xml(o.kulaHome)}</string>\n    <key>PATH</key>\n    <string>${xml(pathFor(o.start))}</string>\n  </dict>\n` +
    kv('WorkingDirectory', o.kulaHome) +
    kb('RunAtLoad', true) +
    // restarted after a crash only: a clean exit (ctrl-c, --stop, another page already up) stays down
    `  <key>KeepAlive</key>\n  <dict>\n    <key>SuccessfulExit</key>\n    <false/>\n  </dict>\n` +
    `  <key>ThrottleInterval</key>\n  <integer>30</integer>\n` +
    `  <key>Nice</key>\n  <integer>5</integer>\n` +
    kv('ProcessType', 'Background') +
    kv('StandardOutPath', o.log) + kv('StandardErrorPath', o.log),
  );
}

// The app's executable. KULA_UI_NO_BROWSER=1 prints the address instead of opening it.
export function launcherScript(o: { start: string[]; port: number; kulaHome: string; log: string; agent: string }): string {
  const cmd = [...o.start, 'ui', '--no-open', '--port', String(o.port)].map(sq).join(' ');
  return `#!/bin/bash
# kula.app: open kula's chat page, starting it in the background first when it is not up.
# Made by \`kula-node ui --install-mac\`; run that again to change it. Log: ${o.log}
umask 077
PORT=${o.port}
KULA_HOME=${sq(o.kulaHome)}
LOG=${sq(o.log)}
AGENT=${sq(o.agent)}
export KULA_NODE_HOME="$KULA_HOME"
export PATH=${sq(pathFor(o.start))}

# the page answers on 127.0.0.1: / redirects to the page, <page>health says {"kula":"ui"}
find_url() {
  local loc
  loc=$(/usr/bin/curl -s --noproxy '*' -m 2 -o /dev/null -w '%{redirect_url}' "http://127.0.0.1:$PORT/") || return 1
  [[ "$loc" =~ ^http://127\\.0\\.0\\.1:$PORT/[0-9a-f]+/$ ]] || return 1
  /usr/bin/curl -s --noproxy '*' -m 2 "\${loc}health" | /usr/bin/grep -q '"kula":"ui"' || return 1
  printf '%s\\n' "$loc"
}
show() {
  if [ -n "$KULA_UI_NO_BROWSER" ]; then printf '%s\\n' "$1"; else /usr/bin/open "$1"; fi
}
note() { printf '%s  kula.app: %s\\n' "$(/bin/date '+%Y-%m-%d %H:%M:%S')" "$1" >>"$LOG"; }

if url=$(find_url); then show "$url"; exit 0; fi

/bin/mkdir -p "$KULA_HOME"
# keep the log small: one old copy
if [ -f "$LOG" ] && [ "$(/usr/bin/stat -f %z "$LOG")" -gt 5242880 ]; then /bin/mv -f "$LOG" "$LOG.1"; fi
started=
if [ -f "$AGENT" ] && /bin/launchctl kickstart "gui/$(/usr/bin/id -u)/${APP_ID}" >/dev/null 2>&1; then
  note 'asked the login item to start the chat page'
  started=1
fi
if [ -z "$started" ]; then
  note 'starting the chat page'
  nohup /usr/bin/nice -n 5 ${cmd} </dev/null >>"$LOG" 2>&1 &
  disown 2>/dev/null
fi

for _ in $(/usr/bin/seq 1 30); do
  /bin/sleep 0.5
  if url=$(find_url); then show "$url"; exit 0; fi
done
note 'the chat page did not answer within 15 s'
echo "kula: the chat page did not start; see $LOG" >&2
if [ -z "$KULA_UI_NO_BROWSER" ]; then
  /usr/bin/osascript -e 'display alert "kula" message "The chat page did not start. Details are in ~/.kula-node/ui.log."' >/dev/null 2>&1
fi
exit 1
`;
}

// app/assets/icon.png → Contents/Resources/kula.icns with sips and iconutil; false when either is missing or fails
export function makeIcns(png: string, out: string, run: Run): boolean {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kula-icon-'));
  const set = path.join(tmp, 'kula.iconset');
  try {
    fs.mkdirSync(set);
    for (const s of [16, 32, 128, 256, 512]) {
      for (const [scale, suffix] of [[1, ''], [2, '@2x']] as const) {
        const px = String(s * scale);
        const r = run('/usr/bin/sips', ['-z', px, px, png, '--out', path.join(set, `icon_${s}x${s}${suffix}.png`)]);
        if (r.code !== 0) return false;
      }
    }
    return run('/usr/bin/iconutil', ['-c', 'icns', set, '-o', out]).code === 0 && fs.existsSync(out);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
// Launch Services is per user, not per HOME: an install into a temp HOME (tests, checks) leaves it alone
const realHome = (h: string) => { try { return path.resolve(h) === path.resolve(os.userInfo().homedir); } catch { return false; } };

export function installMac(o: InstallOptions): InstallResult {
  const run = o.run ?? realRun;
  const uid = o.uid ?? process.getuid?.() ?? 0;
  const p = macPaths(o.userHome, o.kulaHome);
  const notes: string[] = [];
  fs.mkdirSync(o.kulaHome, { recursive: true });

  // the bundle, built next to the old one and swapped in
  const tmpApp = `${p.app}.new`;
  fs.rmSync(tmpApp, { recursive: true, force: true });
  const macos = path.join(tmpApp, 'Contents', 'MacOS');
  const res = path.join(tmpApp, 'Contents', 'Resources');
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(res, { recursive: true });
  let icon: string | null = null;
  if (o.icon && fs.existsSync(o.icon)) {
    if (makeIcns(o.icon, path.join(res, 'kula.icns'), run)) icon = path.join(p.app, 'Contents', 'Resources', 'kula.icns');
    else notes.push('no icon: sips or iconutil did not work (the app works without it)');
  }
  fs.writeFileSync(path.join(tmpApp, 'Contents', 'Info.plist'), infoPlist(o.version, !!icon));
  fs.writeFileSync(path.join(tmpApp, 'Contents', 'PkgInfo'), 'APPL????');
  const launcher = path.join(macos, 'kula');
  fs.writeFileSync(launcher, launcherScript({ start: o.start, port: o.port, kulaHome: o.kulaHome, log: p.log, agent: p.agent }), { mode: 0o755 });
  fs.chmodSync(launcher, 0o755);
  fs.rmSync(p.app, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(p.app), { recursive: true });
  fs.renameSync(tmpApp, p.app);
  // tell Finder and the Dock about it (and its icon) now rather than at some later scan
  if (realHome(o.userHome) && fs.existsSync(LSREGISTER)) run(LSREGISTER, ['-f', p.app]);

  let agent: string | null = null;
  let loaded = false;
  if (o.login) {
    fs.mkdirSync(path.dirname(p.agent), { recursive: true });
    fs.writeFileSync(p.agent, agentPlist({ start: o.start, port: o.port, kulaHome: o.kulaHome, log: p.log }), { mode: 0o644 });
    agent = p.agent;
    run('/bin/launchctl', ['bootout', `gui/${uid}/${APP_ID}`]); // an older one, if loaded
    const r = run('/bin/launchctl', ['bootstrap', `gui/${uid}`, p.agent]);
    loaded = r.code === 0;
    if (!loaded) notes.push(`launchctl bootstrap did not load it (${r.out.trim() || `exit ${r.code}`}); it loads at the next login`);
  } else if (fs.existsSync(p.agent)) {
    notes.push(`a login item from before is still there (${p.agent}); --uninstall-mac removes it`);
  }
  return { app: p.app, launcher: path.join(p.app, 'Contents', 'MacOS', 'kula'), icon, agent, loaded, notes };
}

export function uninstallMac(o: { userHome: string; kulaHome: string; uid?: number; run?: Run }): string[] {
  const run = o.run ?? realRun;
  const uid = o.uid ?? process.getuid?.() ?? 0;
  const p = macPaths(o.userHome, o.kulaHome);
  const gone: string[] = [];
  if (fs.existsSync(p.agent)) {
    run('/bin/launchctl', ['bootout', `gui/${uid}/${APP_ID}`]);
    fs.rmSync(p.agent, { force: true });
    gone.push(p.agent);
  }
  if (fs.existsSync(p.app)) {
    fs.rmSync(p.app, { recursive: true, force: true });
    if (realHome(o.userHome) && fs.existsSync(LSREGISTER)) run(LSREGISTER, ['-u', p.app]);
    gone.push(p.app);
  }
  return gone;
}
