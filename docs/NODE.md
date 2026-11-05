# kula-node

`node/` is the command line program that makes a computer part of a kula
cluster: a worker (`kula-node share`) or the computer that runs the cluster
(`kula-node peers …`, `kula-node chat …`). The full reference is
[`node/README.md`](../node/README.md). This page covers installing it and the
local dashboard.

## install

kula-node ships as one file per platform: Node 24 and kula-node packed together,
so nothing else needs to be installed first. Each GitHub release of a `v*` tag
carries `kula-node-mac-arm64`, `kula-node-mac-x64`, `kula-node-linux-x64`,
`kula-node-linux-arm64`, `kula-node-win-x64.exe`, two `.deb`s, and
`sha256sums.txt`. The install scripts check the download against that file and
install nothing when it does not match.

**macOS and Linux** (into `~/.local/bin`, no sudo):

```sh
curl -fsSL https://github.com/kurtkurtkurt-del/kula-decentralized-ai/releases/latest/download/install.sh | sh
kula-node setup
kula-node share
```

The script says so when `~/.local/bin` is not on your `PATH` and prints the
line to add. `KULA_NODE_VERSION=0.1.0` picks a version, `KULA_NODE_BIN_DIR`
another folder.

**Windows** (PowerShell, into `%LOCALAPPDATA%\Programs\kula-node`, added to
your user `PATH`, no admin):

```powershell
irm https://github.com/kurtkurtkurt-del/kula-decentralized-ai/releases/latest/download/install.ps1 | iex
kula-node setup
kula-node share
```

Open a new terminal after the install so the new `PATH` is seen. The first
`kula-node share` makes Windows Defender Firewall ask about kula-node: allow
it on **private** networks (your home wi-fi) only. Without that the phone
cannot reach the gate.

**Debian / Ubuntu**, from the release's `.deb`:

```sh
v=0.1.0; a=$(dpkg --print-architecture)   # amd64 or arm64
curl -fsSLO https://github.com/kurtkurtkurt-del/kula-decentralized-ai/releases/download/v$v/kula-node_${v}_$a.deb
sudo apt install ./kula-node_${v}_$a.deb
```

**By hand**: download the file for your platform and `sha256sums.txt` from the
release, `shasum -a 256 -c --ignore-missing sha256sums.txt` (Linux:
`sha256sum -c --ignore-missing sha256sums.txt`), `chmod +x`, put it on your
`PATH`. The macOS binaries are signed ad hoc; downloaded with a browser they
carry the quarantine flag, so run `xattr -d com.apple.quarantine kula-node-mac-*`
once (curl and the install script do not set it).

A homebrew formula and winget manifests are drafted under `packaging/`; the
release job attaches filled-in copies (with the real sha256s) to each release.
Neither is published to a tap or to winget-pkgs yet. The repository has to be
public (or the release assets otherwise reachable) for the one-line installs
above to work.

Running bare, `kula-node` shows a short menu (setup, share, peers, help); on
Windows a double-clicked `kula-node.exe` lands there too and waits for enter
before closing. `kula-node setup` says up front which files it will fetch, how
big they are in total and which sha256 each must have, then draws a progress
bar. `--json` gives machine-readable output for `--version`, `setup --check`,
`setup --dry-run`, `setup`, `probe`, `peers list` and `peers probe`.

### making the binaries

```sh
cd node
npm ci
npm run pack:bin                                  # this machine's binary, then runs it (--version, --help)
node tools/pack.mjs --target linux-x64,win-x64    # other targets; mac ones only on a Mac (codesign)
node tools/release-files.mjs dist-bin             # .debs, formula, winget, sha256sums.txt next to them
```

