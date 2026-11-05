# kula-node

Makes a computer a worker in a kula cluster, or the computer that runs one
(see "Running a cluster from this computer"). The phone that runs the cluster
scans a QR (or finds the computer over mDNS), and from then on the computer
lends its memory and compute the same way the other phones do:

- **split** mode: the computer runs `ggml-rpc-server` and holds some of a
  model's layers (ggml rpc protocol v7).
- **apart** mode: the computer runs its own `llama-server` behind the same
  tiny HTTP API a phone offers (`/status`, `/load`, `/chat`, `/stop`).

Nothing on the network is exposed directly. The computer opens **one** port,
the gate (default 50551). Every connection first proves it knows the cluster
secret (an HMAC handshake, see below) and is then piped to a program listening
on 127.0.0.1 only.

## Setup

You need Node.js 20 or newer.

```
cd node
npm install
npm run build
node dist/bin/kula-node.js setup
```

`setup` fetches llama.cpp at the pinned release `b11157` (every device in a
cluster must run the same rpc protocol, so the version is fixed):

| platform | what `setup` does |
| --- | --- |
| macOS | builds from the source tarball with cmake (`brew install cmake ninja`); the sha256 of the tarball is checked first. Takes a few minutes. |
| Linux | downloads the `ubuntu-x64` / `ubuntu-arm64` release archive and unpacks it; with an NVIDIA gpu (`nvidia-smi` answers) the `ubuntu-cuda-12.8` build plus its `cudart` runtime archive |
| Windows | downloads the `win-cpu-x64` / `win-cpu-arm64` release zip and unpacks it (needs `tar`, present on Windows 10 and later); with an NVIDIA gpu the `win-cuda-12.4` zip plus its `cudart` zip |

The choice is one pure function, `pickAsset` in `src/assets.ts`, tested against
`test/fixtures/release-b11157.json`, a recorded copy of the release's asset
list. When the release carries a `.sha256` sidecar for the archive it is
checked and a mismatch deletes the archive. `KULA_NVIDIA=0` or `=1` overrides
the gpu detection.

`kula-node setup --dry-run` only prints which archive (and runtime) would be
fetched, with its size and where it would land. `KULA_RELEASE_JSON=<file>`
makes it read a saved asset list instead of asking GitHub, so the dry run
works offline:

```
KULA_RELEASE_JSON=test/fixtures/release-b11157.json kula-node setup --dry-run
```

Everything lands in `~/.kula-node/llama-b11157/`. If the archive for your
machine has no rpc server inside, or there is no archive at all, `setup`
prints the few commands to build it yourself; afterwards point kula-node at
the result with `KULA_LLAMA_DIR=/path/to/build/bin`. A build already present
at `<repo>/.llama/host/` (the Mac development build) is reused as is.

`kula-node setup --check` only reports what is found, without fetching.

To run it as `kula-node` rather than `node dist/bin/kula-node.js`:
`npm link` (or `npm i -g .`) inside `node/`.

## Sharing

```
kula-node share
```

Prints a QR and the same thing as JSON, then waits:

```json
{"k":"kula-peer","v":2,"id":"…","name":"my-laptop","host":"192.168.1.20","port":50551,
 "secret":"…hex…","kind":"pc","ram":12000,"bw":45.0,"gpu":"Apple M1","vram":0}
```

Scan the QR with the phone that runs the cluster. On the same network the
phone can also find the computer by mDNS (`_kula._tcp`, TXT: id, name, ram,
bw, kind=pc, v=rpc7), but it still needs the secret, which only the QR carries.

Options:

| flag | meaning |
| --- | --- |
| `--port <n>` | gate port (default 50551) |
| `--name <s>` | the name the phone shows (default: hostname) |
| `--models <dir>` | where downloaded models are kept (default `~/.kula-node/models`) |
| `--secret <hex>` | reuse a secret instead of a fresh one per run |
| `--lie-ram <MB>` | advertise a false amount of free memory (for audit tests on the phone side) |
| `--no-qr` | print the JSON only |

While it runs:

- `ggml-rpc-server` starts the first time a peer opens the `rpc` channel, on a
  free 127.0.0.1 port, with its local file cache on. The rpc channel admits one
  remote peer at a time; another address gets `NO busy`.
- the `api` channel starts a small HTTP server on first use; `POST /load`
  downloads the model (resumable, then sha256-checked) into `--models` and
  starts `llama-server` with it (`-ngl 99`, `-c <ctx>`); `POST /chat` streams
  the answer.
- every gate event goes through the auditor into the signed ledger at
  `~/.kula-node/ledger.jsonl` (see below).
- Ctrl-C stops the gate, the mDNS record and both child programs.

Firewall: allow incoming TCP on the gate port (macOS asks once; on Linux open
it in ufw/firewalld; on Windows accept the Defender prompt or add a rule).

## Running a cluster from this computer

The computer can also be the side that runs the cluster, the role the phone
has in `app/`. Workers are phones ("share this phone") or other computers
(`kula-node share`); this computer keeps their QR payloads in a peer book and
talks to them through the same gate.

