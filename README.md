# kula decentralized ai

**join your phones, tablets and computers into one local AI cluster that runs open models.**

kula runs a real language model (llama.cpp b11157) on an Android phone, and joins the phones,
tablets and computers in the same room into one cluster: a phone joins by scanning a QR code, a
computer joins with **kula-node** and its chat page. The devices talk to each other directly,
through one gated port each; no cloud and no outside server sit in the middle. Every worker
keeps a signed ledger of what it did, and at night the devices can work on a project you planned
while they charge.

| mode | what happens | when |
|---|---|---|
| **alone** | the model runs on one device only | one device, or the model fits and nothing else is joined |
| **apart** | every device loads its own copy; each prompt (or night job) goes to whichever device is free; the speeds add up | the default once devices are joined: more throughput, a slow device never holds a fast one back |
| **split** | one model's layers are spread over the devices through ggml's RPC backend | a model too big for any one device; devices in the same room, same network |

Be honest with yourself about split: a token is computed on the devices *one after the other*
and crosses the wi-fi at every hop, so over wi-fi it is **slower per token** than one device
that holds the whole model. It is for models that fit nowhere alone. **apart** is how you get
more out of more devices. The model page (and the chat page) shows each mode's estimated speed
and says when a device alone would be faster. Rule of thumb: jobs are split, models are not.

iOS is out of scope for now: the app opens on iOS but runs no models (a Swift module is written
on a branch, never built).

## try it

Everything you need is on the GitHub release page: **Releases → latest** in the repository
(kurtkurtkurt-del/kula-decentralized-ai).

| for | file |
|---|---|
| an Android phone or tablet (arm64, Android 7+) | `kula-decentralized-ai-<version>.apk` |
| a Mac with Apple silicon / an Intel Mac | `kula-node-mac-arm64` / `kula-node-mac-x64` |
| Linux (x86-64 / arm64) | `kula-node-linux-x64` / `kula-node-linux-arm64` |
| Windows | `kula-node-win-x64.exe` |
| checking the downloads | `sha256sums.txt` |

**While the repository is private**, the one-line installers in [docs/NODE.md](docs/NODE.md)
(`curl … | sh`, `irm … | iex`) cannot download anything: GitHub wants a login for a private
repo's files. Sign in on github.com and download the files in the browser instead.

### the phone (and tablet)

1. Download the apk on the phone (or copy it over), open it, and allow installing from that
   source when Android asks. The apk is **debug-signed** for now: it installs fine for testing,
   but a later properly signed build will not update over it (uninstall first then).
2. Open kula. No account is needed to run models or join devices.
3. **passport** tab → **measure**: a few seconds of measuring memory, bandwidth, cpu, heat.
   Everything about which model fits is read from this.
4. **models** tab (the tabs are *models · connect · the brain · projects · passport*): the
   catalog sorted for this phone (*fits*, *tight*, *does not fit*). Start small: scroll to
   **Qwen3 0.6B** (or Gemma 3 1B) and press its **download**. Downloads resume after a lost
   connection (*pause* / ×) and are kept only when their sha256 matches.
5. Open the model → **start** → *only this phone* → chat.
6. To join it to other devices: **share this phone** → **start sharing**. Android asks to let
   kula always run in the background; *allow* keeps sharing alive with the screen off. The
   screen then shows a QR, the phone's address and a one-time **code**.

Which model for which phone, and troubleshooting: [docs/GUIDE.en.md](docs/GUIDE.en.md).

### the computer (macOS shown; Linux and Windows the same with their file)

Checked on 8.11.2026 on an 8 GB MacBook Air (Apple silicon), starting from nothing in a fresh
folder, exactly as below:

```sh
xcode-select --install          # once, if the command line tools are missing (macOS compiles llama.cpp)
brew install cmake ninja        # once (needs Homebrew: https://brew.sh)

cd ~/Downloads
shasum -a 256 -c --ignore-missing sha256sums.txt     # optional: check the download
chmod +x kula-node-mac-arm64
xattr -d com.apple.quarantine kula-node-mac-arm64    # see below

./kula-node-mac-arm64 setup     # fetches llama.cpp b11157 (sha256-checked) and builds it: ~5–10 min, ~305 MB
./kula-node-mac-arm64 ui        # the chat page opens in your browser
```

- **Why `chmod` and `xattr`:** a file downloaded in a browser is not executable and is
  quarantined. Without `chmod +x` the terminal says *permission denied*; without the `xattr`
  line the process is just *killed* (macOS may also say the app "cannot be opened"). The binary
  is signed ad hoc, not by an Apple developer account.
- **First chat:** in the page, **start a chat** → pick a model (start with **Qwen3 0.6B**, 640 MB)
  → **here** (this computer only) → load. On the test Mac it answered at 35–64 tok/s.
- **If a model load says `aborted`**, the connection to Hugging Face dropped: press load again.
  It continues where it stopped (the file stays a `.part` until its sha256 matches).
- `setup` says up front what it will fetch and how big it is. Everything lands in
  `~/.kula-node/`. On Linux and Windows it downloads llama.cpp's release build instead of
  compiling (the CUDA build when `nvidia-smi` answers).
