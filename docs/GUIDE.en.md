# user guide

How to use kula decentralized ai on a phone: install it, measure the phone, pick a model,
chat, join two phones, add a computer, let it work at night, and what to do when something
does not connect. Türkçesi: [GUIDE.tr.md](GUIDE.tr.md). How it is built: [ARCHITECTURE.md](ARCHITECTURE.md).

## 1. install

kula is an Android app (arm64, Android 7 and newer). There is no store listing yet; you
install the apk by hand.

1. Get `kula-decentralized-ai-<version>.apk` (built with `npm run apk` in `app/`, see
   [../CONTRIBUTING.md](../CONTRIBUTING.md); the file is about 85 MB because it carries
   llama.cpp for four cpu variants).
2. Copy it to the phone (USB, a message to yourself, a download) and open it. Android asks
   once to allow installs from that source.
3. Open kula. On the first screen press **enter as demo**: no account is needed to run
   models or join devices. The e-mail form is behind "I have an account".

The same apk runs on a tablet. There is no iOS build; on iOS, in Expo Go and in the browser
the app opens but says "models run only in the android app".

Every build talks either to a demo world on the phone or to kula's own server; settings →
app → server says which. Models and devices work the same either way.

## 2. measure the phone

Passport tab → **measure**. The phone measures its own memory, memory bandwidth, cpu,
compute, disk, battery and heat in a few seconds and shows the result as a card: the
largest model that fits and a rough tokens-per-second figure. Everything about fitting a
model is read from this card, so do it first; the models tab will ask for it otherwise.

Measure again after a reboot or when the phone was hot: a measurement taken while the phone
was throttling marks it as hot, and the night will not start on a hot phone.

## 3. choose a model

Models tab. The list is sorted for *this* phone: **fits**, **tight**, **does not fit**, with
"needs ~N MB, this phone gives M MB" under each. The line at the top says how much disk is
free and offers **delete unused** when old downloads pile up.

Which model for which phone:

| phone | start with | also good |
|---|---|---|
| old or small, 3–4 GB RAM | Qwen3 0.6B | Gemma 3 1B |
| 4 GB | Gemma 3 1B, Qwen2.5 1.5B | Llama 3.2 1B |
| 6 GB | Qwen2.5 1.5B, Qwen3 1.7B | Llama 3.2 3B |
| 8 GB and up | Llama 3.2 3B, Qwen3 4B, Phi-4 mini | Qwen2.5 7B together with another device |
| two or three phones, or a phone and a computer | Qwen2.5 7B in split mode | any of the above in apart mode |

What each model in the catalog is for (the same text is on each model's page, in English,
German and Turkish):

| model | size | good at | use it for |
|---|---|---|---|
| Qwen3 0.6B | 0.6 GB | short answers, lists, simple rewrites; fluent for its size in English and Turkish; weak at maths and long reasoning | trying the app, old or small phones, a first night job (classifying short texts, tagging); the fastest download |
| Gemma 3 1B | 0.8 GB | clean short prose, summaries of a paragraph, questions over a short text; 140 languages | summarising and translating short texts on a 4 GB phone; a night job that reads a lot and writes little |
| Llama 3.2 1B | 0.8 GB | English instructions, simple extraction (names, dates, fields), friendly chat | structured extraction in English on small phones; pairs well with a bigger model on a computer |
| Qwen2.5 1.5B | 1.1 GB | balanced: writing, summaries, light code, 29 languages incl. Turkish and German; follows formats (json, lists) | the everyday choice on a 4–6 GB phone; night jobs that need json output |
| Qwen3 1.7B | 1.8 GB | reasons step by step before answering (`/no_think` switches it off); better maths and logic than the 1B class; good Turkish | questions that need a little thinking on a 6 GB phone; slower per answer, not for bulk tagging |
| Llama 3.2 3B | 2.0 GB | a solid general assistant in English: longer answers, rewriting, instructions, some code | a 6–8 GB phone as the main device; English writing jobs at night |
| Qwen3 4B | 2.5 GB | close to last year's 7B models: reasoning, code, multilingual writing, long context; thinking on by default | the best a flagship phone runs alone; harder night jobs (evaluation, distillation); warm phone, slower |
| Phi-4 mini | 2.5 GB | maths, logic puzzles, code; terse and precise; weaker at casual chat and Turkish | code and maths on an 8 GB phone; grading answers with a known solution |
| Qwen2.5 7B | 4.7 GB | a real assistant: long documents, careful writing, code, 29 languages; a step above everything else here | too big for one phone: split mode across two or three phones, or apart mode with a computer |

Press **download**. A download survives a killed app and a lost connection; it continues
where it stopped and is only kept when its checksum matches. Each model links to its
license; read it once.

**Search Hugging Face** below the catalog finds any GGUF repository. Prefer files named
`Q4_K_M` (the usual balance) or `Q8_0` (bigger, a little better); the filter chips do that.
A repository marked gated needs a Hugging Face sign-in and cannot be downloaded from the
app; "read the license" opens its page. Multi-part files (`-00001-of-0000n`) are downloaded
as one model.

### the model page and the mode question

