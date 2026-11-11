# kula field test: one hour, any devices, one report

**For the person (TR):** Bu dosyayı kendi yapay zekâna ver (Claude Code, Codex, Cursor gibi
bilgisayarında komut çalıştırabilen biri en iyisi; yalnız sohbet edebilen bir AI da olur, o zaman
adımları sana söyler, sen yaparsın). Telefonlarını ve bilgisayarlarını aynı wi-fi'ye al, şarja tak,
"bu dosyadaki testi yap" de. Bir saat sürer. Sonunda tek bir rapor dosyası çıkar; onu Ahmet'e
gönder. Raporda adın, adresin, şifren, yazdıkların yok: yalnız cihaz modelleri ve ölçümler var.

**For the person (EN):** Give this file to your own AI assistant (one that can run commands on your
computer is best; a chat-only one works too and will walk you through). Put your phones and
computers on the same wi-fi, on power, and say "run the test in this file". It takes an hour and
ends in one report file. Send that file back. It holds device models and measurements, nothing
personal.

Everything below is for the AI.

---

## what this is

kula joins phones, tablets and computers into one local AI cluster that runs open models
(llama.cpp); nothing goes to a cloud. Code and downloads:
https://github.com/kurtkurtkurt-del/kula-decentralized-ai (README: how to install and join).

A handful of friends are trying it on whatever devices they own. Nobody knows yet which
combinations work. Your job is to find out for **this person's devices**, in **60 minutes**, and
write it down in a form that can be compared with everyone else's. A failed step, written down
exactly, is worth as much as a passed one: do not hide, retry forever or work around a failure;
record it and move on.

Speak with the person in their language, in short plain sentences. They may not be technical.

## rules (they keep the person safe; follow them over finishing a test)

1. **Ask before** every install, every download over 100 MB, and anything that changes a setting.
   Say what, how big, and why, in one line.
2. **Never**: `sudo`, rooting, unlocking a bootloader, turning off a security feature, touching
   files outside kula's own folders (`~/.kula-node`, the folder you downloaded into), deleting
   anything the person did not ask you to delete.
3. **Never run** kula with `--no-tls`, `--secret`, `--map-port`, `--relay` or `--lan`. The test
   stays on the home network, encrypted, with nothing opened to the internet.
4. **Nothing personal in the report**: no names, e-mail, IP or MAC addresses, serial numbers,
   pairing codes, QR contents, certificate fingerprints, tokens, file paths with a user name, and
   no text the person typed other than the fixed test prompts. Call devices A, B, C. (The one
   exception: the first name or nickname the person picks for the file name, section 0.)
5. **Only the fixed prompts** below go into a model. Do not read the person's chats or files.
6. **Stop a device's tests** when its battery is under 20% and not charging, or it feels hot to the
   person (or reports over 45 °C). Write that down as a result.
7. **Time box**: a step that is stuck for 5 minutes is recorded as `fail` or `skipped` with the
   reason, and you go on. At 55 minutes, stop testing and write the report with what you have.
8. If you cannot run commands yourself, be the guide: tell the person each step, ask them to paste
   or read out what they see, and fill the same report.

## the fixed prompts

- P1: `Name three fruits.`
- P2: `What is 17 times 6? Answer with the number only.`
- P3: `Write two sentences about the sea.`

## plan and time

| minutes | phase |
|---|---|
| 0–5 | 1. inventory: what devices, what state |
| 5–20 | 2. install kula on each, one model each |
| 20–30 | 3. each device alone |
| 30–48 | 4. join them: every pair you have time for |
| 48–55 | 5. the brain and the security report |
| 55–60 | 6. write the report, tidy up |

Note the clock time when each phase starts and ends.

## 0. the live report (before anything else)

The person watches the report fill in while you test. Before the inventory:

- Ask the person's first name (or a nickname) and which test this is for them (1, 2, …). The
  report is named `<name>v<n>`, for example `selcukv1.pdf`; the name is the only personal thing
  in it, and only because the person chose it.