- The chat page lives at `http://127.0.0.1:50590/<random>/`, on this computer only. The address
  stays the same across restarts, so you can bookmark it. `ui --stop` (or ctrl-c) stops it.
- **settings** (bottom left) has the defaults, your custom instructions, **usage** (tokens per
  model, device and day, counted on this computer only), data controls and the `/v1` token
  (settings → developer; the start line only prints the token file's path).
- Windows: run `kula-node-win-x64.exe setup`, then `kula-node-win-x64.exe ui`. When the firewall
  asks, allow kula-node on **private** networks only.
- Running the file with no arguments shows a small menu; `info` prints what a cluster would
  see of this computer (RAM, memory bandwidth, gpu).

## join your devices

All devices on the **same wi-fi** (or on a phone's hotspot), all with kula installed.

**phone ↔ phone, in the app.** On the worker: **share this phone** → **start sharing**. It
shows a QR code with its name, free memory and bandwidth, plus a one-time pairing code; the
screen stays on while it shares (press *allow unrestricted battery* if the card asks). On the
phone you chat on: **connected devices** → **scan a code**. Then start a model again and pick
**apart** (or **split** for one big model). **batch test** in the chat sends eight prompts to
every device and shows who took how many.

**phone ↔ computer, from the chat page.** On the phone: **share this phone**. On the computer:
**start a chat** (or **devices → add a device**), then one question at a time:

- **usb cable**: needs adb, from Android's platform-tools (`brew install android-platform-tools`
  on a Mac, or Google's platform-tools download) and **USB debugging** on the phone (settings →
  about phone → tap *build number* seven times → developer options → USB debugging; tap
  *allow* on the phone). The page follows `adb devices` live, forwards a port to the phone over
  the cable, opens its share screen, and asks for the code the phone shows. No wi-fi involved.
- **same wi-fi**: the page lists the kula phones it hears on the network (or you type the
  address the phone shows), then you type the one-time code from the phone's screen. One code
  pairs the two for good; a code works once.

**A guest network keeps devices apart.** Guest, hotel, office, campus and many home wi-fis stop
devices from seeing each other ("client isolation"); nothing in kula can get around it. When
the page cannot reach the phone it says "this network keeps devices apart" and offers the
cable, or the **phone's hotspot**: turn it on, join it from the computer, restart sharing on
the phone (its address changes).

**Then pick a model.** In *start a chat* the models come by maker (Qwen, Gemma, Llama, Phi,
DeepSeek, …), then series, then model, with sizes and whether they fit; a model whose facts
are unknown or whose architecture b11157 cannot run is shown dimmed with the reason. Then how
it runs:

| choice | what happens |
|---|---|
| **on the phone** (recommended) | the phone downloads the model from its public Hugging Face address itself and runs it; the computer only carries the words |
| **apart** | every chosen device its own copy, each prompt to the fastest free one |
| **split** | the model on this computer, its layers spread over the phones by RPC (local network only) |
| **here** | only this computer runs it |

Split and here need `setup`. Answers stream with tok/s, time to first token and the device that
answered. The page also does **plan a project** (a night project, below), **invite a device**
(other devices on the wi-fi chat through a QR, nothing installed, plain http: use it on a
network you trust), and an OpenAI-compatible `/v1` endpoint for editors. All of it:
[docs/NODE.md](docs/NODE.md), "the chat page".

## how it works

**The gate.** ggml's RPC server has no authentication and lets a client write into its memory,
so it listens on **127.0.0.1 only**, on every device, and so does the worker's HTTP API. The
only port open to the network is the gate (50551). A master opens a local tunnel; the tunnel
does the handshake through the gate and then just pipes bytes. Protocol v2 is TLS 1.3 between
device certificates, pinned from the QR, with a one-time code for the first pairing (v1, a
shared secret and HMAC, still answers older masters). Nothing that binds RPC to a network
interface is ever right, whatever it fixes. [docs/GATE.md](docs/GATE.md)

**The planner.** A model fits a device when `file × 1.05 + kv cache for the context + 300 MB`
fits in what the device offers (70 % of this device's free RAM, 75 % of what a worker
advertised). In split mode the layers go to the devices by memory bandwidth, fastest first;
the input embedding and the output layer stay on the master. Because a token visits the
devices in turn, sharing between equally fast devices saves no time: only bytes moved to a
*faster* device help, and every extra device adds a network hop (three round trips each, every token).
So on a slow network the planner uses fewer devices, and when the split plan is not at least
1.15× faster than one device alone it says "alone is faster". [docs/PLANNER.md](docs/PLANNER.md)
(Turkish)

**Apart scheduling.** Every device has the whole model; each request goes to the device that
would *finish* it first (when it is free plus how long the request takes at its measured
tok/s). A short prompt takes the idle slow device rather than wait for the busy fast one; a
long one waits for the fast one. A device that drops before its first token is set aside for
five minutes and its prompt goes elsewhere once.

**Model files.** Downloads resume (`Range`) and are kept only when the sha256 matches the
catalog or Hugging Face's own record; until then the file stays a `.part`.

**Nights and the morning report.** On the phone: a kept project, the *work tonight* switch, the
night window, on charge, battery above your threshold, not hot, on wi-fi if you asked. Then it
runs the model in apart mode with every joined device that answers, unit by unit (some units
have a known answer, the check that a device answers honestly), pauses when a condition
breaks, continues the same pile when it holds again, and leaves a report in the morning: units,
checks right, tok/s per device, time, watt-hours. The app must stay open (Android does not let
an app run a model for hours in the background). On the computer, **plan a project** takes
what to do, from when until when, which model, which mode and which devices; the computer stays
awake until it ends and writes the morning report into that project's chat.
[docs/NIGHT.md](docs/NIGHT.md)

**God's eye (the brain).** The chat page's brain panel: twelve branches (senses, memory,
forecast, learning loop, connections, planner, executor, trust, limits, models, request review,
advisor) that look at a snapshot of the cluster every few seconds and say what they see.
It **watches and never acts**: it never loads or stops a model, never touches a phone, sends
nothing on the network. Some branches only describe what they will do later. Its **learn** tab
lists papers, videos, courses and posts on local, decentralized AI, in three levels. Code:
[node/src/godseye/](node/src/godseye/). The phone app has its own **the brain** tab with the
planner's decisions and the ledger.

**The signed ledger.** Every worker, phone or computer, writes each pairing, connection,
refusal, model load and health line to a hash-chained ledger signed with the device's own key.
`kula-node ledger --verify` walks the chain. [docs/AUDIT.md](docs/AUDIT.md)

**No outside server for the cluster.** Devices reach each other directly: a cable, the same
wi-fi, a hotspot. Models come from Hugging Face; prompts and answers go only to devices you
paired. A relay for two devices behind different networks exists in the repo
([docs/RELAY.md](docs/RELAY.md), apart mode only) but none is hosted and none is used by
default. The app's account and demo server is a separate thing that the cluster does not need:
[docs/SERVERS.md](docs/SERVERS.md).

Where the project stands (what is done, what has not yet run on a real phone, open decisions):
[docs/DURUM.md](docs/DURUM.md) (Turkish).

## build from source

```bash
cd app && npm install && npm run apk     # checks which server it bakes in, then builds dist/*.apk (Android SDK, JDK 17)
cd node && npm install && npm run build  # then: node dist/bin/kula-node.js setup / ui
```

Without the native module (Expo Go, iOS, the web) the app runs but downloads no models:
`cd app && npx expo start`. Rules of the tree, tests, commit style: [CONTRIBUTING.md](CONTRIBUTING.md).

## what is in the repository

| folder | what |
|---|---|
| [`app/`](app/) | the Expo app (Android first): models tab with the catalog and Hugging Face search, model pages and the mode question, chat, share this phone / add a device by QR, connected devices, the passport (the phone's measurement), the night and its morning report, the brain tab, the audit page |
| [`app/modules/kula-llama/`](app/modules/kula-llama/) | the native module: llama.cpp over JNI, the worker in its own process, the gate (v1 HMAC, v2 TLS), resumable sha-checked downloads, the relay client, the auditor and ledger |
| [`app/modules/passport-measure/`](app/modules/passport-measure/) | the bridge to device-passport's measurement (compiled in, never copied) |
| [`node/`](node/) | **kula-node**: a Mac, Linux or Windows computer as a worker behind the same gate or as the device that runs a cluster; the chat page (`node/src/ui/`), god's eye (`node/src/godseye/`), a local dashboard |
| [`node/relay/`](node/relay/) | **kula-relay**: a blind WebSocket pipe between two devices behind NAT |
| [`packaging/`](packaging/) | the install scripts, homebrew formula and winget drafts |
| [`backend/`](backend/) | kula's Supabase project: schema, rules, edge functions, a local dev server, tests |
| [`web/`](web/) | the Mac passport script and a computer's passport page |
| [`tools/`](tools/) | planner vectors shared by app and node, the docs link check, the Mac script build |
| [`docs/`](docs/) | the documentation: start at [docs/README.md](docs/README.md) |

## documentation

| read | for |
|---|---|
| [docs/README.md](docs/README.md) | the index of every page |
| [docs/GUIDE.en.md](docs/GUIDE.en.md) · [docs/GUIDE.tr.md](docs/GUIDE.tr.md) | the user guide, in English and in Turkish |
| [docs/DURUM.md](docs/DURUM.md) | where the project stands (Turkish): done, not yet run on a device, open decisions |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | how it is built |
| [docs/NODE.md](docs/NODE.md) | kula-node: install, commands, the chat page, beyond the local network |
| [docs/HISTORY.md](docs/HISTORY.md) | where it came from: the afterhours fork, the demo world, the simulated night |
| [CONTRIBUTING.md](CONTRIBUTING.md) | the rules of the tree, tests, commit style, reporting a security problem |
| [app/CREDITS.md](app/CREDITS.md) | licenses and credits |

## license

MIT for kula's own code (a LICENSE file at the root is still to be added). llama.cpp (MIT), the
port from PrivateLM / llama_flutter_android (MIT), and the models under their own licenses:
[app/CREDITS.md](app/CREDITS.md).
