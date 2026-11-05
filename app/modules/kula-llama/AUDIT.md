# beyin/check v0 on the device

The auditor that lives behind the gate. It only checks and records: it hands out no work,
talks to no server and decides nothing about routing. Code: `android/src/main/java/expo/modules/kulallama/audit/`
(plain Kotlin, no Android imports, so it runs under JVM tests and moves to beyin's own repo later).

## The ledger

`files/beyin/ledger.jsonl`, one JSON line per event, append-only:

```
{"t":<unix ms>,"kind":"pair|connect|reject|load|claim|health|end","peer":"<id>", ...fields,
 "prev":"<sha256 hex of the previous line>","sig":"<base64 signature>"}
```

- `t`, `kind`, `peer` come first (peer is left out for `load` and `health`), then the
  event's own fields in a fixed order, then `prev`, then `sig`. Whole doubles print as
  integers so JavaScript's `JSON.stringify` writes the same bytes.
- `prev` is SHA-256 of the whole previous line (UTF-8, no newline); the first line's prev
  is 64 zeros.
- `sig` is the device key's signature over the line text up to and including the prev
  value's closing quote, that is the line without `,"sig":"..."}`.
- When the file passes 5 MB it is renamed `ledger.<t>.jsonl` and the next line's prev is
  still the old file's last hash, so one chain runs across files.
- `Ledger.verify(file, publicKey, alg, firstPrev)` walks a file and returns the index of
  the first line that breaks (bad JSON, wrong prev, bad signature) or -1.
- The worker's own `gateLedger(limit)` in the module returns the last lines as raw JSON strings.

Event fields:

| kind | fields |
|---|---|
| pair | whatever pairing passes in |
| connect | channel |
| reject | channel (may be null), why |
| load | split `[{peer, layers}]`, sha, `reject:"model"` when it is not the expected file |
| claim | ramMb (claimed), heldMb, bw (claimed GB/s), tps, modelGb, warn / reject |
| health | throttled, batteryC, batteryPct, warn |
| end | channel, bytes (both directions), seconds, `reject:"bounds"` when over the limits |

## The key

`DeviceKey`: `alg` (`ed25519`, or `p256` where the JVM lacks Ed25519), `publicKey` as X.509
SubjectPublicKeyInfo bytes, `id` = first 16 bytes of SHA-256(publicKey) in hex, `sign(bytes)`.
`SoftwareKey` is the in-memory / file-backed one (`files/kula_device_key`: algorithm, base64
PKCS8, base64 public key, one per line); the worker process uses it. `KeyStoreKey` is the
interface the Android KeyStore implementation will fill in later.

## The rules

All in `Checks.kt`, pure functions returning `Verdict(ok, reason?, warn)`.

| rule | refuses | warns |
|---|---|---|
| replay | a nonce the same peer used within its last 1 000 (`replay`) | |
| clock | hello timestamp more than 120 s from our clock (`clock`) | |
| claim | claimed/measured (either way round) over 4× (`claim`) | over 2× (`ram`, `bandwidth`) |
| model | reported sha differs from the expected one (`model`) | |
| bounds | more bytes or seconds than the per-connection limits (`bounds`); defaults 64 GB, 12 h | |
| health | never | `throttled`, `hot` over 42 °C, `battery` under 15 % |

Measured RAM is what the worker process holds (RSS); measured bandwidth is tok/s × model GB.
A measurement of zero means "not measured yet" and that comparison is skipped; the worker
has no tok/s of its own today, so only the RAM half of the claim is checked for now.

## Where it is called

- `Gate.Server(..., auditor)`: `onHello` on the client's hello (the hello may carry a 4th
  field, the client's unix ms; three fields still work and the clock rule is then skipped),
  `onConnect` after the proof, `onReject` on every refusal (the wire reply is `NO <reason>`,
  so a replay is `NO replay`), `onEnd` with bytes and seconds when the pipe closes.
- `WorkerService`: builds the key and ledger, hands the auditor to the gate, and from the
  2 s status loop writes `health` once a minute or when its warnings change, plus `claim`
  (advertised RAM vs held) while a master is connected.

## What v0 does not do

No routing, no server, no scoring, no sharing of the ledger between devices, no TLS, no
hardware key yet (`KeyStoreKey` is an interface), no ledger pruning beyond rotation.

## Tests and vectors

`android/src/test/java/expo/modules/kulallama/audit/` (junit4). With an Android SDK:
`./gradlew :kula-llama:testReleaseUnitTest` from `app/android`. Without one:

```
cd app/modules/kula-llama/audit-jvm && gradle test
```

`tools/audit-vectors.json` holds a fixed Ed25519 key (seed = bytes 0x01..0x20) and two ledger
lines with their hashes and signatures; the TypeScript twin in node/ must reproduce them byte
for byte.