Open a model → **start**. The app asks *how should it run?*

- **only this phone**: fastest; nothing crosses the network.
- **apart: a copy on every device**: each device runs its own copy, the work is shared out,
  the speeds add up. This is how kula works at night, and the default once devices are
  joined. Beyin's rule: jobs are split, models are not.
- **split: one model across the devices**: a bigger model than any device holds alone, but
  every token crosses wi-fi. Only for devices in the same room. Choosing split means
  sharing the model, even when the estimate says it would fit here.

The page also lets you set the **context** (how much of the conversation the model
remembers, in tokens; more costs memory; the suggested value is the largest that fits, at
most 4 096) and shows the expected speed. After loading it says where the layers sit and
which devices were left out and why.

## 4. chat

Chat opens from the model page or the tab bar. Type, send, **stop** to cut an answer short,
**new chat** to clear the context. Under each answer: tok/s, time to the first token, token
count and which device answered. The input stays above the keyboard.

**batch test** sends eight short prompts to every device at once and prints how many
replies came back in how many seconds and the combined tok/s. It is the quickest way to see
whether a second device is really helping.

Qwen3 models think before they answer; put `/no_think` at the start of a message to skip it.

## 5. join two phones, step by step

Both phones on the **same wi-fi**, both with kula installed. One will be the *master* (where
you chat), the other the *worker* (it lends its processor).

On the worker:

1. Open kula → **share this phone**.
2. Press **start sharing**. A QR code appears with the phone's name, free memory and
   bandwidth. The screen stays on while sharing; the phone works at full speed only then.
3. If the card says "android is slowing this phone down", press **allow unrestricted
   battery** and confirm.

On the master:

4. **connected devices** → **scan a code** → point the camera at the worker's QR. The worker
   appears in the list as *reachable*. **find nearby** lists phones that share on this wi-fi
   but you still need to scan the code once; it carries the pairing.
5. Models tab → a model → **start** → **apart** (or **split** for one big model). "reaching
   the devices…", then "loading the model…". In apart mode the worker downloads the same
   model the first time, which takes as long as the download did on the master.
6. Chat. The device line under an answer names the phone that produced it; **batch test**
   shows both working.

On the worker's screen, "working for <name>" and the counts of connections and refusals
appear. **stop sharing** ends it; the master then marks the device as not reachable and
carries on alone.

With the newer builds (gate v2) the QR also carries a one-time pairing code; it is used
on the first connection and the two phones remember each other's certificate from then
on. An older master still pairs with the shared secret in the same QR.

## 6. add a computer

A computer joins through **kula-node**, a small command-line program in this repository
(Mac, Linux, Windows). Full reference: [NODE.md](NODE.md).

```bash
cd node
npm install
npm run build
node dist/bin/kula-node.js setup     # fetches llama.cpp, once
node dist/bin/kula-node.js share
```

`share` prints a QR in the terminal. On the phone: connected devices → **scan a code**. The
computer appears as a *computer* with its RAM and bandwidth. From here it behaves like a
second phone: apart mode sends it prompts, split mode puts most of the model's layers on it.
The first time, the computer downloads the model into `~/.kula-node/models`.

Allow the firewall prompt for the gate port (50551). Without a camera on the other side,
`share --no-qr` prints the JSON and the phone's **paste** button takes it.

The computer can also run the cluster itself, with the phones as workers:
`kula-node peers add`, `kula-node chat --mode apart --batch` ([NODE.md](NODE.md)).

## 7. the night

Keep a project on its page (the network tab lists projects per city; friends' kept projects
are on the people tab). The passport card has a **work tonight** switch and
shows the state: waiting and why, running with the counters, or last night's line.

A night starts when all of these hold: the switch is on, a project is kept, the phone was
measured, the clock is inside your night window (profile), the phone is charging ("only on
charge" in settings, on by default), the battery is above your threshold (20, 30, 50 or 80 %,
default 30), the last measurement was not hot, and you are on wi-fi if you asked for that.
When one breaks the night pauses and keeps what it did; when it holds again the same night
continues.

What it does: it loads your chosen model (or the largest that fits) in apart mode with
every device you joined that answers, and works through a pile of short units, one per
device at a time. Some units have a known answer; those are the check that the device is
answering honestly.

**The app must stay open.** Android does not let an app run a model for hours in the
background. The real worker keeps the screen on (dimmed) while it runs; if you lock the
phone by hand the night pauses and continues when you open the app. A silent notification
says it is running. Plug the phone in, open kula on the passport tab, put it face down.

In the morning the report shows units, the share of checks that were right, tok/s per
device, time worked, watt-hours and how it compares with your previous nights. Details:
[NIGHT.md](NIGHT.md).

## 8. troubleshooting

**The master cannot see or reach the worker.**
- Same wi-fi? Phones on a guest network or on mobile data cannot see each other. The share
  screen warns "not on wi-fi".
- **Client isolation** (also called AP isolation): many routers, almost every hotel, café
  and campus network, and many guest networks forbid devices from talking to each other.
  Nothing in kula can get around it. Use your own router, or a **phone hotspot**: open a
  hotspot on one of the phones (it can be the worker) and connect the other devices to it;
  the hotspot owner has an address like 192.168.43.x or 10.x and the others reach it.
