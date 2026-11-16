# kula and beyin

A vision, written down on 5.11.2026. Nothing about licensing or hosting changes now: kula and
beyin are both public and open source, in their own repositories, and stay that way until
someone decides otherwise in so many words.

## the boundary

**kula is the joining, and it is free.** Everything needed to turn the phones and computers
in one place into one cluster: the app, the native module, kula-node, the gate, the three
modes, the local planner, the night on one person's own devices, the auditor and its ledger,
and a relay anyone can run themselves. kula must work fully without beyin, offline and with
no account.

**beyin is the brain, and it would be the service.** beyin ("brain" in Turkish) is a
separate piece of software (`~/Desktop/claudecode/beyin`, protocol draft
`check/spec/PROTOCOL.md`) that turns many unlike, untrusted devices into one pool across the
internet. kula is its first client, not its owner. What it would offer on top of kula:

| beyin would add | what that means |
|---|---|
| prediction | which device is up when, for how long and at what speed, learned from what really happened; outages foreseen per city |
| scheduling across the internet | which job goes to which device, when, beyond one Wi-Fi; model housekeeping (what to download or delete where) and heat |
| trust aggregation | collecting ledger heads and, on request, ledger segments; cross-checking known-answer units; a device's standing built from many nights |
| a hosted relay | the relay kula already has (`node/relay/`), run as a service so nobody has to deploy one |

## what stays an open protocol inside kula

These are kula's, documented and tested on both implementations (Kotlin and TypeScript)
with shared vectors, so that anything, beyin included, can speak them without kula's code:

- **the gate** ([GATE.md](GATE.md)): v1 (shared secret, HMAC handshake) and v2 (TLS 1.3
  between device certificates pinned by fingerprint and a one-time code), the QR formats v2
  and v3, the refusal reasons, the rule that ggml's RPC and the worker API stay on 127.0.0.1;
- **the ledger format** ([AUDIT.md](AUDIT.md)): one signed, hash-chained JSON line per event
  (`pair`, `connect`, `reject`, `load`, `claim`, `health`, `end`), verifiable by anyone with
  the device's public key;
- **the local checks** ([AUDIT.md](AUDIT.md)): replay and clock on the hello, a device's
  claimed memory and bandwidth against what it really holds, the model's sha256, the
  per-connection bounds, health warnings; pure functions that run on every worker and decide
  nothing about routing;
- **the relay protocol** ([RELAY.md](RELAY.md)): a blind pipe of TLS records between two
  devices, so a relay, hosted or not, never sees inside;
- **the night report** ([BACKEND.md](BACKEND.md)): numbers only, never prompts or answers.

beyin v0, the auditor that lives in kula today, is the seed of beyin's *check* part: plain
Kotlin with no Android imports and a TypeScript twin, written so it can move into beyin's
repository and be compiled back into kula the way device-passport's core is.

## how kula would talk to beyin

Through **one optional client interface**, not yet written. A sketch:

```ts
// app/src/beyin/client.ts (proposed). Absent, or answering null, means: kula decides alone.
interface BeyinClient {
  advise(job: JobSpec, devices: DeviceState[]): Promise<Placement | null>; // where a job should run
  forecast(deviceId: string, window: Window): Promise<Availability | null>; // when a device is likely up
  report(head: LedgerHead, night?: NightReport): Promise<void>;             // what happened, numbers only
  relay(): Promise<RelayAddress | null>;                                    // a hosted relay, if any
}
```

- kula ships with no client configured. The planner, the scheduler and the relay address
  work exactly as today; `null` from any call means the same.
- Everything kula sends through it is what the protocols above already define: ledger heads
  and segments, night reports, device passports. No prompts, no answers, no model output.
- The pieces that already point this way: `sendLedgerHead` in `app/src/data/night.ts`
  (written, not called yet), the `device_ledger_heads` table and the v1 collection plan in
  [BACKEND.md](BACKEND.md), the relay address in settings.

## god's eye: one eye, two homes (11.11.2026)

god's eye (`node/src/godseye/`) is the brain's twelve branches, written as a program in waiting:
handed a snapshot every few seconds, it thinks with its own rules, keeps its own notes, says
cards, and never acts. It ran only on the computer. The phone, when it runs the cluster, now has
the same brain, from **the same source, not a copy**.

**How it is shared.** The eye is platform-neutral behind a tiny platform interface
(`node/src/godseye/platform.ts`):

