# kula decentralized ai

**your phone works a night for a project you chose.**

An open-source Android app that lends a phone's idle, charging hours to a project by
running a small language model on it, and joins phones and computers into one local model
cluster. llama.cpp on the phone; one gated port between devices; a signed ledger of what
every device did. Forked from afterhours on 20.10.2026.

## what is here

| folder | what |
|---|---|
| `app/` | the Expo app (Android first): models tab, model page with the mode question (only this phone · apart · split), chat, share this phone, connected devices, the night, the passport measurement |
| `app/modules/kula-llama` | the native module: llama.cpp b11157 over JNI; Kotlin gate (shared secret v1, TLS v2), the worker in its own process, the apart-mode API, resumable downloads, beyin's auditor |
| `app/modules/passport-measure` | the bridge to device-passport's measurement (compiled in, never copied) |
| `node/` | kula-node: a Mac, Linux or Windows computer as a worker behind the same gate, or as the device that runs a cluster |
| `backend/` | the Supabase schema, the local development server, the tests |
| `docs/` | the documentation (below) |
| `/` (the rest) | the afterhours website the repository was forked from; its notes are in [AFTERHOURS.md](AFTERHOURS.md) |

## documentation

| read | for |
|---|---|
| [docs/GUIDE.en.md](docs/GUIDE.en.md) · [docs/GUIDE.tr.md](docs/GUIDE.tr.md) | using it: install, measure, which model for which phone, chat, joining two phones, adding a computer, the night, troubleshooting, faq |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | how it is built: components, the two processes, data flows per mode, the gate and tunnel, file locations, why it is this way |
| [docs/GATE.md](docs/GATE.md) | the one open port: protocol v1 and v2, refusal reasons, the tunnel, the dev gate |
| [docs/AUDIT.md](docs/AUDIT.md) | beyin/check v0: ledger format, the checks, chain verification, export |
| [docs/NIGHT.md](docs/NIGHT.md) | the night: conditions, the scheduler, the report, the limits |
| [docs/NODE.md](docs/NODE.md) | kula-node: commands, setup per platform, beyond the local network |
| [CONTRIBUTING.md](CONTRIBUTING.md) | the rules of the tree, test commands, commit style, reporting a security problem |
| [docs/ILERLEME.md](docs/ILERLEME.md) | the progress log, in Turkish: every decision and what was tried on which day |
| [app/CREDITS.md](app/CREDITS.md) | licenses and credits |

## in one minute

```bash
cd app && npm install && npx expo start      # the app without models (Expo Go, web)
cd app && npm run apk                         # the release apk with llama.cpp (Android SDK + JDK 17)
cd node && npm install && npm run build && node dist/bin/kula-node.js setup && node dist/bin/kula-node.js share
```

Install the apk, press *enter as demo*, measure the phone on the passport tab, download a
model that *fits*, start it, chat. Share a second phone and scan its code; start the model
again in *apart* mode. The guide has the rest.

## the rules it follows

- ggml's RPC server and the worker API listen on 127.0.0.1 only; the gate is the one port.
- Jobs are split, models are not: apart mode is the default when devices are joined; split
  mode is for one big model in one room.
- A download is kept only when its sha256 matches; a worker refuses a model whose checksum
  differs from what it was asked for.
- beyin v0 only checks and records; it hands out no work.
- llama.cpp is pinned (b11157) and fetched by script, never edited by hand.

## servers

A release apk talks to kula's own Supabase project (`app/.env.production`); development
talks to the Mac's local server (`app/.env.development.local`). With an empty production
env the apk is a **demo** that answers from an invented world on the phone. `npm run apk`
refuses to bake a build with the wrong server. Setting up the live project, once, is in
[docs/SERVERS.md](docs/SERVERS.md).

## license and credits

MIT for kula's own code. llama.cpp (MIT), the port from PrivateLM / llama_flutter_android
(MIT), the models under their own licenses: [app/CREDITS.md](app/CREDITS.md).
