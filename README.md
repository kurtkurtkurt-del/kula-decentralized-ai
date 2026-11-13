# kula decentralized ai

**[kula's site: kurtkurtkurt-del.github.io/kula-decentralized-ai](https://kurtkurtkurt-del.github.io/kula-decentralized-ai/) — the download links (Android app, Mac app, Linux app, kula-node) are there.**

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

## what's new in 0.4.0

- **Linux app.** kula installs on Ubuntu and Debian computers as a normal app (`.deb`, for Intel/AMD
  and ARM). So far it is tested only on GitHub's Ubuntu 24.04 test machines: it starts, and a small
  model loads and answers.
- **Better guesses about your devices.** kula guesses when each device will be free tonight. Every
  guessing method is now tested against recorded days, and a new method is kept only if it does
  better. The guesses are about twice as accurate as in 0.3.0 and adjust within days when your
  habits change. Speed and reach guesses now come with a range (80% likely to fall inside it).
- **Speed estimates for a model shared over the internet.** When one model is split across devices
  that are far apart, kula measures what each connection costs and says the expected speed as a
  range. On a far link its estimate was off by 179%; now by about 7%. It may pick a nearby phone
  over a faster device far away.
- **Warnings about phones in a split.** A phone that keeps dropping out gets a card; one that has
  worked for 25 minutes gets a rest warning. Its battery and night hours count.
- **Safety fixes between friends.** A friend's device that rewrites its own history is no longer
  shown as "all clear" (computer and phone). A suggestion card loads a model only on the device it
  names. The local page no longer gives its address to other programs. Device names cannot contain
  hidden characters. A normal day/night pattern no longer marks a device red.
- **You still decide.** kula watches, warns and suggests; nothing happens until you press.
- **Plan for reaching friends far away.** Research and a proposal for connecting devices over the
  internet without a kula server ([docs/network](docs/network/SUNUM.md)). No network code yet.
- **The phone app is unchanged.** It stays at 0.3.0; the phone-side fixes come with the next apk.

## what's new in 0.3.0

- **Suggestions you approve.** kula can now suggest or warn with a card on the brain panel
  (computer and phone). Nothing happens until you press it; then kula loads, unloads, downloads or
  looks again, the same as your own buttons. Cards come from real measurements, for example
  "Gemma 3 4B would run faster split over mac and tablet".
- **Only your devices and your friends'.** Each device is marked *home* (yours) or *circle* (a
  friend's); unknown devices take no part. Every request is sorted into private, friends-ok or
  world-ok by named rules, so a key, a password or a hidden instruction cannot leave unseen.
- **The phone has the same brain as the computer.** All twelve parts run on the phone too, from the
  same code, with the cards on the brain tab.
- **Last night in 30 seconds.** A replay shows which devices worked overnight, on what, and how many
  tokens (*replay* on the brain panel, or `kula-node brain replay`).
- **Proof that a phone's owner cannot see the job.** The phone proves it with Android's hardware key
  attestation (locked bootloader, verified boot, the official kula build); the security report shows
  it. 0.3.0 is the first apk signed with kula's own key: uninstall 0.2.0 first, because Android does
  not update an app signed with another key.
- **Plan for friends lending devices to each other.** The design for friends sharing their devices'
  night hours (offers, requests, spot checks, signed receipts, no money):
  [docs/BEYIN-NET.md](docs/BEYIN-NET.md), with a 20-home simulation. No network code yet.
- **MIT licence** for kula's own code.

## what's new in 0.2.0

- **The brain.** kula-node on the computer watches all your devices every 5 seconds. The chat page
  shows its twelve parts as a map around this computer.
- **A tamper-evident log.** Everything the brain saw and said is kept in a chained record; if a line
  is changed, the chain breaks and kula says so. It holds no prompts, answers, keys or addresses.
- **Photos in the computer's chat.** The **+** in the message box adds up to three photos and asks
  which vision model should look at them (SmolVLM 500M, SmolVLM2 2.2B, Gemma 3 4B).
- **A security report on the phone.** One verdict for the whole cluster (green: all clear, red: look
  at this), with each paired device's checks under it.
- **Remove a device's access.** A paired phone or computer can be unpaired, from the phone or from
  kula-node; it is refused from then on.
- **Desktop app.** kula's own icon, and a first start that lists what building llama.cpp needs
  (command line tools, cmake) before it begins.

## try it

Everything you need is on the GitHub release page: **Releases → latest** in the repository
(kurtkurtkurt-del/kula-decentralized-ai).

| for | file |
|---|---|
| an Android phone or tablet (arm64, Android 7+) | `kula-android.apk` |
| a Mac with Apple silicon, as an app | `kula-mac-arm64.dmg` |
| a Mac with Apple silicon, in the terminal | `kula-node-mac-arm64` |
| an Ubuntu or Debian computer (x64), as an app | `kula-linux-x64.deb` |
| an Ubuntu or Debian computer (ARM), as an app | `kula-linux-arm64.deb` |
| checking the downloads | `sha256sums.txt` |

Intel Mac and Windows files, and the Linux terminal file, are not on the release yet; build
them from source (`cd node && npm install && npm run pack:bin -- --target linux-x64,win-x64`).

The repository is public: every file downloads without a login.

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

### the computer, the easy way: the Mac app

Open `kula-mac-arm64.dmg` and drag **kula** to Applications. The app is not signed by an Apple
developer account, so the first time: right-click it → **Open** (on macOS 15: System Settings →
Privacy & Security → **Open Anyway**; if macOS still refuses, run
`xattr -cr /Applications/kula.app` in Terminal). The first start builds llama.cpp once on a start
screen (5–10 minutes). It needs Apple's command line tools and cmake, once, before that:
`xcode-select --install` and `brew install cmake ninja` (Homebrew: https://brew.sh). Then the
chat page opens in its own window.

### the computer, the easy way: the Linux app (Ubuntu, Debian)

Download `kula-linux-x64.deb` (on an ARM computer: `kula-linux-arm64.deb`) from the release and
install it in a terminal:

```sh
cd ~/Downloads
sudo apt install ./kula-linux-x64.deb      # apt also brings libgomp1, which llama.cpp needs
```

Then open **kula** from the app menu. The first start downloads llama.cpp b11157 (about 17 MB,
sha256-checked) instead of compiling it, and the chat page opens in its own window. Where
`nvidia-smi` works it downloads the CUDA build and its runtime instead: 763.9 MB on x64, 698.0 MB
on ARM. So far it is checked only on GitHub's Ubuntu 24.04 test machines (x64 and arm64, no
graphics card): first start, and a small model (Qwen3 0.6B) loaded and answered on the CPU. For
NVIDIA only the download, the sha256 sums and the place of the libraries are checked; no real
card has run it. Not yet on a real desktop, not yet in a cluster with a phone. There is no
AppImage for other distros yet.

### the computer, in the terminal (macOS shown; Linux and Windows the same with their file)

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
- Linux: the terminal file is not on the release yet; build it from source (above) or use the
  Linux app.
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

**The brain.** God's eye, the black box and the twelve branches: [the brain](#the-brain).

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

## the brain

**God's eye.** kula-node on the computer (the chat page, in the terminal or in the Mac app) runs
an observer called god's eye. Every 5 seconds it takes one look at the cluster — a copy of what
is there: the devices, the loaded model, the models on offer, the projects — and hands the same
look to twelve branches. A guard cleans every look before they see it: an entry of the wrong
shape is left out and counted, a look that makes no sense is skipped whole, and a branch that
breaks is stopped alone; nothing in a look can throw the eye off its tick.

**The twelve branches.** Each answers one question:

| branch | the question |
|---|---|
| senses | is each device there, how much memory is free, how fast does it answer? |
| memory | what happened and why? A change-only log of the devices, the model, the projects and kula's decisions; the phones keep their own signed ledgers. |
| forecast | when will each device be free tonight, and how fast? It guesses per hour of the week, with an 80% range. |
| learning loop | was the forecast right? Every finished hour it scores the guess against what happened, compares it with the device's own average, and tunes itself. |
| connections | how is each device reached: a usb cable, the wi-fi or a relay? It keeps the reach rate and the usual latency per kind, and says which kind has been steadier. |
| planner | where does the model sit, and why: on one phone, a copy on each (apart), or one model across them (split)? |
| executor | who is answering now, and how fast? |
| trust and verification | is the cluster safe? One verdict: every link encrypted with the pinned certificate, every device proving who it is, what its gate refused, and whether its signed ledger holds together. |
| limits | are the devices within what they can bear: memory, rest, energy? It warns; it never stops or slows anything. |
| models and device care | which model fits which device, and what does each device hold right now? |
| request review | is a night job safe and allowed to run? It looks for personal data, a relay, an unpinned certificate, a plan that does not add up; it says, and never blocks. |
| advisor | which model, which devices, which night, before you ask? It suggests in words and never loads or moves anything. |

**It watches and never acts on a device.** God's eye never loads or stops a model, never touches
a phone, sends nothing on the network. The only action a person can take on a branch's page is
the trust branch's "I cleared it"; the branch records that, and it never reaches a device.

**The black box.** Everything the eye saw and said goes into a hash-chained record in
`~/.kula-node/godseye/box/`: every look as the change against the last one (with a full picture
of the cluster now and then), every feed line, every trust verdict, the person's actions, and
its own start, stop and forget. Each record carries the hash of the record before it, and a
head file carries the last hash; a record that is changed, removed, inserted or reordered
breaks the chain from there, and the memory branch says so in the box's words. Nothing private
is written: no prompts, no answers, no keys, no addresses, no ledger lines, no project titles
or requests; text that could carry one is scrubbed before it is written. Retention is by size
(256 MiB), never by time, so a wrong clock cannot delete history.

**What is built, and what is not.** senses, memory, forecast, learning loop, connections, trust
and limits do real work today. planner, executor, models, request review and advisor are still
thin: they mostly describe the cluster as it is (where the model sits, who is answering, what is
held) or give simple advice or checks, and they never act. The chat page's brain panel draws the
twelve as a map around this computer, then four numbers, the branch that needs you most, the
notices and a live feed. Its **learn** tab lists papers, videos and courses on local AI.

The phone app has its own **the brain** tab: the cluster drawing, the planner's decisions, the
ledger, and **trust and verification**, the same security report as the computer's trust branch.
Code: [node/src/godseye/](node/src/godseye/).

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

MIT for kula's own code ([LICENSE](LICENSE)). llama.cpp (MIT), the
port from PrivateLM / llama_flutter_android (MIT), and the models under their own licenses:
[app/CREDITS.md](app/CREDITS.md).
