# kula-node: a computer in the cluster

`node/` makes a Mac, Linux or Windows computer a worker behind the same gate a shared phone
opens, or the device that runs a cluster from the command line. The longer, file-by-file
account is [`node/README.md`](../node/README.md); this page is the command reference and
the setup, with what is and is not possible beyond the local network at the end.

What a computer brings: more memory and a faster chip than any phone, so in **apart** mode
it takes most of the prompts, and in **split** mode it holds most of a model's layers.
Everything it exposes goes through one port, the gate (50551), and ggml's RPC server and
`llama-server` listen on 127.0.0.1 only ([GATE.md](GATE.md)).

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
bar. `kula-node info` prints what a cluster would see of this computer (address, ram,
memory bandwidth, gpu, llama.cpp). `--json` gives machine-readable output for `--version`, `info`, `setup --check`,
`setup --dry-run`, `setup`, `probe`, `peers list` and `peers probe`.

### from source

From the source tree instead (Node.js 20 or newer):

```bash
cd node
npm install
npm run build
node dist/bin/kula-node.js setup
```

`npm link` (or `npm i -g .`) inside `node/` makes it `kula-node`. `npm run dev -- <command>`
runs it from source with tsx.

`setup` gets llama.cpp at the pinned release **b11157** (every device in a cluster must
speak the same RPC protocol):

| platform | what happens |
|---|---|
| macOS | builds from the source tarball with cmake (`brew install cmake ninja`); the tarball's sha256 is checked first; a few minutes |
| Linux | downloads the `ubuntu-x64` / `ubuntu-arm64` release archive; with an NVIDIA gpu (`nvidia-smi` answers) the `ubuntu-cuda-12.8` build plus its `cudart` archive |
| Windows | downloads the `win-cpu-x64` / `win-cpu-arm64` zip (needs `tar`, present since Windows 10); with an NVIDIA gpu the `win-cuda-12.4` zip plus its `cudart` zip |

Everything lands in `~/.kula-node/llama-b11157/`. A build already at `<repo>/.llama/host/`
(the Mac development build from `node app/modules/kula-llama/tools/llama-src.mjs --host`) is
reused as is. `KULA_LLAMA_DIR=/path/to/bin` points at your own build; `KULA_NVIDIA=0|1`
overrides gpu detection; `KULA_NODE_HOME` moves `~/.kula-node`.

```bash
kula-node setup --check       # report what is found, fetch nothing
kula-node setup --dry-run     # say which archive would be fetched (offline with KULA_RELEASE_JSON=<file>)
```

Firewall: allow incoming TCP on the gate port. macOS asks once; Linux: open it in ufw or
firewalld; Windows: accept the Defender prompt or add a rule.

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
`qrcode-terminal`, `ws`) are plain JavaScript; the pack fails if a native addon ever
gets into the bundle. Output goes to `node/dist-bin/` and downloads to
`node/.pack-cache/`, both git-ignored. A binary is about 95 MB (Windows) to
127 MB (Linux). `.github/workflows/node-pack.yml` does all of this on a `v*`
tag and uploads the files to that tag's release (a draft when there is none);
the tag must match `node/package.json`'s version.

## commands

### as a worker

```bash
kula-node share [--port 50551] [--name <s>] [--models <dir>] [--secret <hex>] [--tls] [--lie-ram <MB>] [--no-qr]
```

Prints a QR and the same payload as JSON, then waits. Scan the QR with the phone (peers →
scan a code) or paste the JSON. On the same wi-fi the phone also finds the computer by
mDNS (`_kula._tcp`), but it still needs the QR or code: the mDNS record carries no secret
and no fingerprint.

| flag | meaning |
|---|---|
| `--port` | gate port (default 50551) |
| `--name` | the name the phone shows (default: hostname) |
| `--models` | where models asked for by a master are kept (default `~/.kula-node/models`) |
| `--secret` | reuse a v1 secret instead of a fresh one per run (visible in `ps`; a known gap) |
| `--tls` | protocol v2: TLS between device certificates, a v3 QR with a one-time code ([GATE.md](GATE.md)) |
| `--lie-ram` | advertise a false amount of free memory, to make the auditor's claim check fire |
| `--no-qr` | JSON only |

While it runs: `ggml-rpc-server` starts on the first `rpc` connection (one master at a
time, a second gets `NO busy`); the `api` channel starts a small HTTP server on first use,
`POST /load` downloads the model (resumable, then sha256-checked) and starts `llama-server`
with it (`-ngl 99`, `-c <ctx>`), `POST /chat` streams the answer; every gate event goes
through the auditor into `~/.kula-node/ledger.jsonl`. Ctrl-C stops the gate, the mDNS
record and both child programs at once. `KULA_NODE_VERBOSE=1` shows the children's output.

