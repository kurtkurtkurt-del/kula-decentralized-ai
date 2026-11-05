# contributing

Short, because the tree has a few hard rules and the rest is ordinary. The architecture is
in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); every decision so far is logged, in
Turkish, in [docs/ILERLEME.md](docs/ILERLEME.md). Read the log's top section before
starting anything: it says what was tried last and what is open.

## the rules of the tree

1. **`app/android/` and `app/ios/` are generated.** Never create or edit them by hand.
   `npm run apk` runs `expo prebuild --clean` every time; native behaviour is configured in
   `app/app.json` and the modules under `app/modules/`.
2. **llama.cpp comes from the script.** `app/modules/kula-llama/android/src/main/cpp/llama.cpp`
   is fetched, checksummed and patched by `node modules/kula-llama/tools/llama-src.mjs`
   (Gradle runs it before every build). To change llama.cpp, change the tag or the patches in
   `tools/patches/`; never edit the unpacked tree. The tag is **b11157** everywhere (phones,
   kula-node, dev-gate) because ggml's RPC protocol only matches between identical builds.
3. **The passport measurement is not written here.** `app/modules/passport-measure`
   compiles device-passport's `passport-core` from `../device-passport/` when it sits beside
   this repo, else the snapshot in `modules/passport-measure/vendor/`, which is generated.
   After device-passport's core changed: in `app/` run `npm run passport:sync`, then
   `npx jest passport-contract`, and commit `vendor/` with what it needed. `npm run
   passport:check` fails while the snapshot is behind. Never copy `Measure.kt` into kula.
4. **A release apk only through `npm run apk`.** It runs `npm run release:check` first, which
   refuses a build without a live server, with the Mac's address, with plain http, or with
   afterhours' project. Never an `app/.env.local` (Expo loads it into release builds too).
   Development: `app/.env.development.local`; release: `app/.env.production`
   ([docs/SERVERS.md](docs/SERVERS.md)).
5. **ggml's RPC server and the worker API listen on 127.0.0.1 only.** The gate is the one
   port. Any change that binds either to a network interface is wrong, whatever it fixes.
6. **Both gates and both ledgers must stay byte-identical.** `gate-vectors.json` and
   `audit-vectors.json` live in `app/modules/kula-llama/tools/` and are copied, not edited,
   into `node/test/`. A protocol change updates the vectors on both sides in the same commit.
7. **Pure functions for behaviour, thin wrappers around them.** The fit, the planner, the
   conditions, the scheduler, the checks, the ledger parsing are tested with fake inputs; the
   native and network code around them stays small.

## setting up

```bash
cd app && npm install                                 # the app
cd node && npm install && npm run build               # kula-node
cd app/modules/kula-llama && node tools/llama-src.mjs --host   # llama.cpp + Mac/Linux binaries in .llama/host (cluster tests, dev-gate)
```

Models and the cluster need the apk on an arm64 device or emulator; Expo Go runs the rest
of the app. The emulator recipe (avd `kula35`, 2.5 GB RAM on an 8 GB Mac) and the
Mac-as-worker recipe (`tools/dev-gate.mjs`) are in the progress log under "nasıl test edilir".

## tests and checks

| where | command | what |
|---|---|---|
| `app/` | `npx tsc --noEmit` | types |
| `app/` | `npx expo lint` | lint; must be clean (an old `index.tsx` effect error was fixed on `claude/night-2`) |
| `app/` | `npx jest` | the unit tests: fit, hf, store, peers, cluster, engine, night, conditions, scheduler, report, audit, passport contract |
| `app/` | `npm run passport:check` | the vendor snapshot matches device-passport |
| `app/` | `npm run release:check` | which server a release would be baked with |
| `node/` | `npm test` | gate, tls, api conformance, audit, setup, planner, peers, apart, split; localhost only, never fetches llama.cpp |
| `app/modules/kula-llama/audit-jvm` | `gradle test` | the Kotlin gate and audit tests without an Android SDK (JDK 21) |
| `app/android` | `./gradlew :kula-llama:testReleaseUnitTest` | the same Kotlin tests with the SDK |
| `backend/` | `npm test` | the schema, the rules, the seeds on PGlite |
| root | `node tools/docs-links.mjs` | every relative link and anchor in the markdown resolves |

Run types, lint and jest before saying a task is done. CI (`.github/workflows/test.yml`)
runs the backend and the app's checks on every push to `main` and every pull request.

A change to Kotlin or C++ needs an apk and a run on a device or the emulator; the JVM
tests do not load the native library. Say so in the progress log when you could not.

## commit style

Lower case, the first line a sentence or a scope and a sentence, no period:

```
gate: refuse a hello longer than 256 bytes before reading the rest
node ledger: sign the same bytes as the phone, prove it with the kotlin vectors
progress log: split and apart work between the emulator and the mac
```

The body says what was wrong, what changed and how it was checked, in plain sentences. No
squash merges between the long-lived branches; merge commits keep the history of who found
what. Add a section to `docs/ILERLEME.md` (Turkish, lower-case headings, short sentences,
no superlatives) with every change that is more than a typo: what was done, what was
verified, what is open.

Commits made with Claude carry `Co-Authored-By: Claude <noreply@anthropic.com>`.

## branches

`main` and `release/*` are not pushed to directly and no pull request is opened without
being asked. Work goes on `claude/<topic>` or `<name>/<topic>` branches; the branch that
holds the newest merged state is named at the top of the progress log.

## documentation

English for the code, the comments and the docs in `docs/` except the Turkish user guide
and the progress log. Headings in lower case, short sentences, no superlatives. When a
screen, a rule or a file changes, the page that describes it changes in the same commit,
and `node tools/docs-links.mjs` stays green.

## reporting a security problem

The gate, the ledger and the download verification are the security of this project. If
you find a way to reach ggml's RPC server or the worker API from the network, to pass the
handshake without the secret or the paired certificate, to replay a connection, to make the
ledger verify after a change, or to load a file whose checksum was not checked: do not open
a public issue. Use GitHub's private vulnerability report on the repository (Security →
Report a vulnerability), or write to the maintainer directly through the contact on their
GitHub profile. Say which build (the apk version or the commit), which device, and the
steps. A fix will be committed with the report credited as you wish; the protocol page
([docs/GATE.md](docs/GATE.md)) carries the threat model so you can see what is already
known.
