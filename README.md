# kula decentralized ai

**join your phones and computers into one local AI cluster.**

kula runs a real language model on an Android phone (llama.cpp b11157) and joins nearby
phones and computers into a cluster by scanning a QR code. A computer joins with
`kula-node`; a relay reaches a device behind another network. One gated port between
devices, a signed ledger of what every device did, and, at night, the phone works on a
project you chose while it charges. Open source.

## three modes

| mode | what happens | when |
|---|---|---|
| **alone** | the model runs on this phone only | one device, or nothing joined |
| **apart** | every device loads its own copy; prompts and night jobs are handed to whichever is free; the speeds add up | the default when devices are joined; works over the relay too |
| **split** | one model's layers are spread over the devices through ggml's RPC backend, so a model too big for one phone runs | one big model, devices in the same room on the same Wi-Fi |

Jobs are split, models are not, unless you ask for it: the model page shows each mode's
estimated speed and says when the phone alone would be faster.

## what is in the repository

| folder | what |
|---|---|
| [`app/`](app/) | the Expo app (Android first): models tab with the catalog and Hugging Face search, model pages and the mode question, chat, share this phone / add a device by QR, connected devices, the passport (the phone's measurement), the night and its morning report, the beyin audit page |
| [`app/modules/kula-llama/`](app/modules/kula-llama/) | the native module: llama.cpp over JNI, the worker in its own process, the gate (v1 HMAC, v2 TLS), resumable sha-checked downloads, the relay client, beyin's auditor and ledger |
| [`app/modules/passport-measure/`](app/modules/passport-measure/) | the bridge to device-passport's measurement (compiled in, never copied) |
| [`node/`](node/) | **kula-node**: a Mac, Linux or Windows computer as a worker behind the same gate, or as the device that runs a cluster; a local dashboard |
| [`node/relay/`](node/relay/) | **kula-relay**: a blind WebSocket pipe between two devices behind NAT |
| [`backend/`](backend/) | kula's Supabase project: schema, rules, edge functions, a local dev server, tests |
| [`web/`](web/) | the Mac passport script and a computer's passport page |
| [`tools/`](tools/) | planner vectors shared by app and node, the docs link check, the Mac script build |
| [`docs/`](docs/) | the documentation: start at [docs/README.md](docs/README.md) |

## try it

**On a phone** (Android, arm64): build the release apk on a Mac or Linux machine with the
Android SDK and JDK 17, then install it.

```bash
cd app && npm install && npm run apk    # checks which server it bakes in, then builds dist/*.apk
```

Open kula, measure the phone on the passport tab, download a model that *fits*, start it,
chat. To join a second phone (same Wi-Fi): *share this phone* on one, *connected devices →
scan a code* on the other, then start the model again in *apart* or *split* mode. Without the
native module (Expo Go, iOS, the web) the app runs but downloads no models:
`cd app && npx expo start`.

**On a computer** (Node 20+):

```bash
cd node && npm install && npm run build
node dist/bin/kula-node.js setup     # fetches or builds llama.cpp b11157
node dist/bin/kula-node.js share     # a worker: prints the QR the phone scans
```

`kula-node chat --model <gguf> --mode apart|split` runs a cluster from the computer instead.
Everything else (peers, the relay, the ledger, the dashboard): [docs/NODE.md](docs/NODE.md).
The step-by-step user guide is in [English](docs/GUIDE.en.md) and [Turkish](docs/GUIDE.tr.md).

## the gate rule

ggml's RPC server and the worker API listen on **127.0.0.1 only**, on every device. The
only port open to the network is the gate, which admits a device after a handshake
(protocol v1: a shared secret and HMAC; v2: TLS 1.3 between pinned device certificates) and
then pipes to localhost. Nothing that binds RPC to a network interface is ever right,
whatever it fixes. Details: [docs/GATE.md](docs/GATE.md).

## kula and beyin

kula, the joining of devices, is meant to stay free. **beyin** ("brain") is separate
software that would become the service on top: predicting which device is up when,
scheduling across the internet, aggregating trust, hosting the relay. kula works fully
without it. For now everything, kula and beyin, stays public and open source; the boundary
is described in [docs/BEYIN.md](docs/BEYIN.md).

## documentation

| read | for |
|---|---|
| [docs/README.md](docs/README.md) | the index of every page |
| [docs/DURUM.md](docs/DURUM.md) | where the project stands (Turkish): done, not yet run on a device, open decisions |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | how it is built |
| [docs/HISTORY.md](docs/HISTORY.md) | where it came from: the afterhours fork, the demo world, the simulated night |
| [CONTRIBUTING.md](CONTRIBUTING.md) | the rules of the tree, tests, commit style, reporting a security problem |
| [app/CREDITS.md](app/CREDITS.md) | licenses and credits |

## servers

A release apk talks to kula's own Supabase project (`app/.env.production`); development
talks to the Mac's local server (`app/.env.development.local`); a build with no server is a
demo that answers from an invented world on the phone. `npm run apk` refuses a build with
the wrong server. Setting up the live project: [docs/SERVERS.md](docs/SERVERS.md).

## license

MIT for kula's own code. llama.cpp (MIT), the port from PrivateLM / llama_flutter_android
(MIT), and the models under their own licenses: [app/CREDITS.md](app/CREDITS.md).