### The peer book

```
kula-node peers add '{"k":"kula-peer","v":2,"id":"…","name":"pixel","host":"192.168.1.33","port":50551,"secret":"…"}'
kula-node peers add <code>                 # the same peer as one base64url line (peers list --code prints it)
kula-node peers add 192.168.1.20:50551:<secret hex>
kula-node peers list [--code]
kula-node peers rm <id | id prefix | name>
kula-node peers probe [id…] [--timeout 2000]
kula-node peers scan [--timeout 3000]
```

Peers live in `~/.kula-node/peers.json`, written with mode 600 and never with a
secret on the terminal (`list` shows the first four hex chars). `add` accepts the
QR json a worker shows (`v` must be 2), the base64url code of that json, or
`host:port:secret` when nothing else is at hand. The same `id` replaces the old
entry, so a worker whose address changed is just added again.

`probe` opens one TCP connection per channel and does the handshake (2 s each);
it prints `OK <ms>` or the gate's `NO <reason>` for `rpc` and `api` and stamps
`last_ok`. `channel closed` still means the worker is up (its program for that
channel is not running). `scan` listens for `_kula._tcp` on the lan
(bonjour-service) and lists what announces itself; the mDNS record carries no
secret, so a new worker still needs its QR or code.

### Chat

```
kula-node chat --model ~/models/qwen2.5-1.5b-q4.gguf --mode apart [--peer id,id…] [--batch] [--prompt "…"]
kula-node chat --model ~/models/qwen2.5-7b-q4.gguf  --mode split [--peer id,id…]
```

Before anything is loaded every wanted peer (default: all saved ones) is
probed on the channel the mode needs, 2 s by default (`--probe-ms`). A peer
that does not answer is dropped with its reason and the run goes on without
it; in split mode this is what keeps llama.cpp alive, because
`ggml_backend_rpc_add_server` aborts the whole process on an address that does
not answer.

**apart**: every device runs the whole model. This computer starts its own
`llama-server` on 127.0.0.1 (unless `--no-local`) and each peer gets `POST
/load` through a local tunnel to its `api` channel, then prompts go to the
fastest free device: by advertised bandwidth at first, by measured tok/s once
known, one prompt per device at a time. Workers fetch the model from this
computer: `chat` serves the gguf on a lan port under a random path
(`/m/<24 hex>/<name>`, Range supported) for the run, or from `--model-url` if
you pass one. `--batch` sends eight built-in prompts (or one per line of a
file) over all devices at once and prints, per device, how many prompts it
took, the tokens and its tok/s; `--verbose` adds the answers. Without
`--batch` or `--prompt` it is an interactive chat (empty line quits, `/reset`
clears the history); `--device <name>` pins one device.

**split**: the planner from the phone (`src/planner.ts`, a copy of
`app/src/llm/cluster.ts`): need = file × 1.1; this computer may use 70 % of
its free RAM, a worker 75 % of what it advertised; when the model does not fit
here alone the fastest devices (memory bandwidth) are filled first and the
rest stay out; when it fits here alone it is still shared by bandwidth unless
`--keep-local`; `toobig` when even together it does not fit. The output layer
stays on this computer: the local share is the first entry of the tensor split
and llama.cpp keeps the last layers on the main device. Then one local tunnel
per used peer to its `rpc` channel and

```
llama-server --host 127.0.0.1 … -m <gguf> --rpc 127.0.0.1:p1,127.0.0.1:p2 --tensor-split <local>,<p1>,<p2>
```

and the same chat client as apart mode on top of it. A worker's rpc server is
never reached directly: the tunnels are the only path, and they end at 127.0.0.1.

Without llama.cpp on this computer `split` says so and stops; `apart` drops the
local device with the same hint and carries on with the peers (`--no-local`
skips the attempt). `--bw <GB/s>` skips the bandwidth measurement.

## Checking a worker

From any machine on the network:

```
kula-node probe <host> <port> <secret>
```

does the handshake on both channels and prints `OK` or the gate's `NO <reason>`.

To call the api channel by hand, open a tunnel from a Node script
(`new Tunnel(host, port, secret, 'api').listen()` from `src/gate.ts`) and curl
`http://127.0.0.1:<local port>/status`.

## The ledger and the auditor

`share` keeps the same auditor the phone keeps ("beyin/check"), so both sides
of a cluster can be held to the same record. Files in `src/audit/`:

- `key.ts`: one key pair per computer, Ed25519 (P-256 when the platform's
  OpenSSL has none), stored as PKCS8 PEM at `~/.kula-node/device_key.pem`.
  The device id is the first 16 bytes of SHA-256 over the public key in SPKI
  DER form, as 32 hex chars.
