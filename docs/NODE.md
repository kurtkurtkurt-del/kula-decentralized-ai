# kula-node: install and first run

`kula-node` makes a computer a worker in a kula phone cluster, or the computer
that runs one. It ships as **one file per platform**, no Node.js needed. What
the program does and how the gate works is in [`node/README.md`](../node/README.md);
this page is only about getting it onto a machine.

Every download below is checked: the installers refuse to install a binary
whose sha256 is not the one in the release's `SHA256SUMS`, and `kula-node setup`
checks llama.cpp the same way.

## Install

### macOS

```bash
curl -fsSL https://raw.githubusercontent.com/kurtkurtkurt-del/kula-decentralized-ai/main/install.sh | sh
```

Puts `~/.local/bin/kula-node` in place (Apple silicon or Intel is picked
automatically). If `~/.local/bin` is not on your PATH the script prints the
line to add to `~/.zshrc`. With Homebrew, the formula draft works from the
checkout:

```bash
brew install --formula ./packaging/homebrew/kula-node.rb
```

### Linux

```bash
curl -fsSL https://raw.githubusercontent.com/kurtkurtkurt-del/kula-decentralized-ai/main/install.sh | sh
```

x64 and arm64. On Debian and Ubuntu there is a `.deb` on the release page too:

```bash
v=0.1.0
curl -fsSLO https://github.com/kurtkurtkurt-del/kula-decentralized-ai/releases/download/v$v/kula-node_${v}_amd64.deb
sudo apt install ./kula-node_${v}_amd64.deb
```

### Windows

In PowerShell (no administrator rights needed):

```powershell
irm https://raw.githubusercontent.com/kurtkurtkurt-del/kula-decentralized-ai/main/install.ps1 | iex
```

Puts `%LOCALAPPDATA%\kula-node\kula-node.exe` in place and adds that folder to
your user PATH. Open a new terminal afterwards. A `winget` manifest draft is in
`packaging/winget/`; until it is in the winget repository, the script above is
the way.

**Firewall.** The first `kula-node share` makes Windows ask whether kula-node
may accept connections. Tick *private networks* and allow, or phones will never
reach the gate port (50551). Pressed cancel? In an administrator PowerShell:

```powershell
New-NetFirewallRule -DisplayName kula-node -Direction Inbound -Protocol TCP -LocalPort 50551 -Profile Private -Action Allow
```

### Installer knobs

| variable | meaning |
| --- | --- |
| `KULA_VERSION=0.2.0` | a specific release instead of the latest |
| `KULA_BIN_DIR=/usr/local/bin` | where the binary goes (`~/.local/bin`; on Windows `%LOCALAPPDATA%\kula-node`) |
| `KULA_BASE_URL=...` | where to fetch from, instead of the GitHub release (a mirror, or the fake server in the tests) |

### Checking by hand

```bash
curl -fsSLO https://github.com/kurtkurtkurt-del/kula-decentralized-ai/releases/download/v0.1.0/SHA256SUMS
sha256sum -c SHA256SUMS --ignore-missing
```

## First run

```
kula-node
```

With no arguments on a terminal you get a menu:

```
kula-node 0.1.0 (packed) on this-computer

  1  setup     get llama.cpp b11157 (one download, checked by sha256)
  2  share     lend this computer to a phone cluster (shows a qr)
  3  peers     no saved workers yet: scan the lan for phones and computers
  4  measure   this computer: ram, memory bandwidth, gpu, address
  h  help      every command and flag
  q  quit
```

`setup` says how much it will download before it starts (`total download: 17 MB`
on Linux and Windows; macOS builds from source, see the README) and shows a
progress bar. In a pipe or with `--json` there is no bar, just the result.

Every command answers in JSON with `--json`, for scripts and for the phone app:

```bash
kula-node version --json
kula-node info --json --no-bandwidth
kula-node setup --check --json
kula-node setup --dry-run --json
kula-node probe 192.168.1.20 50551 <secret> --json
kula-node peers list --json      # secrets are masked
kula-node peers probe --json
```

## Running from source instead

Node.js 20 or newer:

```bash
cd node
npm ci
npm run dev -- --version      # tsx, no build
npm run build && node dist/bin/kula-node.js --help
```

## How the single file is made

`node/tools/pack.mjs` bundles the TypeScript and both dependencies (pure
JavaScript: `bonjour-service` for mDNS, `qrcode-terminal`; nothing native)
with esbuild, turns the bundle into a Node 22 single-executable blob, and
injects it into a copy of the Node binary for each target. The host's own
Node is used for the host target; other targets' binaries come from
nodejs.org and are checked against `SHASUMS256.txt` first. macOS binaries
are ad-hoc signed after injection, which needs a Mac, so the release
workflow (`.github/workflows/node-pack.yml`) builds those on a macOS runner
and the rest on Ubuntu.

```bash
cd node
npm run pack                                   # this machine's target, dist/pack/
node tools/pack.mjs --target linux-x64,win-x64 # any set; --all for the five
node tools/deb.mjs --bin dist/pack/kula-node-0.1.0-linux-x64
node tools/manifests.mjs --sums dist/pack/SHA256SUMS   # brew / winget / nfpm with real hashes
```

Targets: `mac-arm64 mac-x64 linux-x64 linux-arm64 win-x64`. Each binary is the
size of Node itself (about 120 MB); the kula part is a quarter of a megabyte.

A release is a tag `v<version>` where `<version>` equals `node/package.json`'s
(the workflow refuses otherwise). It runs the tests, packs the five binaries,
writes `SHA256SUMS`, builds the two `.deb` files, renders the manifests and
attaches everything to the GitHub release, together with `install.sh` and
`install.ps1`.