### checking a worker

```bash
kula-node probe <host> <port> <secret>                 # v1: handshake on both channels, OK <ms> or NO <reason>
kula-node probe <host> <port> - --fp <64 hex> [--pin <code>]   # v2
```

`channel closed` still means the worker is up; its program for that channel is not running.

### the ledger

```bash
kula-node ledger                # every line, rotated files first
kula-node ledger --tail 20      # the last 20 lines of the live file
kula-node ledger --verify       # walk the chain and check every signature with this computer's key; exit 1 on the first break
```

Format and rules: [AUDIT.md](AUDIT.md).

### running a cluster from the computer

The computer takes the phone's role: it keeps a peer book of workers (phones that "share
this phone", other computers running `share`) and talks to them through the same gate.

```bash
kula-node peers add '<qr json>'                 # what a worker shows (v2 or v3)
kula-node peers add <code>                      # the same as one base64url line (peers list --code prints it)
kula-node peers add 192.168.1.20:50551:<secret> # when nothing else is at hand
kula-node peers list [--code]
kula-node peers rm <id | id prefix | name>
kula-node peers probe [id…] [--timeout 2000]    # tcp + handshake on both channels, stamps last_ok
kula-node peers scan [--timeout 3000]           # listen for _kula._tcp on the lan
```

Peers live in `~/.kula-node/peers.json` (mode 600); `list` shows the first four hex of a
secret and never more. The same `id` replaces the old entry, so a worker whose address
changed is just added again.

```bash
kula-node chat --model <file.gguf> --mode apart|split [--peer id,id…] [--batch [file]] [--prompt "…"]
                [--ctx 4096] [--max-tokens 256] [--no-local] [--model-url <url>] [--keep-local] [--probe-ms 2000] [--device <name>] [--verbose]
```

Before anything loads, every wanted peer is probed on the channel the mode needs; one that
does not answer is dropped with its reason and the run goes on. In split mode this is what
keeps llama.cpp alive: `ggml_backend_rpc_add_server` aborts the process on an address that
does not answer.

**apart**: every device runs the whole model. The computer starts its own `llama-server`
(unless `--no-local`); each peer gets `POST /load` through a tunnel to its `api` channel;
prompts go to the fastest free device, by advertised bandwidth at first and measured tok/s
once known, one prompt per device at a time. Workers fetch the model **from this computer**:
`chat` serves the gguf on a lan port under a random path (`/m/<24 hex>/<name>`, Range
supported) for the run, or from `--model-url`. `--batch` spreads eight built-in prompts
(or one per line of a file) over all devices and prints, per device, prompts taken,
tokens and tok/s. Without `--batch` or `--prompt` it is an interactive chat: an empty line
quits, `/reset` clears the history.

**split**: the planner is a copy of the phone's (`src/planner.ts` = `app/src/llm/cluster.ts`):
need = file × 1.1; the computer may use 70 % of its free RAM, a worker 75 % of what it
advertised; when the model does not fit here alone, the fastest devices by memory bandwidth
are filled first; when it fits alone it is still shared unless `--keep-local`; `toobig`
when even together it does not fit. The output layer stays on the computer. Then one tunnel
per used peer to its `rpc` channel and

```
llama-server --host 127.0.0.1 -m <gguf> --rpc 127.0.0.1:p1,127.0.0.1:p2 --tensor-split <local>,<p1>,<p2>
```

Without llama.cpp on the computer, `split` says "run kula-node setup" and stops; `apart`
drops the local device with the same hint and carries on with the peers.

### measuring

```bash
kula-node bench --model <file.gguf> [--peer id,id…] [--no-apart] [--no-split] [--json]
```

Local prompt and generation tok/s, memory bandwidth, the gate round trip and tunnel speed
to each peer (tls and far peers too), each peer's tok/s in apart mode and a split run; one
record in `~/.kula-node/bench/`. `chat` then plans with the measured tok/s instead of
bandwidth × efficiency, and with the model's shape from its gguf header. Fields and how to
read them: [BENCH.md](BENCH.md).

## files

