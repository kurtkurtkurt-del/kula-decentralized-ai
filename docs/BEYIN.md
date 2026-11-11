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

## nothing is closed now

All of kula and all of beyin are public. No repository is split, no code is withheld, no
feature is paywalled. Where a hosted relay runs and what beyin v1 contains are open
decisions, listed in [DURUM.md](DURUM.md).

## the brain's cards (11.11.2026)

God's eye (`node/src/godseye/`, the brain on the Mac) still decides nothing by itself and never
touches a device. Since 11.11 its branches may suggest or warn as cards on the brain panel; the
person's tap asks kula's engine to load, fetch or look again, the same way the person's own buttons
do (`POST brain/apply`). The four deciding branches make theirs from the look alone, with the
maths of kula's planner copied small into `branches/decide.ts` (the eye imports nothing of kula):

| branch | cards | example |
|---|---|---|
| planner | split (fits only split, or GAIN 1.15× faster than the fastest place alone), apart (n answers at once), alone (split is slower: load it alone), barred (a device in the split should rest or is not trusted) | "Gemma 3 4B would run faster split over mac and tablet: ~11 tok/s; alone here on mac ~8.8" |
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
