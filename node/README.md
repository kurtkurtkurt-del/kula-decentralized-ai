# kula-node

Makes a computer a worker in a kula cluster. The phone that runs the cluster
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
| Linux | downloads the `ubuntu-x64` / `ubuntu-arm64` release archive and unpacks it |
| Windows | downloads the `win-cpu-x64` / `win-cpu-arm64` release zip and unpacks it (needs `tar`, present on Windows 10 and later) |

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
- every gate event (open, close with byte counts and duration, refusal with
  reason) is appended to `~/.kula-node/ledger.jsonl`.
- Ctrl-C stops the gate, the mDNS record and both child programs.

Firewall: allow incoming TCP on the gate port (macOS asks once; on Linux open
it in ufw/firewalld; on Windows accept the Defender prompt or add a rule).

## Checking a worker

From any machine on the network:

```
kula-node probe <host> <port> <secret>
```

does the handshake on both channels and prints `OK` or the gate's `NO <reason>`.

To call the api channel by hand, open a tunnel from a Node script
(`new Tunnel(host, port, secret, 'api').listen()` from `src/gate.ts`) and curl
`http://127.0.0.1:<local port>/status`.

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
`channel closed`, `busy`, `target down`, `no hello`, `no proof`. The server
gives a client 5 s per line during the handshake and no timeout afterwards.
HMACs are compared in constant time. Bytes a client sends right after its
proof line are kept and forwarded.

## Development

```
npm test        # node --test, localhost only, never fetches llama.cpp
npm run dev -- share --no-qr
```

Files: `src/gate.ts` (protocol, server, client, Tunnel, probe), `src/llama.ts`
(find / build / download llama.cpp), `src/api.ts` (the apart-mode HTTP API),
`src/share.ts` (the worker), `src/sysinfo.ts` (lan ip, memory, bandwidth, gpu),
`src/children.ts` (child processes on free ports), `src/download.ts`
(resumable downloads), `src/cli.ts`.

Set `KULA_NODE_VERBOSE=1` to see the child programs' own output, and
`KULA_NODE_HOME` to move `~/.kula-node` elsewhere.
