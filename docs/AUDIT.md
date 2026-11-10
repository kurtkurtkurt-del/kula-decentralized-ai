# beyin/check v0: the auditor and its ledger

beyin is the independent checker a kula cluster will one day be scored by. v0, what exists
today, **only checks and records**: it hands out no work, talks to no server and decides
nothing about routing. It sits behind the gate on every worker, phone or computer, and
writes what it saw to a signed, hash-chained ledger that anyone can verify later.

Code: Kotlin `app/modules/kula-llama/android/src/main/java/expo/modules/kulallama/audit/`
(plain Kotlin, no Android imports, so it runs in JVM tests and can move to beyin's own
repository), its TypeScript twin `node/src/audit/`, the reader the phone's screens use
`app/src/llm/audit.ts`, and the module's own short page
[`app/modules/kula-llama/AUDIT.md`](../app/modules/kula-llama/AUDIT.md). The gate it hangs
on is in [GATE.md](GATE.md).

## the ledger format

One JSON object per line, append-only. Phone: `files/beyin/ledger.jsonl`. Computer:
`~/.kula-node/ledger.jsonl`.

```
{"t":<unix ms>,"kind":"pair|connect|reject|load|claim|health|end","peer":"<device id>", …event fields…,
 "prev":"<sha256 hex of the previous line>","sig":"<base64 signature>"}
```

- Keys in a fixed order and no spaces: `t`, `kind`, `peer` (left out for `load` and
  `health`), the event's own fields in a fixed order, then `prev`, then `sig`. Whole doubles
  print as integers, so Kotlin's `Json.kt` and JavaScript's `JSON.stringify` write the same
  bytes.
- `prev` is the SHA-256 of the whole previous line (UTF-8, without its newline). The first
  line's `prev` is 64 zeros (genesis).
- `sig` is the device key's signature over the line text **up to and including the closing
  quote of the `prev` value**, that is the line without `,"sig":"…"}`. (Both implementations
  sign exactly these bytes; a mismatch here was found and fixed while merging, see
  ILERLEME.md.)
- At 5 MB the file is renamed `ledger.<t>.jsonl` and the next line still names the old
  file's last hash, so one chain runs across files.
- `clear` removes the live file and the rotated ones; the next append starts a new chain
  from genesis, even if the worker process holds the file open.

### event fields

| kind | fields | written when |
|---|---|---|
| `pair` | channel, fp (what pairing passes in) | a v2 master paired with a one-time code |
| `connect` | channel | a handshake passed |
| `reject` | channel (may be null), why | any refusal; `why` is the gate's reason (`replay`, `clock`, `wrong secret`, `busy`, …) |
| `load` | split `[{peer, layers}]`, sha, `reject:"model"` when the file is not the expected one | the api channel was asked for a model, or a split model was loaded |
| `claim` | ramMb (claimed), heldMb (measured), bw (claimed GB/s), tps, modelGb, warn / reject | while a master is connected, once the worker holds at least 256 MB for it |
| `health` | throttled, batteryC, batteryPct, warn | once a minute, or when the warnings change |
| `end` | channel, bytes (both directions), seconds, `reject:"bounds"` when over the limits | the pipe closed |

## the key

`DeviceKey` (Kotlin) / `node/src/audit/key.ts`: `alg` is `ed25519`, or `p256` where the
runtime lacks Ed25519; the public key is X.509 SubjectPublicKeyInfo bytes; the device id is
the first 16 bytes of SHA-256 over them as 32 hex; `sign(bytes)`. Storage: phone
`files/kula_device_key` (algorithm, base64 PKCS8, base64 public key, one per line);
computer `~/.kula-node/device_key.pem` (PKCS8 PEM). The worker process uses the same key
as the app. `KeyStoreKey`, an Android KeyStore implementation, is still an interface.

## the checks

All in `Checks.kt` / `checks.ts`, pure functions returning `Verdict(ok, reason?, warn[])`.

