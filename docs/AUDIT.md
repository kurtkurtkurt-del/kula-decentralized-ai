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
| `health` | unpaired (the fingerprint's first 16 hex), name | a paired master's access was removed ([GATE.md](GATE.md#remove-a-devices-access-10112026)); `health` and not a new kind, so older verifiers keep reading the chain |
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
(the brain → **trust and verification**; the phone has it too, below) that answers "is my cluster safe?" with one verdict,
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

**On the phone** (10.11.2026). When the phone is the master (it has paired devices), the brain
tab shows the same report: **trust and verification**, one verdict on top (green all clear,
terracotta look at this, grey not checked yet), a line per device, and behind it a screen
(`src/app/trust.tsx`) with every device's six checks, this phone's own ledger chain, and **i
know why (i cleared it)** on a ledger fault. The checks, the red rules and the english words are
the computer's; a device's pinned check is the peer record's `fp` (a relayed device whose
certificate is still to be learned is grey, never green).

- Asking: `src/llm/trustStore.ts` opens the same `api` tunnel apart mode and the bench use
  (`apiTunnel`, reused when open) and asks `GET /trust`, then `?since=` while `more`, at most
  five pages a look. The brain tab and the trust screen ask when they open and every minute
  while open (each look is a gate connection the device writes to its ledger, so not at the
  15 s the tab reads its own ledger); nothing waits on it, and no prompt is involved.
- Checking: Hermes has no Ed25519 or P-256, so the answer goes to `verifyTrust` in the native
  module (`TrustVerify.kt`, plain Kotlin): sha256 of the certificate it shows against the pinned
  fingerprint, sha256(key)[:16] against the id it claims, the certificate's CN against that id,
  then every line: json, `prev` (the first one against the last line verified at an earlier look),
  signature. P-256 goes through the JCA; Ed25519 (kula-node's keys) goes through the JCA when the
  phone has it and otherwise through an RFC 8032 verifier written out in BigInteger arithmetic
  (Android 15 offers Ed25519 only inside the keystore).
- Kept: per device in the app's kv-store (`llm.trust`): the last line verified, how many since
  when, and a fault, so an app restart goes on where it stopped and a ledger that started over
  while the app was closed is still caught (the device no longer has that line: `found` false).
  The phone verifies as it receives, so it asks from the last line *verified* (the computer asks
  from the last line received and keeps a window of 500). A line that fails stays the fault
  (asking again brings the same line, the same fault) until the person accepts; the chain is then
  followed from that line. Notes of a device that is no longer paired go.
- This phone's own ledger: the chain the brain tab already checks (`verifyChain`, the window of
  200 lines); its signatures are checked where they are read off the phone (the computer, or
  `kula-node ledger --verify` on an export).
- Tests: `app/modules/kula-llama/.../TrustVerifyTest.kt` (real P-256 and Ed25519 keys, a real
  gate certificate, real signed lines; the shared vectors; RFC 8032 vectors and the RFC verifier
  against the JCA), `app/src/__tests__/trust.test.ts` (the notes, the verdict rules, a whole
  look through mocks, the notes across a restart) and `trust-render.test.tsx`. Not yet run on a
  real phone.

## rings and request review (11.11.2026)

Three rings say how far a device is trusted: **home** (your own devices: everything may go
there, a private chat included), **circle** (a friend's: work you trust them with), **world**
(a stranger's: only pieces with nothing private, because a stranger's phone sees the prompt in
plain text while it runs). Every device paired before this is home.

- **Where the ring lives.** `ring` in the peer book (`~/.kula-node/peers.json`, absent = home),
  set with `kula-node peers ring <id> <home|circle|world>`, the engine's `setRing` or
  `POST /api/peers/ring {id, ring}`. Every record of one device (its cable and its wi-fi) gets
  it; a device whose records disagree counts as the widest. It reaches god's eye as
  `EyeDevice.ring`; the eye's guard reads an unknown value as world, and the black box records
  it. The phone keeps its own peer book and has no ring yet.
- **How private a job is.** `node/src/godseye/branches/sensitivity.ts` rates a request
  **private**, **circle-ok** or **world-ok** with rules that each have a name the person can
  read:

  | level | kinds |
  |---|---|
  | private | e-mail, iban (mod 97), card (luhn), turkish id (T.C. kimlik, both check digits), phone (tr, intl, us), password/key/token (env lines, urls with a password, provider key shapes, private keys, long random runs), street address, birth date, a named person (Dr./Sayın/…, "Ayşe Hanım", "my friend Mehmet", "annem Ayşe"), your own files and photos (paths, file names, "my photos", "fotoğraflarım"), something marked confidential, your own health or money (a health or money word next to "my", "ben", "annem", a name, or a turkish first-person ending: "kanserim", "maaşım", "borcumu", "depresyondayım") |
  | circle-ok | a health topic with nobody named, pasted code, your own company or clients |
  | world-ok | none of the above |

  A text that tries to give the model new orders ("ignore all previous instructions", "önceki
  talimatları unut") is a flag, not a level: look again on any ring. The request is also cut
  into pieces (blank lines, list items, sentences; not after "Dr."; a code fence whole) and
  each piece is rated on its own and against the whole text, so the branch can say how many
  pieces a friend or a stranger could still take.
- **What the review branch says.** home takes everything, circle no private material, world
  only world-ok material. Cards (all `warn`, never acting by themselves):
  `review:send-private:<project>` (private material on a circle or world device; weight 3 for
  world), `review:send-circle:<project>` (circle-ok material on a world device), both opening
  the branch page and saying how many pieces could go there instead;
  `review:private-chat` (a chat runs while a circle or world device is in the loaded work;
  its button loads the same model on the home devices only, or here); and
  `review:world-in-cluster` (weight 1: a stranger's device is in the loaded work, no chat yet).
  A key in a request or an injection is to be looked at again even at home; other private data
  at home is fine. The page has one row per ring: its devices, how many projects (and pieces of
  the others) may go there now and how many are held back, by level, and whether the chat is.
  Nothing private enters the view, a card, the feed, the black box or a notes file: kinds and
  counts only, titles masked.

**Why rules and not a model (research, 11.11.2026).** The common open PII tool, Microsoft
Presidio, is built the same way for its structured entities: a pattern, a checksum where one
exists and context words, with a model only for names
([supported entities](https://microsoft.github.io/presidio/supported_entities)); it has no
Turkish id recognizer, and the TCKN checksum is the usual way to tell an id from any 11 digits
([Septum's benchmark](https://byerlikaya.github.io/Septum/benchmark)). Secret scanners
(gitleaks, TruffleHog) are regex rules plus entropy; only TruffleHog's verification calls out,
which kula does not want ([comparison](https://appsecsanta.com/secret-scanning-tools)). For
injection, the small local classifier is Meta's Llama Prompt Guard 2 (22M on DeBERTa-xsmall,
English only; the 86M one is multilingual)
([model card](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-22M),
[LlamaFirewall](https://arxiv.org/pdf/2505.03574)); it gives a label and no reason, is a model
to ship, and is reported to miss indirect injection in tool results
([StackOne](https://www.stackone.com/blog/training-22mb-prompt-injection-classifier/)). The
special categories (health, among others) follow GDPR art. 9 and KVKK art. 6. So: rules now,
each one explainable; a local name recognizer or Prompt Guard can come later as one more rule
with its own name. What rules miss: a name nobody points at ("ask Elif"), a health story told
without a first-person word, context that crosses a piece cut without a detectable word.

Tests: `node/test/godseye-rings.test.ts` (classification in Turkish and English, pieces, the ring
table, the guard, the peer book, the cli, the engine and the page's route, every card and its
`cleanCard`, no private text anywhere), `godseye-review.test.ts`.

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
