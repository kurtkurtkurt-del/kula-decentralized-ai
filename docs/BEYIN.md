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
