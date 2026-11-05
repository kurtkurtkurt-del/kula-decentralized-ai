# the gate

The one port a kula device opens on the network, and the two protocols that live on it.
This page replaces the Turkish draft written with protocol v2 on the `claude/gate-tls`
branch; it describes v1 and v2 together, the tunnel, the refusal reasons, the files, the
test vectors and what is still untested on a real phone. The architecture around it is in
[ARCHITECTURE.md](ARCHITECTURE.md); what the auditor records about every connection is in
[AUDIT.md](AUDIT.md).

## why there is a gate

ggml's RPC server has no authentication and its protocol lets a client write into the
server's memory. It therefore **always listens on 127.0.0.1**, and so does the worker's
HTTP API. The gate (default port 50551) stands in front of both: after a handshake it pipes
the connection, unchanged, to the local port of the requested channel.

| channel | goes to | used by |
|---|---|---|
| `rpc` | `ggml-rpc-server` on 127.0.0.1 | split mode (one master at a time) |
| `api` | `ApiServer.kt` / `node/src/api.ts` / dev-gate's shim on 127.0.0.1 | apart mode, the night |

To reach a device behind another NAT the gate does not change: the relay pipes the two ends and v2 TLS runs end to end inside the pipe; see `docs/RELAY.md`.

A master never talks to the gate directly either: it opens a **tunnel**, a listener on its
own 127.0.0.1 that does the handshake once and then pipes bytes both ways. llama.cpp or the
HTTP client is given `127.0.0.1:<tunnel port>`.

Implementations, all checked against the same vectors:

| where | files | tests |
|---|---|---|
| phone | `app/modules/kula-llama/android/src/main/java/expo/modules/kulallama/Gate.kt`, `GateCert.kt` | `GateTest.kt`, `GateTlsTest.kt`, `AuditorGateTest.kt` (JVM, also under `audit-jvm/`) |
| computer | `node/src/gate.ts`, `node/src/tls.ts` | `node/test/gate.test.ts`, `gate-tls.test.ts` |
| Mac test gate | `app/modules/kula-llama/tools/dev-gate.mjs` | by hand, with the phone or kula-node |
| vectors | `app/modules/kula-llama/tools/gate-vectors.json` = `node/test/gate-vectors.json` | `vectors` (v1), `v2` (pin proofs), `cert` (TBSCertificate sha256) |

## two protocols on one port

The server reads the **first byte** of a connection. `K` (the start of `KULA1`) is a v1
hello in plain text; `0x16` is a TLS record, a ClientHello, so v2. Nothing else is accepted.
An old phone, a v2 QR or a dev-gate without `--tls` keep working unchanged; a new master
talks v1 to an old worker and v2 to a new one, decided by what the peer record carries
(`fp` present means TLS; `peerTls()` in `app/src/llm/cluster.ts`).

## protocol v1: shared secret, QR v2

Lines end in `\n`; after `OK` the socket is a raw pipe. The secret is 32 random bytes as
64 lowercase hex, made when sharing starts, and travels only in the QR.

```
C → S   KULA1 <channel> <nonce_c> [<unix_ms>]   channel: rpc | api; nonce: 16 random bytes as 32 lowercase hex
S → C   <nonce_s>                                same format
C → S   <hmac_c>                                 HMAC-SHA256(secret utf8, "nonce_c|nonce_s|channel") lowercase hex
S → C   OK <hmac_s>                              HMAC-SHA256(secret utf8, "nonce_s|nonce_c|channel")
   or   NO <reason>                              then the server closes
```

- The fourth hello field, the client's clock in unix milliseconds, is optional (v1.1). With
  an auditor the server then refuses a nonce it has seen from this peer (`replay`) and a
  clock more than 120 s from its own (`clock`), before its own nonce goes out. A three-field
  hello is still accepted everywhere (old apks, dev-gate, kula-node).
- The server allows 5 s per line during the handshake and sets no timeout afterwards. HMACs
  are compared in constant time. The hello and proof lines are read byte by byte with a
  256-byte cap, so an unauthenticated client cannot fill the heap. Bytes a client sends right
  after its proof line are kept and forwarded, not swallowed.
- Every leg is half-open aware: a client that sends `FIN` after its request still receives
  the late answer. This mattered for apart mode, whose HTTP answers end with the close.

QR v2:

```
{"k":"kula-peer","v":2,"id","name","host","port","secret","kind","ram","bw","passport"}
```

`kind` is `phone`, `tablet` or `pc`; `ram` is free MB and `bw` GB/s when the worker
advertised them; `passport` is the device passport when it has one, so the together page
knows the device. The same payload is also offered as one base64url line (a "code") for
pasting where there is no camera.

**What v1 does not give:** prompts and answers on the `api` channel travel in plain text on
the wi-fi; whoever reads the QR once has lasting access; the device has no identity of its
own. v2 is the answer to those three.

## protocol v2: TLS 1.3 between device certificates, QR v3