`tools/pack.mjs` bundles `src/` with esbuild into one CommonJS file (the
dashboard's three static files baked in), turns it into a single executable
application blob with Node's `--experimental-sea-config`, and injects that with
postject into the official Node 24 binary of each target. Those come from
nodejs.org, checked against the release's `SHASUMS256.txt`, whose own sha256 is
pinned in `tools/packlib.mjs`. The macOS binaries are then signed ad hoc
(`codesign --sign -`). The dependencies (`bonjour-service`,
`qrcode-terminal`) are plain JavaScript; the pack fails if a native addon ever
gets into the bundle. Output goes to `node/dist-bin/` and downloads to
`node/.pack-cache/`, both git-ignored. A binary is about 95 MB (Windows) to
127 MB (Linux). `.github/workflows/node-pack.yml` does all of this on a `v*`
tag and uploads the files to that tag's release (a draft when there is none);
the tag must match `node/package.json`'s version.

## the dashboard

While `kula-node share` or `kula-node chat` runs, a single page is served on
this computer only:

```
http://127.0.0.1:50580/<random>/
```

The exact address, with its random part, is printed in the terminal when the
command starts (`dashboard on http://127.0.0.1:50580/…/ (this computer only)`).
`--dashboard <port>` moves it, `--no-dashboard` turns it off. It needs no
build step and no dependency: three static files under
`node/src/dashboard/static/` and an event stream.

### what is on it

In words, top to bottom (the page is a grid of cards, dark, lowercase, the
app's palette):

- **bu bilgisayar**: the passport of this computer (`~/.kula-node/passport.json`,
  or `~/.kula/passport.json` written by `passport/mac.sh`), next to what
  `share` measured itself: free and total memory, memory bandwidth, the gpu,
  the lan address, the device id.
- **kapı**: *bekliyor* while no master is connected, *master bağlı · kimden
  <ip>* while one is, the port, every open connection with its channel and
  age, the last refused hello and why. In `chat` mode it reads *yönetici*.
- **kanal trafiği**: per channel (`rpc`, `api`) the open connections, how many
  were opened, bytes in and out, refusals.
- **model**: the model the worker api holds, its context, the memory the file
  takes, tokens produced, a *meşgul* chip while a prompt runs. In `share` mode
  a picker lists the `.gguf` files in the models directory and *yükle* loads
  one into the local worker api, so the chat box below works without a phone.
- **eşler**: the peer book (`~/.kula-node/peers.json`) without its secrets:
  name, badges (kind, gpu, fast or wide memory), address, ram, bandwidth,
  reachability on both channels (green ok with the round trip, gold "kapalı
  kanal" when the gate answered but the program behind it is not running, red
  with the reason), when it was last probed. *yokla* probes again.
- **eşleşme**: the pairing qr, the same one the terminal prints, drawn on the
  server and sent as an svg.
- **defter**: the last lines of the signed ledger, one per line with time,
  kind and peer; *zinciri doğrula* runs the same check as
  `kula-node ledger --verify` and shows the result inline.
- **sohbet testi**: a chat box in apart mode. In `chat` mode the prompt goes to
  the cluster's scheduler (or to the device picked in the corner); in `share`
  mode to this computer's own worker api. Tokens stream in; the line under the
  box gives device, tokens, tok/s and first token time.
- **toplu test**: the 8 prompts of `kula-node chat --batch`, one bar per device
  with its mean tok/s, growing as replies come in, and the per prompt log.
- **günlük**: the last 80 lines the command printed.

### how it stays private

- The server binds to `127.0.0.1` only. Nothing on the lan can open it.
- Every route lives under a random 24 hex character prefix made at start.
  `/` redirects to it so the printed address is enough; anything else is 404.
- A request whose `Host` header is not `127.0.0.1:<port>`, `localhost:<port>`
  or `[::1]:<port>` is refused (dns rebinding).
- Every POST (chat, batch, probe, verify, load) must carry an `Origin` header
  equal to the page's own origin and, when the browser sends it,
  `Sec-Fetch-Site: same-origin`; a page on any other origin, even another
  local port, gets 403 before its body is read.
- The cluster secret never leaves the process as text. The page's state
  (`state.json`, the event stream) is built from views that drop it; the peer
  book is shown through the same view; the qr is encoded on the server by
  `node/src/dashboard/qr.ts` (a port of `passport/qr.js`) and the browser only
  receives an svg of modules. Tests search every body for the secret.
- `Content-Security-Policy: default-src 'none'; script-src 'self'; …`,
  `Cache-Control: no-store`, no framing.

### the passport file

The page `pc/` (the site) measures a Mac and draws its passport as a qr for the
phone. Its first step now also copies the passport to
`~/.kula-node/passport.json`; a fourth step downloads `passport.json` and
gives the one line that moves it there for other computers. `kula-node share`
reads that file (then `~/.kula/passport.json`) and shows it on the
dashboard's first card.

### files

`node/src/dashboard/server.ts` (the http server and routes),
`state.ts` (the snapshot, the patches, the peer view without secrets),
`wire.ts` (what `share` and `chat` hand over: this computer, the peer book,
the ledger, the probe and verify actions), `qr.ts` (the encoder),
`static/index.html`, `static/app.css`, `static/app.js` (the page).
Tests: `node/test/dashboard.test.ts`.
