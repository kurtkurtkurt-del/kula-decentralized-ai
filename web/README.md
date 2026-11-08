# web

The few static files kula still serves from a browser. No build step.

| path | what |
|---|---|
| `site/` | kula's one-page download site: four buttons (Mac, Windows, iOS later, Android) on the latest GitHub release's stable asset names (`kula-mac-arm64.dmg`, `kula-mac-x64.dmg`, `kula-windows-x64.exe`, `kula-android.apk`), a real screenshot of the chat page, the links; `index.html` + `site.css`, fonts and images beside them |
| `config.js` | the live Supabase project's public address and anon key, read by `tools/passport-mac.py` and `backend/tools/health.mjs` / `backup.mjs` |
| `pc/index.html` | a computer's passport for the phone in three steps: run one Terminal command, paste the json, show it as a qr code (Turkish; nothing leaves the page) |
| `passport/mac.sh` | the Mac's passport script (`curl … /passport/mac.sh \| bash`); **generated** by `python3 tools/passport-mac.py` from `mac.template.sh`, `mac-bench.c`, `qr.js` and `config.js`; the gate runs `--check` |
| `passport/qr.js` | the qr encoder `pc/` draws with (kula-node's `node/src/qr.ts` is a port of it) |
| `legacy/` | kept for reference, not served and not linked: see below |

Serve it locally with `python3 -m http.server 4340 -d web` (or the `web` entry in
`.claude/launch.json`); `pc/` builds its Terminal command from the page's own origin, so `web/` has
to be the root of whatever serves it.

## legacy

Files whose use was not certain when the afterhours website was removed from the root
(5.11.2026). They no longer render as they did: the site's stylesheet, scripts and fonts they
link to were deleted with it.

| path | what | why it is kept |
|---|---|---|
| `legacy/agb/`, `legacy/datenschutz/`, `legacy/impressum/`, `legacy/privacy/` | afterhours' terms, privacy notice and imprint (they still say afterhours) | a starting point for kula's own legal pages; the app links to copies on another repository's Pages (`SITE` in `app/src/data/projects.ts`) |
| `legacy/passport-page/` | the 21.10.2026 browser passport page ("your devices together"), built on the afterhours site shell | `pc/` replaced it; it is the only page that sends a browser's own measurement under a connect id |

The whole afterhours site is in git history: the last commit that had it at the root is
`9d5919f` (`git show 9d5919f:index.html`, `git checkout 9d5919f -- <path>`). Its story is in
[docs/HISTORY.md](../docs/HISTORY.md).