| path | what |
|---|---|
| `~/.kula-node/llama-b11157/` | the binaries |
| `~/.kula-node/models/` | models loaded on request |
| `~/.kula-node/peers.json` | the peer book (600) |
| `~/.kula-node/device_key.pem` | the Ed25519 (or P-256) device key |
| `~/.kula-node/gate_key.pem`, `gate_cert.der`, `paired` | the TLS identity and the pinned masters (v2) |
| `~/.kula-node/ledger.jsonl` | the signed ledger |
| `~/.kula-node/chats/` | the chat page's conversations (600; guests' under `guests/<session>/`) |
| `~/.kula-node/ui-token` | the chat page's `/v1` bearer token (600) |

## a typical first run (phone as master)

1. On the computer: `kula-node setup`, then `kula-node share`.
2. On the phone: connected devices → scan a code, point it at the terminal. The computer
   appears with its name, RAM and bandwidth.
3. Models tab → a model → start → **apart**. The phone loads its copy; the computer
   downloads the same file into `~/.kula-node/models` the first time, then loads it.
4. Chat → **batch test**: eight prompts spread over both; the line under the answers says
   who took how many.
5. Pull the wi-fi on the computer: the phone marks it unreachable, finishes on its own, and
   can chat again within half a minute. Plug it back in and press **check** on the peers screen.

Computer as master: `kula-node peers add '<the phone's QR json>'`, `kula-node peers probe`,
`kula-node chat --model ~/models/qwen2.5-1.5b-q4.gguf --mode apart --batch`.

## beyond the local network

Today kula is a **local** cluster. The gate is an ordinary TCP port, so it works wherever
that port is reachable; what does not cross a network boundary is discovery (mDNS) and the
assumption, in split mode, of a few milliseconds per hop.

