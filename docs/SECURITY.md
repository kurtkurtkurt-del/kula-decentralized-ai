# security review — the cluster surface (5.11.2026)

Translated from the Turkish original of 5.11.2026; the original is in the git history of this file.

The `claude/security-review` branch: on top of `origin/claude/gate-tls` + `origin/claude/integrate-night`,
the whole cluster surface seen with an attacker's eye. The protocol page is `GATE.md`; this page keeps
the threat model, the findings, the fixes made and the remaining risks. Tests: JVM `GuardTest`,
`GateSecurityTest` (`gradle test --max-workers=1` in `audit-jvm/`), node `test/security.test.ts`,
jest `app/src/__tests__/security.test.ts`.

## threat model

Assets: the worker's memory and processor (ggml RPC writes remote memory), the worker's disk,
the chat content (tokens passing between phone and phone), the device identity (the certificate
key, `kula_device_key`), the cluster secret (v1) and the pairing code (v2).

| attacker | where | what they can do |
|---|---|---|
| **A1 a stranger on the same Wi-Fi** | cafe, dorm, work network | connects to the gate port, reads mDNS, listens to/changes traffic (ARP), cannot see the QR |
| **A2 a stranger who saw the QR** | screenshot, over the shoulder, photo | A1 + the secret at that moment (v2 QR) or `fp`+`pin` (v3 QR) |
| **A3 a compromised partner** | the paired master phone is stolen/malicious | passes the gate; makes the worker download a model, writes the worker's memory over RPC |
| **A4 another app on the same phone** | 127.0.0.1 | the tunnel and the RPC server are on loopback; Android has no loopback isolation between UIDs |
| **A5 the model server** | HF or the host in `url` | redirects, a long body, a wrong size |

Design boundary: **a paired master gets trusted access to the worker's processor and memory** (that
is ggml RPC). This page pulls A3 to the boundary "it uses the worker only for the model, it cannot
reach the rest of the phone"; it does not block it completely.

## findings

Severity: **H** high, **M** medium, **L** low. Status: ✅ fixed, ⚠️ open (a decision/device job), ℹ️ note.