- Get the renderer: `docs/field-test/render.mjs` and `docs/field-test/template.html` from the
  repository (or `curl -LO` them from
  `https://raw.githubusercontent.com/kurtkurtkurt-del/kula-decentralized-ai/main/docs/field-test/<file>`).
  It needs Node 18 or newer and, for the pdf, any Chromium-family browser (Chrome, Edge, Brave,
  Chromium); without one it still writes the html.
- Write `<name>v<n>.json` in the shape of the data block (section 6) with `"status": "running"`,
  the date and start time, and whatever you know so far, then run
  `node render.mjs <name>v<n>.json`. It writes `<name>v<n>.pdf` (page 1: the score sheet; then
  this protocol), `<name>v<n>.html` (refreshes itself every 5 s while the status is running) and
  `<name>v<n>.md` (the report file of section 6). Open the pdf or the html for the person now.
- **After every T step**: put its result into the json and run `render.mjs` again, so the page the
  person is looking at is never more than one step behind. At the end set `"status": "done"`.

## 1. inventory (5 min)

Ask which devices take part (at least one; two or more is the point). For each, record:

- kind (phone, tablet, laptop, desktop), brand and model, year if known
- OS and version; CPU / chip name and core count; GPU if any
- RAM total and free; storage total and **free**
- battery % and whether it is charging; how it is connected (wi-fi, phone hotspot, usb cable)

Computer: `uname -a`, `sysctl -n machdep.cpu.brand_string hw.memsize hw.ncpu` (macOS),
`lscpu`, `free -m`, `df -h ~` (Linux), `systeminfo` (Windows). Android phone: Settings → About
phone and Settings → Storage, read by the person; or, if `adb` is already installed and the person
agrees to turn on USB debugging: `adb shell getprop ro.product.model`, `ro.build.version.release`,
`ro.soc.model`, `adb shell cat /proc/meminfo | head -3`, `adb shell df /data`,
`adb shell dumpsys battery`. Do not install adb just for this.

A device with under 3 GB free storage: do not download a model on it; record `skipped: no space`.

## 2. install (15 min)

Record for every step: `ok` / `fail` / `skipped`, how many minutes it took, and on a failure the
exact error text (first 10 lines) and what the screen said.

**Computer.**
- Mac with Apple silicon: download `kula-node-mac-arm64` and `sha256sums.txt` from
  `https://github.com/kurtkurtkurt-del/kula-decentralized-ai/releases/latest/download/<file>`,
  check the sha256, `chmod +x`, `xattr -d com.apple.quarantine kula-node-mac-arm64`. Call it
  `kula-node` below. (The same release has `kula-mac-arm64.dmg`, the app with its own window: ask
  the person to install it too if they like; drag to Applications, right-click → Open.)
- Any other computer (Intel Mac, Linux, Windows): from source. Needs git and Node 20 or newer
  (ask before installing either). `git clone https://github.com/kurtkurtkurt-del/kula-decentralized-ai`,
  `cd kula-decentralized-ai/node && npm install && npm run build`; `kula-node` below is then
  `node dist/bin/kula-node.js`.
- `kula-node --version --json` and `kula-node info --json` (keep both outputs for the report;
  drop the address fields).
- `kula-node setup --dry-run` (shows what it would fetch), then with the person's yes
  `kula-node setup`. On macOS it compiles llama.cpp (5–10 min; needs Apple's command line tools
  and cmake: `xcode-select --install`, `brew install cmake ninja`, ask first). On Linux and
  Windows it downloads a ready build. If it fails, the computer can still drive phones: go on.
- The model: `Qwen3-0.6B-Q8_0.gguf`, 640 MB, from
  `https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf` into
  `~/.kula-node/models/` (make the folder). Its sha256 must be
  `9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031`. Record seconds and MB/s.