| rule | refuses with | warns with | numbers |
|---|---|---|---|
| replay | `replay`: a nonce this peer used within its last 1 000 | | the ring keeps at most 64 peers |
| clock | `clock`: hello timestamp more than 120 s from ours | | `CLOCK_SKEW_MS` |
| claim | `claim`: claimed vs measured (either way round) over 4× | `ram`, `bandwidth` over 2× | `CLAIM_WARN` 2.0, `CLAIM_REJECT` 4.0 |
| model | `model`: reported sha256 differs from the expected one | | |
| bounds | `bounds`: more bytes or seconds than the per-connection limits | | defaults 64 GB, 12 h |
| health | never | `throttled`, `hot` over 42 °C, `battery` under 15 % | `HOT_C`, `LOW_BATTERY_PCT` |

Measured RAM is what the worker process holds (RSS); measured bandwidth is tok/s × model GB.
A measurement of zero means "not measured yet" and that half of the comparison is skipped;
the worker has no tok/s of its own today, so only the RAM half of a claim is checked.
kula-node's `share --lie-ram <MB>` exists to make this rule fire on purpose.

## where it is called

- `Gate.Server(…, auditor)`: `onHello` on the client's hello (replay and clock; skipped for a
  three-field v1 hello), `onConnect` after the proof, `onReject` on every refusal, `onEnd`
  with bytes and seconds when the pipe closes, `onPair` in v2.
- The auditor's hooks run inside `runCatching`, and a `NO` is sent **before** the record is
  written: a ledger that cannot be written never takes the gate down and never lets anyone
  through.
- `WorkerService` (phone) and `share` (kula-node) build the key and the ledger, hand the
  auditor to the gate, write `health` from the status loop and `claim` while a master holds
  memory.

## verifying a chain

- Kotlin: `Ledger.verify(file, publicKey, alg, firstPrev)` returns the index of the first
  line that breaks (bad JSON, wrong prev, bad signature) or -1.
- Computer: `kula-node ledger --verify` walks the file(s), rotated ones first, checks every
  `prev` and every signature with this computer's key, exits 1 and names the line and what
  is wrong (`prev`, `sig`, `json`, `kind`).
- Phone: settings → app → **beyin audit** (`app/src/app/audit.tsx`)
  shows the last 200 lines, newest first, filter chips by kind, counts of refusals, warnings
  and lines, and the chain check: "chain intact", "chain intact in this window" when the
  window starts mid-file, or a red box naming the broken line. The phone checks the
  **chain** only (each `prev` matches the line before); the signature is the worker's and
  is checked where the key is.
- Vectors: `app/modules/kula-llama/tools/audit-vectors.json` holds a fixed Ed25519 key
  (seed = bytes 0x01..0x20) and two lines with their hashes and signatures;
  `node/test/audit-vectors.json` is the byte-identical copy and the node test regenerates
  them. Any new twin of the ledger must reproduce them.

## the security report (10.11.2026)

The first thing beyin will sell, built here first: one screen on the computer's chat page
(the brain → **trust and verification**) that answers "is my cluster safe?" with one verdict,
green **all clear** or red **look at this**, and under it every device's checks.

