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
| **A6 a stranger on the internet** (17.11.2026) | anywhere, once a computer is an anchor or maps its gate port | reaches the gate port and sees its certificate; tries handshakes and floods them. Without a paired certificate or an open one-time code (64 bits) it gets no further than the handshake, and on the `anchor` channel it never hears `pin` |
| **A7 a member of the same anchor** (17.11.2026) | a device the anchor's computer paired with or pinned: the person's own, or a friend's that came with an invite | registers; dials any registered member whose full fingerprint it knows (that member's gate decides who gets in); passes bytes within the caps; gives its own signed record; asks `who` about a full fingerprint and gets that device's signed record (addresses, anchors). It cannot list the members, cannot read other members' streams, and being a member gives it nothing on `rpc` or `api` |
| **A8 the anchor's owner** (17.11.2026) | the person whose computer is the anchor | sees metadata (who talks to whom, when, how many bytes, both IP addresses) and every fingerprint a member asks about (`who`); can refuse, delay or cut streams, and hold back a record or serve an older one that is still validly signed. After the pair-back its computer is paired with every joiner, so towards a joiner it is A3. It cannot read a stream, forge a record, or pair anyone with another device |

A6 to A8 and what was done about them are in [the anchor and the internet](#the-anchor-and-the-internet-17112026).

Design boundary: **a paired master gets trusted access to the worker's processor and memory** (that
is ggml RPC). Until 15.11.2026 that was more than processor and memory: llama.cpp's rpc server ran
the "custom" ops, which carry a function pointer, so a paired master could run code in the worker
process (the app's UID). The phone's build now refuses those ops (`tools/patches/kula-rpc-no-code-ops.patch`),
and since 16.11.2026 a computer's gate reads every rpc connection and cuts a graph with such an op
before the (unpatched, downloaded) server sees it (`node/src/rpcguard.ts`); from 15.11 to 16.11 a
computer whose llama.cpp had no GPU did not serve rpc at all. The rest
of the rpc protocol is still not hardened upstream: pairing stays a trust decision.

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
| 18 | `.part` races | Two downloaders for the same file name (ApiServer `load` + the app's own download) can write to the same `.part`; the `active` map is per id. Result: a broken file → the sha does not match → it is deleted (no data loss, wasted time). Note (15.11.2026): until then a request with a wrong sha also deleted a model that was already on disk; now a file already there is never deleted or replaced by a request. | **L** | download from both sides at the same time | no change | ⚠️ |
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
  at the cost of losing old masters is suggested. Since then the phone closes v1 once anything is
  paired (`Gate.kt` `v1Open()`); it stays open on a hand-started phone until its first v2 pairing.
- **A4 loopback.** On the master phone the tunnel is at `127.0.0.1:<port>`, on the worker phone
  ggml RPC is at `127.0.0.1:<rpcPort>`: any app on the same phone can connect. On the master side
  this means an open door to the worker's RPC (memory writes). No root is needed: any installed app
  can reach these ports. Since 15.11.2026 the worker api serves only connections the gate opened
  (`ApiPeers` legs) and the rpc server refuses the code-carrying ops; the rpc port and the master's
  tunnels themselves still have no authentication on loopback (llama.cpp's RPC knows no Unix sockets).
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

- `kula-node share` uses TLS by default since 10.11.2026; `--no-tls` is the old v1 (a secret in the
  QR, plain-text traffic).
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

## The review of 15.11.2026

A read-only review (18 reviewers, five rounds) found 138 entries and 36 promises the code did not
keep; it is kept outside the public repository. Fixed the same day, each with a test that fails
without the fix:

| what | where |
|---|---|
| a device that said "paired" was pinned without the code (wi-fi, a typed code, a relay) | `node/src/gate.ts` `handshake()` |
| llama.cpp's rpc server ran code-carrying "custom" ops from a paired device | `tools/patches/kula-rpc-no-code-ops.patch` on the phone; on a computer the gate's rpc guard (`node/src/rpcguard.ts`, 16.11.2026; CPU-only computers had stopped serving rpc on 15.11) |
| a paired device could delete or replace a model already on disk, and leave half downloads | `node/src/api.ts`, `ApiServer.kt` |
| talk mode sent what the secretary read aloud to another device | `app/src/voice/prompt.ts` `routeTalk` |
| 32 silent connections locked the gate; one code could pair two devices | `gate.ts`, `Gate.kt` |
| a deep link or one QR started sharing, or swapped the signed-in account, without asking | `share.tsx`, `computers.tsx`, `PeerScan.tsx`, `auth/google.ts` |
| the worker api on 127.0.0.1 served any local process or app | `api.ts` (`viaGate`, `apiAuth`), `ApiServer.kt` (`ApiPeers` legs) |
| a borrowed or unchecked owner-blind proof counted | `ui/engine.ts`, `attest.ts` |

Still open: the rpc port and the master's tunnels on loopback have no key; the phone's trust
check does not tie the ledger key to the certificate; releases are not signed with a key kept off
GitHub; the nightly backup artifact and the shared demo account need the owner's hand on GitHub
and Supabase. A trickled handshake on the phone, open on this list until 17.11.2026, now has 20 s
in all, as on a computer (`Gate.kt`, phone: in 0.6.0).

## the anchor and the internet (17.11.2026)

A computer that is an anchor ([ANCHOR.md](ANCHOR.md)) faces the internet. Review D4 read that
surface before 0.6.0 with three attackers in mind: A6 a stranger on the internet, A7 a member of
the same anchor and A8 the anchor's owner (the threat model above). It found no way for a stranger
to get in or read anything; what it found was about keeping the network working and about
removal. What changed is below, then what stays a limit.

### what faces the internet

When the anchor switch is on (or `kula-node share --anchor`, or `--map-port`):

- **One TCP port: the gate's** (default 50551). The router is asked to map it (PCP, NAT-PMP,
  UPnP-IGD), and over IPv6 the gate answers on the computer's global address if the router lets
  it in. Nothing else is mapped. The api, `ggml-rpc-server`, `llama-server`, the page and the
  share dashboard listen on 127.0.0.1. Two other listeners take a lan address but are never
  mapped: the page's guest invites (only while they are on) and the model file handed to a
  worker on the same wi-fi during a load.
- **TLS 1.3 only.** An anchor or a mapped port will not start with `--no-tls` or `--secret`, so
  a plain v1 hello hears `no v1`.
- **The certificate is shown before any line**, to anyone who connects (a limit, below).
- **`rpc` and `api`:** a paired certificate, or an open one-time code: the qr's, an invite's,
  or a pair-back code that only the certificate it names can use. Codes are 64 bits, single
  use, and live 10 minutes. On a computer the rpc guard reads every rpc connection
  ([GATE.md](GATE.md#threat-model-in-short)).
- **`anchor`:** members only, and never `pin`: a stranger hears `not paired` even while a code
  is open, so nobody pairs through this door.

### the handshake rule

How many connections may sit in a handshake at once, on a computer's gate (`node/src/gate.ts`):

- **32 in all.** The next one hears `NO overloaded` at once, before any hello.
- **Internet addresses share at most 16 of them.** An internet address is one that is not
  loopback and not in a private, shared (carrier NAT) or link-local range. The other 16 stay for
  the home network and for streams through an anchor or a relay, so a flood from outside cannot
  lock the home out.
- **8 per address.** An internet IPv6 address counts by its /56, since one home or one rented
  host gets a whole prefix. Every other address counts by itself. Loopback has no per-address
  limit, since every anchor and relay stream arrives from 127.0.0.1.
- **5 s per line and 20 s for the whole handshake**, however slowly its bytes come.
- **64 KiB held.** A connection that pours more than 64 KiB while the gate awaits no line (before
  its OK, or while the anchor waits 10 s for the target to accept) is cut.

The phone's gate is never mapped. It is reached on the wi-fi and through the anchors it joined
(those streams come from 127.0.0.1). It allows 32 handshakes in all and 5 s per line, and now
20 s for the whole handshake (phone: in 0.6.0), so a member who trickles bytes holds a slot for
20 s at most.

### an invite is a full pairing both ways

An anchor's invite is not a lighter kind of pairing. The joiner pairs with the anchor's gate with
the invite's code and may then use the anchor's computer (`api` and `rpc`). When the joiner
registers, the anchor pairs back with the second code, and **from then on the anchor's computer
may use the joiner's**: run model layers on it and ask it for answers, without asking again, until
someone removes it. So the page asks yes or no before joining and says this. The phone asks too
and also asks whose computer it is, "my computer" or "a friend's computer"; the answer is kept
with the anchor and decides the rpc seat (phone: in 0.6.0). An invite marked "a friend's" makes the
joiner ring `circle` on the anchor (byte-capped); "mine" makes it `home`. A computer that joins
keeps the anchor at ring `circle` until the person changes it.

### removal: what cuts what, and how fast

On the anchor's computer, a device is a **member** while it is in the gate's `paired` list **or**
pinned (with `paired_at`) in the peer book. Both must go before the anchor turns it away.

| the person does | what is cut | how fast |
|---|---|---|
| removes its access (`kula-node paired remove`, the dashboard, the page's "remove its access") | its next handshake on `rpc`/`api` hears `not paired`; its open rpc and api pipes are closed | the next handshake at once; open pipes at once from the share dashboard, otherwise within 2 s (`share` compares the list every 2 s) |
| ... and it is no longer in the peer book either (in either order) | on the anchor: its control connection, its streams (both ends), and its `who` lines get no answer | within 5 s: the anchor asks again every 5 s and on every control line, whether or not anyone called `drop` |
| forgets it in the peer book but leaves it paired | nothing: it is still a member, and still paired | — |
| on a computer that joined an anchor: forgets the anchor on the page | it stops registering there, **and** the anchor's computer is taken off this computer's `paired` list (one signed ledger line), so it can no longer use this computer | as removing access, above |
| on a phone that joined an anchor: forgets the anchor | it stops registering there, and the anchor's computer loses its access to the phone at once (its open connections are cut); coming back takes a new invite |

### logging

- **The signed ledger** (`ledger.jsonl`) gets every refusal at the gate's handshake (`reject`,
  with `peer` the plain IP and the same reason words), including a stranger's knock on the
  anchor door (`channel: 'anchor'`), so the brain's gate watch sees it. A refusal that came
  through an anchor leg arrives from 127.0.0.1, so its line also carries `fp`, the first 16 hex of
  the caller's certificate.
- **Refusals are rate-limited**, so a flood cannot fill the disk. There is one line per address
  block (IPv4 /24, IPv6 /56) and reason per 10 s. Refusals that come in between are held and
  written as one line whose `n` says how many it stands for. There are at most 32 such lines per
  10 s in all; the rest wait for the next window, and nothing is lost. The gate watch and
  `GET /trust` count a line as `n` refusals. The replay check keeps rings for the 4096 addresses
  heard from most recently.
- **The unsigned log** (the share log on the computer) gets register, leave, streams (who to whom
  and how many bytes), a member's refusals after `OK -` (caps, bad requests) and the anchor's own
  dials. These stay out of the ledger on purpose: `GET /trust` hands ledger lines to every paired
  device, and the ledger would then show every member who talks to whom.

### fixed in review D4

| what an attacker could do | now | where |
|---|---|---|
| fill the disk with refusals (one signed line each) | rate-limited lines with `n` | `node/src/audit/auditor.ts` |
| knock on the anchor door unseen by the gate watch | a signed `reject` line, `channel: 'anchor'` | `node/src/share.ts` |
| hold all 32 handshake slots from one IPv6 host | 16 for internet addresses together, IPv6 by /56 | `node/src/gate.ts` |
| pour bytes while no line is awaited | cut past 64 KiB | `node/src/gate.ts` |
| stay connected to the anchor after being removed | cut within 5 s | `node/src/anchor.ts` |
| stall the anchor with `record` lines | 16 at once, then 30 a minute, checked only within that | `node/src/anchor.ts` |
| fill the 512-record store | records no member needs are evicted; a member's own record is never refused for space | `node/src/anchor.ts` |
| friends' streams filling all 128 | friends together leave 32 for the person's own devices | `node/src/anchor.ts` |
| a dishonest anchor flooding a member with `open`s | at most 32 being set up at once; the rest ignored (kula-node; the phone not yet) | `node/src/anchor.ts` |
| grow memory with replay rings | 4096 rings at most | `node/src/audit/checks.ts` |
| keep using a computer after it forgot the anchor | forgetting takes the anchor's access too | `node/src/ui/engine.ts` |
| use a stolen invite first, unnoticed | the real joiner hears to tell the anchor's owner (computer, and phone: in 0.6.0) | `node/src/join.ts`, `Anchor.kt` |
| join an anchor's own invite on the same computer | refused before the code is spent | `node/src/join.ts` |
| hold a computer's rpc seat idle as a friend's device | the seat rule ([GATE.md](GATE.md#the-rpc-seat-17112026)) | `node/src/gate.ts`; `Gate.kt` (phone: in 0.6.0) |
| join a scanned invite on the phone without asking | asked first, with whose computer it is (phone: in 0.6.0) | `PeerScan.tsx`, `Anchor.kt` |
| lock the phone's gate with trickled handshakes | 20 s in all (phone: in 0.6.0) | `Gate.kt` |
| lose a join when the app and the worker write `anchors.json` together | a file lock (phone: in 0.6.0) | `Anchor.kt` |
| a fifth anchor silently pushing out the oldest | refused in plain words (phone: in 0.6.0) | `Anchor.kt` |

### documented limits

- **A flood from the internet** can still fill the 16 internet slots and keep far members out.
  The home network keeps working.
- **Tracking:** anyone who scans the port sees the gate's certificate and can follow a home
  across address changes.
- **`who`:** a member that knows a device's full fingerprint gets its signed record: its lan
  address, public addresses and anchors. It cannot list devices, and the rate is limited. Each
  member asks every joined anchor about every fingerprint it pinned once a minute, so each
  anchor's owner learns that member's whole pinned list.
- **A recent invite shows:** for 30 minutes after an invite was used or ran out, a stranger on
  `rpc` or `api` hears `pin` instead of `not paired`.
- **The anchor's owner** (A8) sees metadata, can hold back a record or serve an older validly
  signed one, and can drop streams. It cannot read a stream, forge a record or pair anyone.
- **A typed invite** names the anchor by 16 hex of its certificate, which is 64 bits. A gate
  with a matching prefix that answers `paired` is accepted. It still cannot pair back without the
  code.
- **A member's own signed record can name any address**, so devices that pinned it will try a
  TLS hello there.
- **Rings:** a device paired the ordinary way (a qr, not an invite) has no ring in the peer book
  and counts as the person's own, so it is not byte-capped and not a friend for the rpc seat until
  someone sets it to `circle`. Only invites ask whose a device is. A certificate with no peer-book
  record at all is byte-capped on the anchor but counts as own for the rpc seat.
- **A stolen invite** used within its 10 minutes gives the thief the ring the invite named:
  `home` for a "mine" invite.
- **The phone:** Doze, network handover and TLS inside TLS are shown only on a real device. The
  phone does not sign, give or take address records yet. On the phone, an anchor's computer counts
  as a friend's for the rpc seat while the anchor is joined as "a friend's computer"; forgetting the
  anchor also removes its computer's access to the phone (and any separate pairing with that same
  computer, as on kula-node). The phone sets up at most 32 `open`s from an anchor at once.