| # | where | finding | sev. | reproduction | fix + test | status |
|---|---|---|---|---|---|---|
| 1 | `app/src/llm/peers.ts` | The phone's worker secret was derived from the last nibble of the character codes of `newId()` (Math.random, xorshift128+): not a CSPRNG, the state can be recovered from a few outputs, the distribution is skewed. It was v1's only key. | **H** | `randomHex` old form: `newId()` → `charCodeAt().toString(16).slice(-1)` | `app/src/llm/random.ts`: `expo-crypto.getRandomBytes` (SecureRandom). jest `security.test.ts`: 64 hex, no repeats, every byte kept. | ✅ |
| 2 | `ApiServer.kt /load` | `name` went straight into `File(modelsDir, name)`: `../../shared_prefs/x` writes to any file in the app directory; if the checksum did not match, `dest.delete()` → **deletes any file** (`kula_device_key`, `gate_key`, `paired`…). The node side already did `safeName`. | **H** | `POST /load {name:"../kula_device_key", sha256:"00..", url:…}` | `Guard.kt ModelName.safe`: the last segment, `[A-Za-z0-9._-]`, `.part` forbidden → `400 bad name`. `GuardTest.modelNamesStayInsideModels`. | ✅ |
| 3 | `ApiServer.kt`, `ModelDownloader.kt` | `url` was unbounded: the worker sends requests into the LAN (SSRF, `http://192.168.1.1/…`, `169.254.169.254`), `HttpURLConnection` follows redirects on its own (an outside host → an inside host 302). | **M** | `/load {url:"http://192.168.1.1/admin"}` | `UrlPolicy.problem`: only http(s), no credentials, loopback/link-local/private/CGNAT/multicast literals and `.local`/`localhost` forbidden; in the downloader a check of the policy + the **resolved address** at every hop, at most 5 redirects (`open()`), a policy error is not retried. node `policy.ts` + `download.ts` (`lookup` hook). `GuardTest.urlPolicy…`, node `security.test.ts` (a redirect into the LAN, a loop). | ✅ |
| 4 | `ModelDownloader.kt`, node `download.ts` | Disk filling: `size` was only for progress; the server can send a bigger body or an endless chunked stream. Kotlin left a 64 MB margin, node did not look at all. | **M** | `/load {size:1000}` → the server sends 5 GB | If Content-Length exceeds `size` by more than 2%+1 KiB, `size mismatch`; in the stream `got > size` → cut; with an unknown length a free-space check every 32 MiB; at least **512 MB** stays on disk. `.part` is not deleted (it can resume) but the target file never appears. node `security.test.ts` `/endless`, `/big`. | ✅ |
| 5 | `ApiServer.kt` | `Content-Length` unbounded → OOM through `CharArray(length)`; the number/length of headers unbounded (`BufferedReader.readLine`). node had a 1 MiB limit. | **M** | `Content-Length: 2000000000` | `HttpLimits`: a line 8 KiB, 64 headers, body 1 MiB → 413/431; broken JSON 400. `GuardTest.httpLimits…`. | ✅ |
| 6 | `Gate.kt admit` | The "one master" rule was check-then-set: `currentPeer` was read and then written; when two different IPs came at the same time both passed (in node the slot was taken before the connection). | **M** | a `rpc` handshake from two IPs at the same time | `RpcSlot` (`@Synchronized take/release`), taken **before** the local connection, released on `target down`. `GuardTest.theRpcSlot…` (32 addresses at the same time → 1). | ✅ |
| 7 | `Gate.kt`, `gate.ts` | A flood of half-open connections: every connection is a thread/promise + 5 s; no limit → thread/memory exhaustion, a legitimate master cannot get in. | **M** | open 500 TCP connections, send no hello | `MAX_HANDSHAKES = 32`: the rest get `NO overloaded` **without waiting for a hello** and are closed; the slot is given back when OK is written or the socket closes. `GateSecurityTest.pastMaxHandshakes…`, node `security.test.ts`. | ✅ |
| 8 | `share.ts`, `Gate.kt` | **Downgrade**: a server speaking v2 (TLS) also accepted v1 on the same port. With `--tls` on the PC there is no secret in the QR, but a random secret still kept v1 alive (needless surface, HMAC guessing attempts). On the phone, before the v3 QR, the v2 QR shows a secret. | **M** | `KULA1 …` to a `--tls` server | `secret: null` → `NO no v1` (Kotlin and node). `kula-node share --tls` now has v1 closed unless `--secret` is given. The phone worker keeps v1 **open** for old masters (the secret is strong now; see the remaining risks). `GateSecurityTest.aServerWithoutASecret…`, node test. | ✅ / ⚠️ phone |
| 9 | `Gate.kt TlsServer`, `share.ts` | **TOFU poisoning**: the pairing code stayed valid indefinitely until it was used. As long as the share screen stayed open, anyone who photographed the QR (A2) could pair even days later. | **M** | a photo of the QR, `probe --fp --pin` 1 day later | `PIN_TTL_MS = 10 dk` (10 minutes): an expired code gets `NO pin expired` and is renewed at once; the worker's status loop also renews an expired code even if nobody tries it, the QR refreshes in 2 s. A paired master is not affected. `GateSecurityTest.aPairingCodePastItsTtl…`, node test. | ✅ |
| 10 | `app/src/app/share.tsx` | The QR (secret/pin) is on the screen; a screenshot, a screen recording, the "recent apps" thumbnail. | **L** | take a screenshot | `secureScreen(true)` = `FLAG_SECURE` on the share screen. It cannot be verified in jest; to be looked at on the device. | ✅ (verify on the device) |
| 11 | `kula_llama.cpp` | The JNI `endpoints` array was not validated; Kotlin always passes `127.0.0.1:port`, but if a LAN address came in through a JS/Kotlin mistake the RPC client would connect outside without authentication. `nServe` also bound to the address it was given. | **L** | `loadModel(endpoints=["192.168.1.5:50052"])` | `isLoopbackEndpoint`: if any endpoint is not `127.0.0.1:<1-65535>`, `cluster: worker endpoint … is not on 127.0.0.1`; `nServe` refuses anything outside loopback. The Kotlin twin `Endpoints.isLoopback` (`GuardTest`). | ✅ |
| 12 | `ApiServer.kt /load` | `sha256` was optional: a download could be installed without verification (node required it). | **L** | `/load {url, name}` without a sha | If a download is needed, `400 sha256 is needed to download`; if given it must be 64 hex; for a file already on disk it is still optional (trust the local file). `ctx` 256..1M. | ✅ |
| 13 | `AuditorGateTest` / `Gate.refuse` | integrate-night's "answer first, then record" order could put the refusal record outside the order the client saw (the test caught it too). | **L** | a refusal and a connection back to back | `audit{}` (runCatching) **before the NO**; if the ledger cannot be written the NO still goes out. | ✅ |
| 14 | `Gate.kt`/`gate.ts` timing | HMAC/pin/fp comparisons are constant time (`constantEquals`, `timingSafeEqual`). A length difference leaks but the hex length is fixed. `paired`/`pin` state is plain text but not secret. The nonce is 16 bytes from `SecureRandom`/`randomBytes`. Replay: in v1 a proof cannot be replayed anyway because the server nonce is fresh; a repeated hello is also refused by the auditor ring (the phone worker always has the auditor, node `admit` is always attached), v2 checks even without an auditor. | ℹ️ | — | no change | ℹ️ |
| 15 | NSD TXT | `id` (a permanent UUID), `ram`, `bw`, `name` (Build.MODEL), `kind`, `v`. No secret. The permanent `id` allows tracking across networks. | **L** | `dns-sd -B _kula._tcp` | no change; `id` is already in the QR; an optional per-network derived id later. | ⚠️ |
| 16 | release `network-security-config` | Cleartext only on `127.0.0.1`/`localhost`; attached in the release manifest. Raw sockets (gate v1) are not affected by NSC — v1 being plain text is by design (HMAC identity, no encryption). | ℹ️ | — | no change | ℹ️ |
| 17 | `WorkerService` | `exported=false`; the secret Intent extra comes from the same app; the stop action is `PendingIntent.getService` + `FLAG_IMMUTABLE`, it can be stopped from the lock screen (no information leaks). The state file (`pin`, `fp`) is in the app's private directory. | ℹ️ | — | no change | ℹ️ |
| 18 | `.part` races | Two downloaders for the same file name (ApiServer `load` + the app's own download) can write to the same `.part`; the `active` map is per id. Result: a broken file → the sha does not match → it is deleted (no data loss, wasted time). | **L** | download from both sides at the same time | no change | ⚠️ |
| 19 | JNI `ggml_backend_rpc_add_server` | If the endpoint does not answer the process **aborts** (the app crashes). Kotlin does a gate probe, but if the worker goes down or says `busy` between the probe and add_server, it aborts. | **L** | close the worker after the probe | no change; llama.cpp needs to return an error instead of aborting (upstream) | ⚠️ |
| 20 | kv-store | `llm.peers` (secret, fp, pin) and `llm.share` (the phone's own secret) are in the expo-sqlite kv-store, unencrypted, in the app's private directory. `allowBackup` default → Android backups can carry this data. There is no secret in the logs (checked with `grep`: `console.*`, `Log.*` only the first 16 hex of the fp). | **L** | take a backup | no change; `secureStorage.ts` (Keystore) already exists, `llm.share.secret` can move there; `android:allowBackup=false` or backup rules | ⚠️ |

## protocol changes (compatibility)

- New refusal reasons: `overloaded`, `no v1`, `pin expired` (`GATE.md` table). Clients already
  show an unknown reason as text; the behaviour does not change.
- `Gate.Server(secret: String?)`, `startGateServer({ secret: string | null })`: `null` = v1 closed.
- `TlsServer.pinExpiresAt` (on both sides); `null` = no expiry (tests, dev-gate).
- `/load`: `name` is reduced to a file name, `url` policy, `sha256` required for a download, `size`
  an upper bound. The app already sends `model.file`, `model.sha256`, `model.size`; a model without
  a sha from HF cannot be loaded in apart mode (it was already so in node).
- `dev-gate.mjs` (the Mac test gate) did not change: no pin expiry, v1 always open; it is only for tests.

## remaining risks

### phone ↔ phone

- **v1 open (finding 8).** The phone worker keeps accepting v1 with a `secret` so that old
  masters' v2 QR works. v1 is plain text: A1 on the same Wi-Fi **can read** the token stream and
  the RPC tensors (no encryption), A2 (who saw the v2 QR) becomes a master. Decision: should a
  worker that has paired over v3 once close v1? (`paired.size() > 0 → secret = null`). Closing it
  at the cost of losing old masters is suggested; one line (`WorkerService`), not done in this branch.
- **A4 loopback.** On the master phone the tunnel is at `127.0.0.1:<port>`, on the worker phone
  ggml RPC is at `127.0.0.1:<rpcPort>`: any app on the same phone can connect. On the master side
  this means an open door to the worker's RPC (memory writes). llama.cpp's RPC does not know Unix
  sockets, so there is no cheap fix; it stays with the assumption "only a device without root/debug".
- **A3 a compromised master.** A paired master makes the worker download and load any GGUF it
  wants (the gguf parser with untrusted input), and writes the worker process's memory over RPC.
  The worker is a separate process (`:worker`), it can reach the app's data from the same UID. The
  boundary: a separate process + this page's file/URL/disk rules. Beyond that: `isolatedProcess`
  for the worker (hard because of ggml's file/network needs) or a **forget** interface from the
  `paired` list (`Paired.forget` exists, no UI).
- **The moment of pairing.** A2 who sees the QR inside the 10-minute window can still pair; the
  paired `fp` is written to the ledger and the `paired` file, the master screen does not verify
  before it says "paired". The pin is 64 bit, no brute force.
- **Backups (20).** With `allowBackup` the secret and `paired` can go into a cloud backup.

### phone ↔ pc

- `kula-node share` **without `--tls`** still defaults to v1: a secret in the QR, plain-text
  traffic. `--tls` should be made the default (one flag), not changed in this branch.
- On the PC side the `paired` file is plain text under `~/.kula/`; another user/process on the PC
  can read it. The certificate key is the same (`gate_key`); there is no KeyStore equivalent.
- `ggml-rpc-server` is bound to `127.0.0.1` on the PC but any process on the PC can connect (the
  PC form of A4).
- The `llama-server` child process is on 127.0.0.1 with `--no-webui`; the same A4.
- `/load` makes the PC an HTTP client to the public internet (with the policy only public
  addresses); the downloaded file is verified with a sha, yet the master can make the PC load any
  GGUF it wants (A3).

### shared

- The certificate lasts 10 years, there is no revocation; when a device is lost the other side
  must be removed from `paired` by hand (`forget` exists, no interface).
- The auditor's ledger (`ledger.jsonl`) is local; a fake worker writes its own ledger. This page
  does not count the ledger as proof.