### identity

Every device has a lasting key pair (`audit/DeviceKey`: Ed25519, P-256 where the JVM has no
Ed25519; the device id is the first 16 bytes of SHA-256 over the public key, 32 hex). For
TLS the device needs a **P-256 key and a self-signed X.509 certificate**:

- A P-256 device key is used as is. An Ed25519 device key gets a separate P-256 *gate key*
  beside it, because Android's TLS stack (Conscrypt) does not speak Ed25519 certificates on
  every version while P-256 works everywhere. The certificate's CN is the device id either way.
- The certificate is written as DER by hand (`GateCert.kt`, `node/src/tls.ts`): v3, a 16-byte
  random serial, `ecdsa-with-SHA256`, issuer = subject = `CN=<device id>`, ten years
  (UTCTime), the SPKI, `basicConstraints CA:false`. There is no chain and nobody verifies
  one: the other side pins the **fingerprint**, `fp` = SHA-256 of the DER as 64 lowercase
  hex. BouncyCastle was not added: the JDK has no public certificate builder, and sixty lines
  of DER beat a 7 MB dependency. Both sides write the same bytes; the `cert` vector fixes the
  SHA-256 of the TBSCertificate (the signature is random, so the whole certificate cannot be
  a vector).
- Files: Android `files/gate/gate_key`, `files/gate/gate_cert.der`, `files/gate/paired` (the
  app and the `:worker` process share them); kula-node `~/.kula-node/gate_key.pem`,
  `gate_cert.der`, `paired`; dev-gate `.llama/dev-gate/` (made with `openssl`).

### QR v3

```
{"k":"kula-peer","v":3,"id","name","host","port","fp","pin","kind","ram","bw","passport"}
```

`fp` is the worker's certificate fingerprint; `pin` a one-time pairing code, 16 hex. There is
no `secret`. When a code is spent the worker makes a new one and refreshes its QR (the share
screen reads it from the worker's status file every two seconds; kula-node prints a new QR;
dev-gate prints new JSON). A v3 QR without `pin` is also readable: it is what a worker shows
again to a master that is already paired. `app/src/llm/peers.ts` reads v2 and v3 and writes
v3 whenever the worker has a fingerprint.

### the handshake inside TLS

TLS 1.3 first, **both sides presenting a certificate** (the server asks with
`wantClientAuth`, node with `requestCert`). The client verifies the server certificate by
fingerprint only (`PinnedTrust`); **hostname verification is off**, since peers are IP
addresses. The server accepts any client certificate at the TLS layer and decides in the
lines that follow:

```
C → S   KULA2 <channel> <nonce_c> <unix_ms>       four fields, all required
S → C   <nonce_s> paired  |  <nonce_s> pin  |  NO <reason>
C → S   <proof_c>        pin:    HMAC-SHA256(pin, "nonce_c|nonce_s|channel|fp_s|fp_c")
                         paired: "-"
S → C   OK <proof_s>     pin:    HMAC-SHA256(pin, "nonce_s|nonce_c|channel|fp_s|fp_c")
                         paired: "OK -"
   or   NO <reason>
```

- `fp_s` is the worker's fingerprint, `fp_c` the master's. Both are inside the HMAC, so a
  code cannot be replayed for another certificate.
- **First connection (pairing):** the server does not know the client's fingerprint and has
  an open code, so it answers `pin`. With a correct proof the client's fingerprint is written
  to `paired` (two-way trust on first use: the master pinned the worker from the QR, the
  worker pins the master from this connection), the code is spent, and a `pair` line goes to
  the ledger.
- **Later connections:** TLS only. The client sends `-`, the server answers `OK -`. There is
  no secret anywhere.
- A replayed nonce and a clock more than two minutes off are refused on every v2 hello,
  **with or without an auditor**.
- 5 s per handshake line, no timeout afterwards; proofs compared in constant time; bytes
  after the proof line are forwarded.
- A TLS socket cannot be half-closed: when one direction ends, the TLS side is closed fully
  with `close_notify` (the plain side gets `shutdownOutput`). Apart mode's HTTP answers, which
  end with the close, still arrive whole.

### living beside v1

- A server with a TLS identity always listens for both. First byte `0x16` is TLS, anything
  else goes to the v1 reader, and a v1 hello starts with `K` (0x4b), so there is no overlap.
- A phone worker always creates an identity; its QR while running is v3. A v2 QR an older
  master still holds keeps working against the same worker over v1, because the secret is
  still in the share record.
- A new master reads both: v3 gives `fp` + `pin` and v2; v2 gives `secret` and v1.
- Vectors: v1 in `vectors`, v2 pin proofs in `v2`, the certificate in `cert`. Both
  implementations test all three.

## refusal reasons

The wire reply is `NO <reason>`; the same word is the `why` of the ledger's `reject` line.