- The QR carries the worker's address at the moment it was shown. If the worker's address
  changed (new network, a day later), scan again; the same device replaces its old entry.
  **check** on the peers screen tries again.
- A computer: the firewall must allow TCP 50551 in.
- Press **find nearby** on the master; a worker that shows up there but cannot be reached
  after scanning is almost always client isolation.

**"busy".** The worker's rpc channel takes one master at a time. Another phone is in split
mode with it, or a stale connection has not timed out yet. Stop and start sharing.

**"channel closed".** The worker is up but has nothing on that channel yet: in apart mode
it has not loaded a model, in split mode its rpc server has not started. Start the model on
the master again.

**"wrong secret" / "not paired" / "fingerprint mismatch".** The code on the master is from
an earlier sharing session. Scan the QR the worker shows now.

**"too big even for all these devices together".** Choose a smaller model, lower the
context, or add a device. Split mode counts 70 % of this phone's free memory and 75 % of
what each worker advertised.

**It is slow.**
- A worker in the background gets only the slow cores. Keep kula on the worker's screen,
  and set **allow unrestricted battery**.
- Split mode moves every token over wi-fi; a 2.4 GHz network or a far router can make a
  model ten times slower than apart mode. Prefer apart mode unless the model does not fit.
- Loading in split mode streams the model's layers to the worker first: a gigabyte over a
  good wi-fi is a minute, over a bad one many.
- A hot phone halves its speed. Let it cool, take the case off.

**Battery optimisation kills the worker or the night.**
- Settings → apps → kula → battery → **unrestricted**. The share screen has a button for it.
- **Samsung:** Settings → battery and device care → battery → background usage limits:
  remove kula from "sleeping apps" and "deep sleeping apps", add it to "never sleeping
  apps"; also turn off "adaptive battery" and "put unused apps to sleep" while testing.
- **Xiaomi / Redmi / Poco:** autostart on, battery saver "no restrictions", lock the app in
  recents.
- **Huawei / Honor:** app launch → manage manually, all three on.
- **OnePlus / Oppo / Realme:** battery optimisation → don't optimise; "intelligent control"
  off.
- The phone must be **charging** for the night (default); a slow charger that does not keep
  up with the model counts as charging but drains, so use the phone's own charger.

**The download fails or stops.**
- "connection lost, retrying" is normal; it continues where it stopped, also after a kill.
- "failed" with a checksum: the file on the server changed or the download was corrupted;
  delete and download again.
- "not enough free space": the list says how much is missing; **delete unused** frees old
  models.
- A Hugging Face repository that answers "gated" needs a sign-in on their site and cannot
  be fetched from the app.

**Notifications.** The night's sticky notification needs the notification permission; the
night runs without it.

**The screen says "models run only in the android app".** You are in Expo Go, on iOS or in a
browser. Install the apk.

## 9. faq

**Does it work with someone in Berlin while I am in Munich?** Not out of the box. kula v0 is
a local cluster: devices find and reach each other on one wi-fi. There is no kula relay yet.
If both of you join the same private network (Tailscale, ZeroTier, a WireGuard VPN), the
gate port is reachable and a computer can be added by address (`kula-node peers add
<ip>:50551:<secret>`, or paste the QR with the `host` changed); then use **apart** mode only,
never split, and prefer the TLS gate (v2) so prompts are not plain text on the way. A relay
that forwards gate connections between two phones is the planned next step; it needs no
change to the protocol. See [NODE.md](NODE.md), "beyond the local network".

**Does anything leave my phone?** Models come from Hugging Face. Prompts and answers go only
to devices you paired. The night's results stay on the phone in v0; the report goes to the
server only in the demo build. The passport and the night's totals go to your account as
before. The ledger (settings → app → beyin audit) stays on the device until you export it.

**Can the other phone read my chats?** In apart mode the worker runs your prompt, so yes,
that device sees it. Pair only devices you trust. With gate v1 the prompt is plain text on
the wi-fi between the two; gate v2 encrypts it.

**Why is apart the default and not split?** Because jobs split well and models do not: in
apart mode a slow device never holds a fast one back, a device that drops costs one unit,
and only prompts cross the network. Split is for the one case it is good at, a model that
fits nowhere alone, and it needs the same room.

**Which phone should be the master?** The one you are holding. Speed in apart mode is the
sum; in split mode the master keeps the output layer and the fastest device should hold
most of the model, which the planner does by itself.

**How much power does a night take?** The report says: hours × the phone's measured watts
(3 W assumed until measured). A phone at 3–4 W for six hours is about 20 Wh, a fiftieth of
a kWh.

**Can I use my own GGUF?** Search Hugging Face from the models tab, or put a repository's
file in the search. Files copied onto the phone by hand are not picked up yet.

**What is beyin?** The independent checker. v0 only records: every connection, refusal, model
load and health line goes into a signed, chained ledger on the worker, and the peers screen
shows a badge per device from it. [AUDIT.md](AUDIT.md).