- **Same wi-fi:** everything on this page.
- **A friend's computer in another city:** through a kula relay (`share --relay wss://…`, the
  master adds it by its six digit code; [RELAY.md](RELAY.md)), apart mode only. Or a private
  network of your own, such as Tailscale, ZeroTier or a WireGuard tunnel:
  both devices join it, the worker runs `share` as usual, and the master adds it by its
  address on that network (`kula-node peers add <ip>:50551:<secret>`, or paste the QR JSON
  with the `host` changed; on the phone the QR's `host` must be the private-network address).
  Use **apart** mode: prompts and answers are small, a round trip of 30 ms does not matter.
  Do not use **split** mode over a distance: every token crosses the link several times and
  the model runs at the speed of the slowest hop. With v1 the `api` channel is plain text,
  so a private network is also what keeps the prompts private; v2 (`--tls`) encrypts them.
- **The kula relay** (`node/relay/`, since 5.11.2026) forwards gate connections between two
  NATed devices without seeing inside them: the worker runs `kula-node share --relay wss://…`
  (which forces `--tls`), the master adds it by a six-digit code and the pin
  (`kula-node peers add "123456 <pin>" --relay …`). Apart mode only; split mode leaves far
  peers out. Where a public relay is hosted is not decided yet. The protocol, limits and
  deployment are in [RELAY.md](RELAY.md).

## tests

```bash
cd node && npm test      # node --test, localhost only, never fetches llama.cpp
```

`gate.test.ts`, `gate-tls.test.ts`, `api.test.ts`, `conformance.test.ts` (the SSE shapes
byte for byte against `ApiServer.kt`), `audit.test.ts`, `setup.test.ts` (`pickAsset` over a
recorded release), `planner.test.ts`, `peers.test.ts`,
`apart.test.ts` (two fake workers behind real gates), `split.test.ts` (plan, tunnels, the
`--rpc`/`--tensor-split` arguments against a fake llama-server), `ui.test.ts` (the chat page:
loopback, prefix, origin, no secret in a body, conversations, a fake phone behind a tls gate
paired by hand and chatting end to end, stop, `/v1` shapes, the markdown escaping, the catalog
copy), `ui-invite.test.ts` (invite mode: cookie, wrong token, guest limits, rotation).

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

## the chat page

A chat page in the style of claude.ai on this computer, for a model that runs on your phone:
the phone does the work, the computer only carries the words.

1. **Phone:** kula → **share this phone**. It shows a qr code, its address
   (`192.168.1.20:50551`) and a one-time code under it.
2. **Computer:** `kula-node ui` (from the repo: `cd node && npm run dev -- ui`). The page opens
   at `http://127.0.0.1:50590/<random>/`; `--port` moves it, `--no-open` keeps the browser shut.
3. **connect → add a device.** Either *type it* (the address and the 16-character code; the
   first 16 of the certificate too, to be sure), or *paste a code* (the qr text, a base64url
   code, `host:port:secret`, or a six digit relay code with its relay), or *scan the qr* with
   this computer's camera (Chromium, where `BarcodeDetector` exists). One tls handshake with the
   code pairs the two for good (the code's proof covers both certificates).
4. **Pick a model and a mode, load.** *on the phone* (the main use): the phone is told the
   model's public Hugging Face url and sha256 from the catalog (`node/src/ui/catalog.ts`, a
   copy of `app/src/llm/catalog.ts`) and downloads it itself, so the worker's private-url rule
   never bites; a phone that already has the file starts at once. *apart*: every chosen device
   its own copy, a prompt to the fastest free one; this computer joins when it has the file.
   *split*: the model here, its layers spread over phones by `--rpc` (lan only). *here*: only
   this computer's llama-server. split and here need `kula-node setup`; a catalog model they
   need is downloaded to `~/.kula-node/models` first (sha256-checked). A `.gguf` that only
   lives on this computer (`~/.kula-node/models`, the repo's `.llama/models`) can only run in
   split or here: phones fetch from the public internet only, and the page says so.
5. **Chat.** Streaming answers with markdown (escaped: model text never becomes html), a
   collapsible "thinking" block for qwen3's `<think>`, tok/s, first-token time and the device
   under each answer, stop, answer again, edit and resend the last message. **the brain** (the
   icon top right) shows the devices, why the model sits where it sits, and the last decisions.
   Settings: temperature, max tokens, context (next load), a system prompt, light/dark.

Conversations are JSON files in `~/.kula-node/chats/` (600, in a 700 folder); the title is the
first message until renamed. The catalog copy is regenerated with `npx tsx tools/ui-catalog.ts`
(in `node/`); `test/ui.test.ts` fails while it is behind the app's.

### the openai-compatible endpoint

The same server answers `GET /v1/models` and `POST /v1/chat/completions` (`stream: true` gives
`chat.completion.chunk` lines and `data: [DONE]`) with whatever is loaded, so an editor can use
the phone. It wants `Authorization: Bearer <token>`: printed at start, shown under settings,
kept in `~/.kula-node/ui-token` (600; `--new-token` makes a new one). The model name is free:
`kula` is always listed. 127.0.0.1 only, also in invite mode. For Continue
(`~/.continue/config.yaml`):

```yaml
models:
  - name: kula (phone)
    provider: openai
    model: kula
    apiBase: http://127.0.0.1:50590/v1
    apiKey: kula-…            # the token kula-node ui printed
    roles: [chat, edit, apply]
```

AnythingLLM: LLM provider "Generic OpenAI", base url `http://127.0.0.1:50590/v1`, the token
as api key, model `kula`. `curl` check:

```bash
curl -N http://127.0.0.1:50590/v1/chat/completions -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"model":"kula","stream":true,"messages":[{"role":"user","content":"hi"}]}'
```

### invite mode: other devices on the wi-fi

`kula-node ui --lan`, or **invite a device** (the qr icon) → *let devices on this wi-fi join*.
The page then also listens on this computer's lan address (same port) and shows a big qr,
printed in the terminal too: `http://<lan ip>:50590/<random>/join?k=<32 random bytes>`. Any
phone, tablet or laptop on that network scans it and is in the chat, nothing installed.

- `/join` swaps the token for a session cookie (HttpOnly, SameSite=Strict, the page's path);
  every request that does not come in on 127.0.0.1 needs it. An invite lasts 8 hours; **new
  invite** makes a new token and ends every guest's session at once. Off ends them too, and
  closes the lan listener.
- Guests chat with whatever is loaded, see the model and the devices, and keep their own chats
  (`~/.kula-node/chats/guests/<session>/`). They cannot add, remove or check devices, load or
  unload, see settings or the `/v1` token, or read the owner's or another guest's chats. The
  owner is whoever uses 127.0.0.1.
- Limits: `/join` 20 tries and 6 wrong tokens per address per 10 minutes; a guest gets one
  answer at a time and 12 prompts a minute; at most 64 guests.
- **It is plain http on the local network:** anyone on the same wi-fi who listens in can read
  what is typed and answered (and could take a guest's cookie). Use it on a network you trust,
  switch it off when the guests are gone.

### security notes

- Bound to 127.0.0.1 (plus the lan address only in invite mode); a foreign `Host` header is
  refused (dns rebinding), every page route is under a random prefix, a POST needs the page's
  own `Origin`. The page has a strict content security policy and loads nothing from anywhere.
- Peer secrets and pairing codes never reach the page: devices go out without them.
- The `/v1` token is the one secret the owner's page is given (to show it in settings).
- llama.cpp's rpc stays behind the gate as everywhere else; the chat page adds no port to it.
