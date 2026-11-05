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
| `--tls` | protocol v2: the gate speaks TLS 1.3 between device certificates and the QR is v3 (`fp` + one-time `pin`, good for 10 minutes); v1 is off unless `--secret` is also given; see below |
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
`channel closed`, `busy`, `target down`, `no hello`, `no proof`, `overloaded`
(more than 32 connections in a handshake at once), `no v1` (`--tls` without
`--secret`: the gate speaks only TLS), and from the auditor `replay` and `clock`.
The limits a worker holds a paired phone to are in `docs/SECURITY.md`. The server
gives a client 5 s per line during the handshake and no timeout afterwards.
HMACs are compared in constant time. Bytes a client sends right after its
proof line are kept and forwarded.

## Protocol v2: TLS between device certificates

`share --tls` keeps v1 on the port and adds v2 (the server tells them apart by
the first byte: a TLS ClientHello starts with `0x16`). The computer's identity
is a P-256 key (`~/.kula-node/device_key.pem` when that key is P-256, else a
separate `gate_key.pem`) and a self-signed certificate `gate_cert.der` written
by `src/tls.ts` by hand in DER, the same bytes the Kotlin side writes. The QR
is then v3: `fp` (SHA-256 of the certificate) and `pin` (a one-time pairing
code) instead of `secret`. The phone pins `fp`; the first connection that
proves `pin` pins the phone's certificate in `~/.kula-node/paired` (two-way
TOFU) and spends the code, after which only the certificates speak:

```
tls 1.3, both sides with certificates, the client checks fp_s, no hostname check
C → S   KULA2 <channel> <nonce_c> <unix_ms>
S → C   <nonce_s> paired | <nonce_s> pin | NO <reason>
C → S   <proof_c>        pin: HMAC-SHA256(pin, "nonce_c|nonce_s|channel|fp_s|fp_c"); paired: "-"
S → C   OK <proof_s>     pin: HMAC-SHA256(pin, "nonce_s|nonce_c|channel|fp_s|fp_c"); paired: "OK -"
```

More reasons: `no tls` (a TLS client at a v1-only gate), `tls`, `no client
cert`, `not paired`, `wrong pin`, `bad proof`; `replay` and `clock` are always
checked in v2. `kula-node probe <host> <port> - --fp <hex> [--pin <code>]`
probes over TLS. The whole thing is in `docs/GATE.md` at the repository root;
`test/gate-vectors.json` carries the v2 proofs and the TBS certificate hash
both sides must reproduce.

## Development

```
npm test        # node --test, localhost only, never fetches llama.cpp

Tests: `gate.test.ts` (protocol and vectors), `gate-tls.test.ts` (v2: certificate,
pairing, every refusal, v1 on the same port), `audit.test.ts` (vectors, chain,
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
`src/share.ts` (the worker), `src/sysinfo.ts` (lan ip, memory, bandwidth, gpu),
`src/children.ts` (child processes on free ports), `src/download.ts`
(resumable downloads), `src/cli.ts`.

Set `KULA_NODE_VERBOSE=1` to see the child programs' own output, and
`KULA_NODE_HOME` to move `~/.kula-node` elsewhere.