Every worker answers `GET /trust` on its `api` channel, behind the gate (the contract is in
[GATE.md](GATE.md#get-trust)): its device id, its ledger key's public half and where that key
lives, its gate certificate, whether it would still take a v1 hello, its ledger lines after
the last one the computer has, and its refusals of the last day. kula's engine asks it through
the same tunnel as `/status` at every probe (`askTrust` in `node/src/ui/engine.ts`) and keeps
a window of the last 500 lines per device; god's eye's trust branch
(`node/src/godseye/branches/trust.ts`) does the checking. It takes nothing on faith:

| check | how | red when |
|---|---|---|
| pinned | the peer record has the fingerprint from the qr | an older pairing (v1 secret, no certificate) |
| encrypted | tls on the link, and the device's `gate.v1` | no tls, or the device still takes the plain-text protocol |
| identity | the engine hashes the certificate the device shows and compares it with the pin (the pin itself stays out of god's eye); the branch computes sha256(public key)[:16] and reads the certificate's CN | the certificate is not the pinned one, the key is not the id it claims, the CN names another device |
| refused | the device's counts of the last 24 h, by reason | any `replay`, or 5 or more wrong codes / secrets / proofs in a day |
| ledger | every line's `prev` and signature against the device's key, joined to the last line verified before (kept in the branch's notes) | a changed, dropped or inserted line, a forged signature, a ledger that started over (cleared or rewritten), or the device's own check says broken |
| key | the device's word: keystore or file | never (it is not checkable from outside) |

A ledger fault stays red across looks until the person presses **I know why (I cleared it)**
on that device (`POST brain/act`, owner only); the chain is then followed from there. A
device that was not asked yet, or an older worker without `/trust`, is **not checked yet**,
never green. This computer's own ledger is checked with `verifyChain` (again only when one
of its files changed). No prompts and no answers are in any of it: ledger lines hold who
connected, on which channel, and whether they were let in.

Tests: `node/test/godseye-trust.test.ts` (real Ed25519 and P-256 keys, a real certificate,
real signed lines: a changed line, a forged signature, a dropped line, a restart, too many
wrong codes, a replay, the old protocol open, the engine's window).

## peer badges

Beside each device on the peers screen: **verified** (sage), **warning** (gold), **refused**
(brick), **not seen yet** (grey). The badge is the newest ledger line for that peer's id:
a `reject` line or a `reject` field gives refused, a non-empty `warn` gives warning,
anything else verified (`peerBadge` in `app/src/llm/audit.ts`).

## export and clearing

- **Export** on the audit screen writes the lines as `beyin-<date>.jsonl` and opens the
  share sheet (`expo-sharing`). Pulling the phone's ledger to a Mac and running
  `kula-node ledger --verify` on it is the last proof that both implementations write the
  same format; the vectors pass, the live file has not been tried yet.
- **Clear the ledger** asks once; every line goes and the next event starts a new chain.
  The native side is `clearAuditLedger()`; `auditLedger(limit)` is the read.

## what v0 does not do

No routing, no server, no scoring, no sharing of the ledger between devices, no hardware
key, no pruning beyond rotation.

Fixed on 10.11.2026: a half last line (the process died mid-append) is cut off on open
and before each append, and the cut is itself a signed `health` line `{"torn":<bytes>}`; a
key file that is there but unreadable is moved aside as `<name>.broken.<ms>` (a `health`
line `{"key":"replaced"}`) instead of being overwritten in silence; the phone's key lives in
the Android KeyStore; the key and the lines leave the device through `GET /trust`, so the
computer verifies the phone's signatures (the security report above).

Known gaps (noted, not fixed): after a key is replaced the old lines no longer verify with
the new key, so the device reports its ledger `broken` until it is cleared;
`Json.kt` and `JSON.stringify` differ on `\b`, `\f`, lone surrogates and some decimals
(none occur in today's fields, but it is the contract); the claim rule measures RSS, not
the device's real free memory.

## tests

| where | command | what |
|---|---|---|
| `app/modules/kula-llama/audit-jvm` | `gradle test` (JDK 21, no Android SDK needed) | GateTest, GateTlsTest, AuditorGateTest, B64, Checks, DeviceKey, Ledger, Vectors |
| `app/android` (with an SDK) | `./gradlew :kula-llama:testReleaseUnitTest` | the same classes |
| `node/` | `npm test` | `audit.test.ts`: vectors, chain, tampering, rotation, checks, the clock field, `kula-node ledger` |
| `app/` | `npx jest audit` | `audit.test.ts`: a sample ledger, a broken chain, a missing line, an empty ledger, the badges |