| reason | when |
|---|---|
| `no hello` | no line within 5 s |
| `bad hello` | not `KULA1`/`KULA2`, wrong field count, a clock that is not a number (v2 requires it) |
| `bad channel` | not `rpc` or `api` |
| `bad nonce` | not 32 hex |
| `replay` | this peer used this nonce before (v1 with an auditor; always in v2) |
| `clock` | the client's clock is more than 120 s from ours (same scope as `replay`) |
| `wrong secret` | the v1 HMAC did not match |
| `no proof` | the proof line did not arrive |
| `no tls` | a TLS client reached a server that only speaks v1 (the client sees a TLS error) |
| `tls` | the TLS handshake did not finish (ledger only; no line can reach the client) |
| `no client cert` | a v2 client presented no certificate |
| `not paired` | the client certificate is unknown and there is no open code, or the client sent no code |
| `wrong pin` | the pairing proof did not match |
| `bad proof` | a paired client sent something other than `-` |
| `channel closed` | the channel's local target is not running (no model loaded, the api server not started) |
| `busy` | another peer is on the `rpc` channel |
| `target down` | the 127.0.0.1 target refused the connection |
| `overloaded` | more than 32 connections in the handshake at once (answered at once, before any hello) |
| `no v1` | the server has no v1 secret (`kula-node share --tls` without `--secret`); a plain hello is refused |
| `pin expired` | the pairing code is older than 10 minutes; a new one is made then and the next QR carries it |

Client-side errors: `fingerprint mismatch` (the server certificate is not the one in the
QR; no hello is sent), `tls …` (handshake failure), `server proof wrong`.

## the tunnel

`Tunnel` (in `Gate.kt` and `node/src/gate.ts`) listens on a free 127.0.0.1 port. Every
accepted local connection opens one connection to the worker's gate, performs the handshake
on the chosen channel, and pipes. The `rpc` channel admits one master at a time, so split
mode opens one tunnel per worker and llama.cpp holds it open for the life of the model. The
`api` channel admits many; apart mode keeps one tunnel per worker for its HTTP calls. A
tunnel whose handshake fails closes the local side without writing a byte.

Probing is the same handshake without a pipe: `probePeer` on the phone, `kula-node probe`
and `kula-node peers probe` on a computer. `channel closed` from a probe still means the
worker is up.

## the dev gate

`node app/modules/kula-llama/tools/dev-gate.mjs --secret <hex> [--port 50551] [--model x.gguf] [--host 10.0.2.2] [--tls]`

The smallest kula-node: the same handshake, a `ggml-rpc-server` it starts on 127.0.0.1 for the
`rpc` channel, and for the `api` channel a shim that speaks the worker API in front of a
`llama-server` (started at boot with `--model`, the tunnel opened once `/health` is good).
It prints the QR payload as JSON; on the emulator it is pasted in through "add a device".
`--tls` makes a certificate with `openssl` under `.llama/dev-gate/` and prints a v3 payload.
Binaries come from `node tools/llama-src.mjs --host`.

## threat model, in short

| protects against | v1 | v2 |
|---|---|---|
| anyone on the wi-fi reaching ggml's RPC server or the API | yes: 127.0.0.1 only, handshake first | yes |
| a stranger guessing the secret | 256-bit secret, constant-time compare | no secret to guess |
| replaying a recorded handshake | server nonce; with an auditor also a replay ring and a clock check | always (nonce, ring, clock) |
| reading prompts and answers on the wi-fi | **no** | yes, TLS 1.3 |
| a photographed QR giving lasting access | **yes, it does** | no: the code is one-time, later access needs the paired certificate |
| a device impersonating another | **no identity** | the certificate fingerprint, pinned both ways |
| the worker's own memory abuse by a paired master | no (llama.cpp's protocol allows it; that is why pairing is a trust decision) | same |

Open: the gate key sits on disk, not in the Android KeyStore (`KeyStoreKey` is still an
interface); a paired master is trusted until `paired` is edited (there is no unpair screen
yet); kula-node's `--secret` is visible in `ps`.

## status (5.11.2026)

v1 has run on a real phone (Galaxy S25+) and between the emulator and a Mac in both modes.
v2 passes the JVM tests (`GateTlsTest`, 7 cases: certificate, identity on disk, pairing then
certificate-only, wrong code, wrong fingerprint, foreign certificate, replayed nonce, old
clock, bad hellos, client without certificate, server without TLS, a 300 KB pipe, v1 on the
same port) and the node tests (`gate-tls.test.ts`, 8 cases), and dev-gate `--tls` was driven
by hand with the kula-node client. **v2 has not run on a device yet:** Android was not built
in the cloud session. To check on the emulator: `SSLSocketFactory.createSocket(Socket,
InputStream, Boolean)` (API 24+), Conscrypt's `wantClientAuth` with a TLS 1.3 client
certificate, and the Expo module's `Map<String, Any?>?` argument for `{fp, pin}`. Next:
the key into the KeyStore, a paired / waiting-for-code indicator on the peers screen,
`--tls` as kula-node's default.