**Android phone or tablet** (arm64, Android 7 or newer; iPhones cannot run models yet: record
`skipped: ios`).
- The person opens the release page on the phone, downloads `kula-android.apk`, opens it and
  allows installing from that source. An older kula on the phone must be uninstalled first
  (this version is signed with a new key).
- Open kula. **passport** tab → **measure**. Record what it shows: memory, bandwidth, the
  biggest model it says fits.
- **models** tab → **Qwen3 0.6B** → **download**. Record seconds, and whether it resumed after
  any interruption.

## 3. each device alone (10 min)

**Computer:** `kula-node bench --model ~/.kula-node/models/Qwen3-0.6B-Q8_0.gguf --no-apart --no-split --json`.
Keep the whole JSON record for the report (it has prompt and generation tok/s, memory bandwidth).
Then the person opens the chat page (`kula-node ui`, or the kula app): **start a chat** → Qwen3
0.6B → **here** → send P1. Record: did it answer, the tok/s the page shows, anything odd on screen.

**Phone:** open the model → **start** → *only this phone* → send P1, P2, P3. Record whether each
answered sensibly and the tok/s shown. Then settings → **measure speed** → run it → **share as
json**: get that JSON into the report (the person can send it to the computer any way they like;
if that is a bother, copy the numbers shown on screen).

## 4. join them (18 min)

Test as many **pairs** as time allows, in this order: phone + computer, phone + phone,
computer + computer, then three or more together. For each pair record: the link (same wi-fi,
hotspot, usb cable), which way of pairing you tried, whether it worked, how many tries, how many
seconds, and every error message.

**Pairing a phone with a computer** (try the first way; if it fails, record it and try the next):
1. On the computer's chat page: **devices → add a device**. It shows a QR code. On the phone:
   **let my computers use this phone** (or **share this phone**) and scan the QR.
2. On the phone: **share this phone → start sharing**; it shows a QR and a code. On the computer's
   chat page: **add a device** → paste the code. Or in the terminal: `kula-node peers add <code>`.
3. USB cable (needs adb and USB debugging; only if the person already has them): the chat page's
   **usb cable** step.

Labels in the app may differ a little from these words: say what you actually saw.

**Then measure**, on the computer:
- `kula-node peers probe --json` (both channels should answer; keep the result without addresses)
- `kula-node bench --model ~/.kula-node/models/Qwen3-0.6B-Q8_0.gguf --json` (with paired devices
  it also measures each device in *apart* mode, a *split* load, the gate round trip and the tunnel
  speed; keep the whole record)
- `kula-node chat --model ~/.kula-node/models/Qwen3-0.6B-Q8_0.gguf --mode apart --batch`
  (eight prompts, prints who answered how many and each device's tok/s)
- `kula-node chat --model ~/.kula-node/models/Qwen3-0.6B-Q8_0.gguf --mode split --prompt "Name three fruits."`
  (one model across the devices: does it answer, how long did loading take)

**Phone + phone:** on one, **share this phone → start sharing**; on the other, **connected
devices → scan a code**; start Qwen3 0.6B in **apart**; in the chat, **batch test**. Record who
took how many prompts and the tok/s shown; then try **split** once.

**Computer + computer:** on one `kula-node share` (it prints a code); on the other
`kula-node peers add <that code>`, then the same three measurements as above.

If there is time left, with the person's yes: a bigger model that the app marks as fitting
(record which and its tok/s), and ten more minutes of `--batch` three times in a row to see
whether speed falls as devices warm up.

## 5. the brain and the security report (7 min)

- Computer chat page, the panel on the right (**the brain**): how many of the twelve branches
  are lit; the **trust** branch's verdict (all clear / look at this / not checked yet) and its
  line per device; any **suggestion cards** on top (copy their titles; press one harmless one,
  such as "look again", and say what happened).
- `kula-node ledger --verify` (the last line says whether the chain holds).
- Phone, **the brain** tab: does it show the twelve branches, a trust verdict, cards.
- Remove one device's access (computer: `kula-node paired list`, then on the phone or with
  `kula-node paired remove <first 6+ characters>` for a device the person picks), then check that
  device is refused. Pair it again afterwards if the person wants it back.