| what the eye needs | interface | computer (`node.ts`) | phone (`app/src/eye/`) |
|---|---|---|---|
| the branches' notes | `EyeNotes` read / write / remove, one json per branch | files `<dir>/<id>.json`, mode 600, tmp + rename | kv-store `eye.notes.<id>` (`notes.ts`) |
| sha256, base64 | none: plain TypeScript (`hash.ts`), byte for byte node's | the same | the same |
| signatures, certificates (trust branch) | `EyeKeys` key(spki).verify / certSubject | `node:crypto` | none: branch 8 is the phone's own report (below) |
| the clock | `now` in `EyeOptions` | `Date.now` | `Date.now` |
| the black box | a `Box`, handed in opened | `box.ts` on disk | **none: the black box stays computer-only for now** |

`core.ts` is the entry without node (types, the eye, the cards' checks, the platform types);
`index.ts` stays kula-node's entry and adds the computer's pieces (`NodeGodsEye` as `GodsEye`,
which still takes `dir` and `box: { dir }`). Only `box.ts` and `node.ts` may import a `node:`
module; `node/test/godseye.test.ts` holds that line.

The app imports `@godseye/core`: a tsconfig path to `../node/src/godseye/*`. Metro watches that
one folder and, inside it only, reads a relative `./x.js` as `./x.ts` (the files are node ESM)
and takes a package (babel's helpers) from the app's node_modules (`app/metro.config.js`); jest
does the same (`app/jest.resolver.js`). `app/src/__tests__/eye-shared.test.ts` walks what
`core.ts` reaches (no `node:`, no package, never `node.ts` or `box.ts`) and compiles it under the
app's tsconfig with no node types at all. Why not a generated copy with a parity test, like the
catalog: Metro and jest resolve the one source cleanly, so there is nothing to keep in step.

**The phone's look** (`app/src/eye/snapshot.ts`, the twin of `node/src/ui/godseye-feed.ts`).
This phone is the host: its passport name, its free memory (native `info()`), its own ledger
chain, and, new in the shape, `host.power` (battery, charging, the passport's thermal flag),
which the limits branch reads when a look carries it (the computer's does not). The devices are
the paired ones: via wi-fi or a relay, pinned or not, memory and bandwidth as advertised, reach
from the freshest of the security report's last look, a card's probe or the engine using it.
Alone is mode `here`; apart lists every device; split carries the parts. The models are the
catalog with what is here plus models only here, each with kula-node's `needMb`. The projects
are the person's own, with tonight's window. A device's `trust` is null on the phone.

**Branch 8 on the phone** is the phone's own security report (`app/src/eye/trustBranch.ts`):
Hermes has neither Ed25519 nor P-256, and the phone already verifies every certificate and
ledger line natively (`TrustVerify.kt`) once a minute while the report is open, so the eye reads
that report (in the reader's language) instead of checking a second time, and says a red
verdict as a warn card.

**When it runs** (`app/src/eye/run.ts`): every 5 s like the computer's, only while the app is in
the foreground and someone holds it: the brain tab or a branch's page on screen, or a cluster
this phone runs (a model apart or split, or a load under way; `useClusterEye` in the tabs). In
the background it pauses; nothing is read.

**The brain tab**: the cards first (warn and suggest, with the phone's button or "only the
computer can do this one", and dismiss), then the twelve as a small map, three across, each with
its page (`/branch/<id>`): its gauge and few words, what it sees, its list, its note, its cards.
The branches' names and map lines are in en, de and tr; what a branch says is its own words, in
english on both homes. A card's tap goes to the phone's own engine (`app/src/eye/apply.ts`):
load (alone, apart or split, with models on this phone and paired devices), unload, fetch (a
catalog model onto this phone), probe (look at devices again), open (devices, models, settings,
a branch). What the phone cannot do, a model only on the computer, `phone` mode on another
phone, a device it has not paired, gets no button.

## nothing is closed now

All of kula and all of beyin are public. No repository is split, no code is withheld, no
feature is paywalled. Where a hosted relay runs and what beyin v1 contains are open
decisions, listed in [DURUM.md](DURUM.md).

## the brain's cards (11.11.2026)

The order the cards weigh things in, the person's choice (11.11.2026): **privacy first, then the
devices' health, then speed.** A card never offers a device that review keeps a job from (privacy),
nor one that limits says should rest or trust does not vouch for (health), before it compares
speeds. Strangers take no part at all.

God's eye (`node/src/godseye/`, the brain on the Mac) still decides nothing by itself and never
touches a device. Since 11.11 its branches may suggest or warn as cards on the brain panel; the
person's tap asks kula's engine to load, fetch or look again, the same way the person's own buttons
do (`POST brain/apply`). The four deciding branches make theirs from the look alone, with the
maths of kula's planner copied small into `branches/decide.ts` (the eye imports nothing of kula):

| branch | cards | example |
|---|---|---|
| planner | split (fits only split, or GAIN 1.15× faster than the fastest place alone; once 3 split answers taught the link cost and every seat was measured, when the 80% range's low end reaches the fastest place alone), apart (n answers at once), alone (split is slower: load it alone), barred (a device in the split should rest or is not trusted) | "Gemma 3 4B would run faster split over mac and tablet: ~11 tok/s; alone here on mac ~8.8" |
| executor | slow (apart: under a third of the fastest tok/s), rest (limits says so), failing (3 of its last 12 checks unreachable), idle (took no prompt for two minutes while another answered) | "galaxy answers at ~3 tok/s, this computer at ~14" → leave it out |
| models | pick (nothing loaded: the biggest that fits a place), bigger (1.3× and fits the same places), tight (memory dropped since the load, it no longer fits), fetch (a catalog model clearly bigger than anything here), vision (photos came that nothing here could see) | "photos came but nothing here sees them: fetch SmolVLM 500M (0.5 GB)" |
| advisor | night (a waiting project whose device is gone or whose model does not fit), tonight (the hour the forecast has most devices there), first (of the others' cards, which one first, said plainly) | "tonight 3 devices are likely free: plan the project for 02:00" |

The rules every card keeps:

- **evidence only.** A speed is quoted only when measured (the tok/s a device really answered with,
  kept by the planner; never a split's, which is the whole chain's) or estimated from the memory
  bandwidth a device measured (and then the card says so). This computer's bandwidth is not in the
  look, so until a model ran here its speed is "not measured yet" on the branch's page and no card
  quotes a number for it.
- **never a device someone said no to.** Limits (should rest) and trust (a bad verdict) hand the
  deciding branches their word as `hints` (peek only, never drawn); the forecast hands them each
  device's tonight, hour by hour. Such a device is left out and the page says why.
- **steady.** A card shows once its reason held 3 looks and goes 4 looks after it went; every
  threshold is looser by 5% to stay than to show, so a number hovering at a line does not flap.
  Its id stays the same while its reason holds (`<branch>:<topic>:<model or device>`), so a dismissal sticks.
- **the eye never acts.** A card carries only what a tap would ask (`SuggestAction`); kula's engine
  does it, and refuses what it would refuse from the person.

The snapshot grew by three small fields for this: `models[].vision`, `models[].active_b` (a mixture
of experts reads only its active weights per token) and `work.photos` (photos sent in chats since
kula-node started, and how many nothing could see). Tests: `node/test/godseye-decide.test.ts`,
`node/test/godseye-advisor.test.ts`.

## the brain and the anchor network (16.11.2026)

The anchor network (the person's own always-on computers passing bytes between far devices, no
server outside; the anchor itself is `docs/ANCHOR.md`, written in its own session) gave the brain five small packages.
It still only watches, warns and suggests: no new signal bars a device, turns its verdict, closes
a port or switches anything off. A look without the new fields makes the same report as before.

**The snapshot contract** (`node/src/godseye/types.ts`; `branches/guard.ts` cleans every new field,
and absent stays absent). No address of anyone reaches the eye.

| field | what it says | who fills it |
|---|---|---|
| `devices[].via: 'anchor'`, `through`, `throughName` | the device is reached through an anchor of the circle; `through` is that anchor's row id, `'self'` when this computer is the anchor, null when the anchor is not in the peer book; `throughName` its name for the cards (notes keep ids only) | the engine's peer rows (anchor stage 2, kula-main 1e3669b0), read by `ui/godseye-feed.ts` through a widened row |
| `devices[].anchor` | this device offers the anchor role | the engine's peer rows, as above |
| `host.anchor` | this computer as an anchor: on, reachable from outside (or not known), links held now, bytes passed on in the last day by all members together (ciphertext, the owner's own devices too), `capDay` the daily limit of one friend's device (circle or world; the owner's own devices have none), and `memberMaxDay`, the most one friend's device passed today (asked of the anchor side, may be absent; without it the brain makes no cap card) | `engine.anchor()` when the engine has one; absent otherwise |
| `host.gate` | this computer's own gate refusals per UTC hour (at most 26, the last one running): by reason (every `rpc guard: …` under `rpc guard`), how many came from a non-private address (`far`), how many distinct outside networks (`nets`, a count of hashed ipv4 /24 and ipv6 /48 blocks), the last 5 rpc guard refusals | the feed, today, from the reject lines of this computer's own signed ledger, verified in the same pass (`hostGate`); each line counted once, an unchanged ledger costs a 26-entry copy |
| hint `loss: { hi }` | for a device reached from afar with at least 10 probes: the upper end of the 80% Wilson interval of its missed probes | the connections branch, for the planner |

The phone's look (`app/src/eye/snapshot.ts`) carries none of these yet, so on the phone none of
what follows shows.

**Routes** (connections). An anchor is assumed at 300 ms, sometimes dropping, until probes say
otherwise; the branch's tile counts `· n anchor`. The notes keep per device the id of the last
anchor it went through, never an address. Three cards, each only a probe or opening a page; an
anchor this computer cannot name reads "an anchor":

| card | weight | shows when | title |
|---|---|---|---|
| `connections:through:<Y>` | warn 1 | a reachable device goes through anchor Y (one card per anchor) | "X is reached through anchor Y": Y passes the bytes on and cannot read them; apart and split both work |
| `connections:anchor-down:<Y>` | warn 3 | Y, a device of the look, missed its last 3 probes and a device last routed through Y cannot be reached; goes when either answers once. A Y absent from the look (forgotten, or cut from the list) is not "not answering": no card, and the devices that went through it forget it | "anchor Y is not answering: X and Z cannot be reached" (seen from this computer only) |
| `connections:one-anchor` | suggest 1 | exactly one anchor known and at least one far device | "only one anchor (Y): if it goes, far devices lose each other": a second always-on computer in another home keeps the circle up |

A switch is one feed line ("X is now reached through anchor Y (was wifi)"). The older internet card
no longer says only apart works there: apart and split both do, a split waiting about one round
trip per token for each far worker.

**What a far split costs** (planner, `branches/decide.ts`). A far worker is one reached straight
over the internet or through an anchor; a relay is never a seat of a split. A near worker is priced
exactly as before. A far worker's hop is k times its link's usual round trip (senses' srtt), or
150 ms over the internet and 300 ms through an anchor when there is no link yet.

The unit caveat: the probe's ms is a whole handshake (tcp, tls 1.3, hello, proof), about **4 round
trips**, not one. So k = 1 against it is probably about 4 times too slow for a far link. Until three
far split answers were watched, the planner gives a range: its low end at k = 1 (one probe's ms per
token), its high end at k = 0.25 (a quarter of it). With a 200 ms link and c ms of compute per
token: low 1000/(c+200), high 1000/(c+50) tok/s. After three far answers, the far fit (`hopFar`,
kept apart from the near fit `hop`: a chain with a far worker teaches only `hopFar`) gives its own
k and its 80% range. The speed a split with a far worker reports is the low end, so "faster split"
never fires on an assumption.

One card, `planner:far:<model>` (suggest, weight 1, no button: the person chooses), when a split
would use a far worker and alone or apart exists: "far devices: split likely lo–hi tok/s, apart ~x
tok/s each" (or alone, when no apart). Its why names the far workers, says "assumed from probes, i
of 3 far split answers watched" or "learned", and names a far link that missed 20% or more of its
probes (a split stops when one worker drops). The split cards end with the same range sentence.
The 16 Nov proxy measurements (46 / 32 / 17.7 / 12.9 / 7.7 tok/s at 0 / 10 / 30 / 50 / 100 ms added
round trip) are a test (`godseye-hop-points.test.ts`): k = 1 against the true round trip fits them
within 10%. The heavy bench's numbers did not move.

**Gate watch** (trust, `branches/gatewatch.ts`). This computer's own gate, from `host.gate`. Every
refusal reason is a stranger (no hello, tls, not paired, … someone without a pairing knocked), a
guess (a code or proof that was not theirs), the rpc guard (a paired device sent the split's rpc a
command that can carry code; it was dropped before llama.cpp saw it) or other. A host check `gate`
sits beside the host's ledger check:

- **calm** (ok): "its gate refused N strangers today (no hello ×a, tls ×b) from about M networks:
  scanners find every open port; none got in", with "(still learning what is usual: n of 24 hours)"
  while it learns. Scanners are counted, never alarmed.
- **red** only for an rpc guard refusal in the 26 hours, or 5 or more wrong codes in a day. It turns
  the cluster's verdict red, never a device's.

| card | weight | shows when |
|---|---|---|
| `trust:gate-guard` | 3 | at once, while the 26 hours hold an rpc guard refusal at this gate (kula versions that differ can do this by accident) |
| `trust:rpc-guard:<id>` | 3 | a device says its own gate cut one; its verdict does not change (it defended itself) |
| `trust:gate-guess` | 3 | 5 or more wrong codes in the last 24 hours: someone may be guessing; all refused |
| `trust:gate-burst` | 2 | more knocking from outside the lan than usual for this hour of day (burst.ts's fit, unchanged, on each finished hour's `far` count, kept in trust's notes under `~gate`); also, learning or not, 1000 or more in the running hour. A new level (the gate opened to the internet after quiet learning: the 24 newest finished hours, and each 6-hour quarter of them, above 3 × their usual) starts the fit again on those 24 hours, with one feed line "a new level: learning what is usual again"; one loud hour stays a burst |
| `trust:anchor-cap` | 2 | a friend's device passed its daily limit through this computer as an anchor (`memberMaxDay` against `capDay`; the owner's own devices have no limit and no card); without `memberMaxDay` no card. It stays while above 0.95 of it. Nothing is switched off |

Every card only opens the trust page; one feed line when it comes and one when it goes. The
thresholds (the tail, the 1000, the 5 guesses) were not measured against a real router's scanner
rate. `nets` is "about": a scanner farm in one block is one network, a carrier-grade nat is many people.

**A moved address** (connections). When a settled device (at most 2 address blocks, at least 20
answers over them, first to last at least 3 days) answers with its pinned certificate from a public
block it was not seen on (ipv4 /16, ipv6 /32), the feed says so once a day and the card
`connections:moved:<id>` (warn 2, 24 hours, opens trust) explains: the same key, normal after a move
or a new provider, or its provider gave it a new address; if nobody moved it, ask its owner or pair
again. A lan change, lan to internet, a roaming phone (never settled) and a device through an anchor
give nothing. **Privacy:** the notes keep per device at most 6 entries of the first 12 hex of
sha256(id | block), with first and last seen and a count; never an address, never a block written
out. The hash is not readable at a glance, not secret: the id is in the same file, so trying the
65,536 ipv4 /16 blocks turns an entry back into its block. The notes stay on this computer. The card
compares blocks; it does not say where.

Tests: `godseye-anchor-contract`, `godseye-gatefeed`, `godseye-routes`, `godseye-far-split`,
`godseye-hop-points`, `godseye-gatewatch`, `godseye-moved` (all `node/test/*.test.ts`). Eight older
assertions (hop-wire, split-order) that priced an internet seat like a near link now use wifi seats;
far pricing is tested on its own.

**What waits**

- The unit of the prior: the proxy run that logs `gate.probe`'s ms beside tok/s at 0 / 10 / 30 / 50
  / 100 ms, then the choice of a far prior of 0.25. If the 16 Nov round trips were one-way, the
  0.25 high end is wrong; that run shows it.
- A scanner burst at a far device's own gate still turns that device red and keeps it from seats
  (trust.ts). Softening it needs a bench4 scenario with internet noise first.
- "X and Z cannot reach each other" for pairs without this computer: needs the circle's address book.
- A paired device arriving at this gate from a new address: the connect lines carry no fingerprint,
  so only devices this computer probes are watched for a move.
- Other devices' anchor bytes and caps; a metered-data flag on phones (the app is not part of this).
- The anchor's own refusals (too many streams, full, too many dials, byte limit) are logged in
  share, not in the signed ledger yet, so the gate watch does not see them.
- The moved address: the first public block says nothing; the card and the once-a-day line live in
  memory (a restart forgets them); a device that once had 3 or more blocks never counts as settled
  again (entries do not age); documentation test-net ranges count as public.