- `ledger.ts`: one JSON object per line, keys in this order and no spaces:
  `{"t":<unix ms>,"kind":"pair|connect|reject|load|claim|health|end","peer":"…",…,"prev":"…","sig":"…"}`.
  `prev` is the SHA-256 hex of the previous line (without its newline; 64
  zeros for the first line), `sig` the base64 signature over the line
  serialised without the `sig` key. At 5 MB the file is renamed to
  `ledger.<unix ms>.jsonl` and the next line still names the old file's last
  line, so the chain stays one piece.
- `checks.ts`: replay (a ring of the last 1000 nonces per peer), clock skew
  over 120 s, claim against measured (warn over 2×, reject over 4×), model
  sha256 mismatch, byte-per-second bounds, health warnings (throttled, over
  42 °C, under 15 % battery). Reasons: `replay`, `clock`, `claim`, `model`,
  `bounds`.
- `auditor.ts`: runs the checks and writes the lines.

What `share` writes: `connect` and `end` (with ms and byte counts) for every
gate connection, `reject` with the gate's reason, `load` for every model the
api channel was asked for (asked-for and measured sha256), `claim` once at
start (the advertised ram against the measured one, which is what `--lie-ram`
is for) and `health` once a minute.

A client may send its clock as a fourth hello field, `KULA1 <channel>
<nonce_c> <unix_ms>`; the auditor then refuses `NO replay` for a nonce seen
before and `NO clock` for a skew over 120 s, before the server nonce goes out.

```
kula-node ledger               # print every line, rotated files first
kula-node ledger --tail 20     # the last 20 lines of the live file
kula-node ledger --verify      # walk the chain and check every signature with this device's key
```

`--verify` exits 1 and names the line and what is wrong (`prev`, `sig`,
`json`, `kind`) when the chain is broken. `test/audit-vectors.json` holds two
lines made from a documented Ed25519 seed; any twin of the ledger must
reproduce them byte for byte.

## The gate handshake

Text lines ending in `\n`, then a raw pipe. Must match the Kotlin gate in
`app/modules/kula-llama` byte for byte; `test/gate-vectors.json` (copied to
`app/modules/kula-llama/tools/`) holds three fixed vectors both sides check.

```
C → S   KULA1 <channel> <nonce_c>        channel: rpc | api; nonce: 16 random bytes as 32 lowercase hex
S → C   <nonce_s>                        same format
C → S   <hmac_c>                         HMAC-SHA256(secret utf8, "nonce_c|nonce_s|channel") lowercase hex
S → C   OK <hmac_s>                      HMAC-SHA256(secret utf8, "nonce_s|nonce_c|channel")
   or   NO <reason>                      then close
```

Reasons: `bad hello`, `bad channel`, `bad nonce`, `wrong secret`,
`channel closed`, `busy`, `target down`, `no hello`, `no proof`, and from the
auditor `replay` and `clock`. The server
gives a client 5 s per line during the handshake and no timeout afterwards.
HMACs are compared in constant time. Bytes a client sends right after its
proof line are kept and forwarded.

## Development

```
npm test        # node --test, localhost only, never fetches llama.cpp

Tests: `gate.test.ts` (protocol and vectors), `planner.test.ts` (the split
planner over numbers, the probe dropping dead peers), `peers.test.ts` (QR /
code / short form parsing, peers.json mode 600, probes against a real gate
including `wrong secret` and a silent port, a tunnel with the wrong secret
closed without a byte, mDNS scan over a fake browser), `apart.test.ts` (two
fake workers behind real gates, the model served from here, 8 prompts spread,
tok/s per device, the model server's Range and random path), `split.test.ts`
(plan + tunnels, the `--rpc`/`--tensor-split` arguments, a fake llama-server
process, the no-binary error), `audit.test.ts` (vectors, chain,
tampering, rotation, checks, the gate's clock field, `kula-node ledger`),
`setup.test.ts` (`pickAsset` over the recorded release, sidecar, build
instructions), `api.test.ts` and `conformance.test.ts` (the apart-mode api
against a fake llama-server, SSE text byte for byte, `/stop`, `NO busy`).
npm run dev -- share --no-qr
```

Files: `src/gate.ts` (protocol, server, client, Tunnel, probe), `src/llama.ts`
(find / build / download llama.cpp), `src/assets.ts` (which release archive),
`src/audit/` (key, ledger, checks, auditor), `src/ledgercmd.ts`,
`src/api.ts` (the apart-mode HTTP API),
`src/share.ts` (the worker), `src/peers.ts` (the peer book, mDNS scan,
probes), `src/planner.ts` (the split planner), `src/apart.ts` (apart-mode
scheduler and api client), `src/split.ts` (rpc tunnels and llama-server over
them), `src/modelserve.ts` (the gguf served to workers), `src/mastercmd.ts`
(`peers`, `chat`), `src/sysinfo.ts` (lan ip, memory, bandwidth, gpu),
`src/children.ts` (child processes on free ports), `src/download.ts`
(resumable downloads), `src/cli.ts`.

Set `KULA_NODE_VERBOSE=1` to see the child programs' own output, and
`KULA_NODE_HOME` to move `~/.kula-node` elsewhere.