- Optional, 545 MB more, only with a yes: in the chat page settings pick the vision model
  SmolVLM 500M, fetch it, send any harmless photo (a cup, a street sign) with "What is in this
  picture?" and record whether the answer fits.

## 6. the report (5 min)

Stop anything you started (`ctrl-c` on `kula-node share` and `chat`; `kula-node ui --stop` if the
person does not want the page left running). Ask whether to keep or remove the downloaded model
and kula itself; remove only what they say.

The report is the `<name>v<n>.md` that `render.mjs` writes from the json (section 0), next to
its pdf. If you could not run the renderer, write `<name>v<n>.md` by hand in the folder you
worked in, with exactly these parts:

1. **Summary**, five lines: the devices (as A, B, C with kind and model), what worked, what did
   not, the fastest tok/s seen and where, the single most important problem.
2. **Checklist**: every row below with `pass`, `fail`, `skipped` or `not tried`, and a few words.
3. **Problems**: one block each: the step (its T number), what was expected, what happened, the
   exact error text, whether it happened again on a second try, what got around it (if anything).
4. **The person's own words**: ask them two questions and write the answers as they said them:
   "What was the most confusing moment?" and "What would you want it to do that it does not?"
5. **Data**: one fenced `json` block in the shape below, then the raw bench records (computer
   and phone) each in its own fenced block.

Checklist rows (keep the numbers; they are how reports are compared):

| # | what |
|---|---|
| T01 | computer: kula-node starts (`--version`) |
| T02 | computer: `info` reports memory, bandwidth, gpu |
| T03 | computer: `setup` gets llama.cpp ready |
| T04 | computer: model downloaded, sha256 right |
| T05 | computer: bench alone gives tok/s |
| T06 | computer: chat page (or app) opens and answers P1 |
| T07 | phone: apk installs and opens |
| T08 | phone: passport measure |
| T09 | phone: model downloads |
| T10 | phone: chat alone answers P1–P3 |
| T11 | phone: measure speed gives a record |
| T12 | phone + computer: pairing |
| T13 | probe: both channels answer |
| T14 | apart mode: every device answers |
| T15 | split mode: one model across devices answers |
| T16 | phone + phone: pairing and batch test |
| T17 | computer + computer: pairing and bench |
| T18 | usb cable pairing |
| T19 | computer: brain panel, trust verdict, ledger verifies |
| T20 | phone: brain tab, twelve branches, trust verdict |
| T21 | a suggestion card appears and applies |
| T22 | removing a device's access: it is refused afterwards |
| T23 | a photo read by a vision model |
| T24 | three or more devices together |
| T25 | speed holds over ten minutes (no big fall from heat) |

The data block:

```json
{
  "protocol": "kula-field-test/1",
  "tester": "selcuk", "test": 1, "status": "running",
  "date": "2026-11-12", "started": "19:05", "ended": null,
  "minutes": 58,
  "ai": "which assistant ran this, and whether it ran commands itself or guided",
  "kula": { "node": "0.3.0", "app": "0.3.0" },
  "devices": [
    {
      "label": "A", "kind": "phone", "brand": "Samsung", "model": "Galaxy S25+", "year": 2025,
      "os": "Android 15", "chip": "Snapdragon 8 Elite", "cores": 8, "gpu": null,
      "ram_total_mb": 12000, "ram_free_mb": 5200,
      "storage_total_gb": 256, "storage_free_gb": 91,
      "battery_start": 80, "battery_end": 71, "charging": true, "felt_hot": false,
      "link": "wifi",
      "install": { "result": "pass", "minutes": 3, "note": "" },
      "setup": { "result": "skipped", "minutes": 0, "note": "phone" },
      "download": { "file": "Qwen3-0.6B-Q8_0.gguf", "seconds": 95, "mb_per_s": 6.7 },
      "passport": { "mem_bw_gbs": 61, "largest_fits": "Gemma 3 4B" },
      "alone": { "prompt_tok_s": 210, "gen_tok_s": 38, "p1": "pass", "p2": "pass", "p3": "pass" },
      "biggest_model_run": { "name": "Qwen3 0.6B", "gen_tok_s": 38 }
    }
  ],
  "combinations": [
    {
      "devices": ["A", "B"], "link": "wifi",
      "pairing": { "way": "computer shows qr, phone scans", "result": "pass", "tries": 1, "seconds": 25 },
      "probe": { "rpc": "pass", "api": "pass", "gate_ms": 14 },
      "apart": { "result": "pass", "tokens_total": 1900, "seconds": 22.4, "tok_s": { "A": 36, "B": 52 }, "prompts": { "A": 3, "B": 5 } },
      "split": { "result": "pass", "load_seconds": 21, "tok_s": 11 },
      "tunnel_mb_s": 38,
      "trust_verdict": "all clear",
      "errors": []
    }
  ],
  "heat": { "device": "A", "tok_s": [52, 50, 49, 47], "temp_c": [31, 39], "minutes": 10 },
  "trust": { "verdict": "all clear", "ledger": "holds", "revoke_refused": true, "tls_pinned": true },
  "checklist": { "T01": "pass", "T02": "pass", "T03": "fail", "T04": "pass" },
  "checklist_notes": { "T03": "cmake missing" },
  "problems": [
    { "t": "T03", "title": "setup needs cmake", "expected": "setup builds llama.cpp", "happened": "cmake not found", "error": "first lines of the error", "again": true, "workaround": "brew install cmake" }
  ],
  "person": { "most_confusing": "", "wish": "" }
}
```

Use `null` for what you could not learn, never a guess. Numbers are numbers, not text.
`checklist` values are `pass`, `partial`, `fail`, `skipped` or `not tried`; `p1`–`p3` are `pass`,
`partial` or `fail`. `tokens_total` and `seconds` are the apart batch's own totals (the last lines
of `chat --batch`). `heat.tok_s` is one device's speed over runs in a row, first to last. Order
`problems` by what matters most: the first four go on the score sheet. Read the
report once more against rule 4 before you hand it over: no names, addresses, codes or serials.

Then tell the person where the file is and ask them to send it to whoever gave them this test.
If they are comfortable with it being public, it can also go into a new issue titled
`field test: <devices>` at https://github.com/kurtkurtkurt-del/kula-decentralized-ai/issues.

## the score

`render.mjs` scores every report the same way from its data block, out of 100:

| part | points | from |
|---|---|---|
| works | 40 | 40 × (pass + ½ partial) ÷ (pass + partial + fail); skipped and not tried rows do not count |
| together | 25 | 15 × the apart gain: the best combination's tokens ÷ seconds, over the fastest device alone; 1× is 0, k× for k devices is 15. Plus 10 × the best split tok/s over half the fastest device alone (capped) |
| trust | 20 | the trust verdict (all clear 8, look at this 4, else 0) + the ledger holds 4 + a removed device is refused 4 + every link tls with a pinned certificate 4 |
| holds up | 15 | 5 for speed when warm (last ÷ first run: 95 % or more is 5, 70 % or less is 0) + 5 × the share of P1–P3 answered (partial is half) + pairing 5 (first try within 60 s; 3 within three tries) |

Grades: 90 and up *ready for friends*, 75–89 *works, rough edges*, 50–74 *works with help*,
under 50 *not yet*. What was not measured scores 0, so a short test scores lower: that is on
purpose. Change the formula only in `render.mjs` and here together, and say so in the release
notes, so old and new reports stay comparable.
