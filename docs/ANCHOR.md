# the anchor

How two kula devices that cannot reach each other still talk: through a computer of the circle
that both can reach. Decided and built on 16.11.2026; this page replaces decision 4 and layers 3
and 4 of [INTERNET.md](INTERNET.md). The gate it lives in is described in [GATE.md](GATE.md).

## what it is

An **anchor** is an always-on circle computer whose gate can be reached from the internet: a
router port mapping (`kula-node share --map-port`) or an open IPv6 address. The other devices dial
out to it and keep one connection open. When device C wants device B and neither can reach the
other (a phone on mobile data, a laptop behind a hotel's wi-fi), C asks the anchor for a stream to
B. The anchor tells B, B opens a stream back, and the anchor pipes the two together.

Inside that pipe C runs the **ordinary gate handshake with B's own gate**: TLS 1.3 between C's and
B's certificates, pinned both ways. The anchor carries ciphertext only. It cannot read a prompt,
cannot pretend to be B, and cannot pair anyone with B.

There is no new server and no new port. The anchor is a third channel on the gate kula-node
already runs. Nothing outside the circle is involved: no hosted relay, no cloud, no DNS.

Every reachable computer is an anchor for its own peers. "The Mac at home is reachable, the phone
is on mobile data" is one hop, inside the Mac's own process. Only a third-party anchor (a friend's
computer in Berlin, say) costs two legs.

Order of tries for a device, once routes use anchors (stage 3): the same wi-fi, then a direct
internet address (IPv6, a mapped port), then an anchor. An anchor is never reached through another
anchor.

## why inside the gate

- **The gate already proves who is calling.** It runs TLS 1.3 with client certificates and has its
  handshake caps in front (32 at once, 8 per address, 20 s per handshake). A WebSocket or HTTP
  server on an internet-facing port would add a parser that strangers can reach before anyone is
  known.
- **The hosted relay trusts claims.** It takes a claimed fingerprint and a six-digit code
  (`node/relay`). The anchor reuses the relay's message set (register, open, accept, dial) but not
  its transport, codes, sessions or tokens: every message is bound to the TLS-proven certificate.

## the channel

A normal v2 handshake ([GATE.md](GATE.md#the-handshake-inside-tls)) on channel `anchor`, then one
JSON line, then either more lines (the control connection) or a raw pipe (a stream).

```
C → S   KULA2 anchor <nonce_c> <unix_ms>
S → C   <nonce_s> paired            a member
   or   NO not paired               anyone else, even while a pairing code is open
C → S   -
S → C   OK -                        (anything but "-" is "NO bad proof")
C → S   one JSON line:
```

| first line | answer | then |
|---|---|---|
| `{"t":"register","name","kind"}` | `{"t":"registered"}` | the control connection: the anchor sends `{"t":"open","sid","from"}` when a member wants a stream to this device; this device sends `{"t":"ping"}` every 25 s and gets `{"t":"pong"}` |
| `{"t":"dial","to":"<64 hex fingerprint>"}` | `{"t":"ready"}` or `{"t":"error","reason"}` | after `ready`: raw bytes, piped into the target's gate |
| `{"t":"accept","sid"}` | `{"t":"ready"}` or `{"t":"error","reason"}` | after `ready`: raw bytes; the target pipes them into its own gate on 127.0.0.1 |

- `kind` is `pc`, `phone` or `tablet`; `name` is shown in the anchor's log (40 characters at most).
- A target is named by its **full certificate fingerprint**. A prefix is `bad dial`.
- `register` and `accept` are bound to the certificate of the connection: nobody can register as
  another device, and only the target's own certificate can accept a stream meant for it.
- **One control connection per member.** A second `register` from the same certificate replaces
  the first; the old one is told `{"t":"error","reason":"replaced"}` and closed. kula's client then
  stops instead of reconnecting, so two copies of one device do not fight over the slot.
- The control connection is dead after 75 s without a line (three missed pings) on the anchor's
  side; the member gives up after two pings without an answer and reconnects, 1 s first, doubling
  up to 30 s.
- The target has 10 s to accept a stream (`did not accept`).

Refusals in JSON, after `OK -`:

| reason | when |
|---|---|
| `bad request` / `no request` | the first line is not JSON with a known `t`, or did not come within 5 s |
| `bad dial` | `to` is not 64 hex |
| `not here` | no member with that fingerprint is registered now |
| `did not accept` | the target did not accept within 10 s |
| `target gone`, `target replaced` | the target's control connection closed or was replaced while the stream waited |
| `no such stream` | an `accept` for a stream that is not waiting for this certificate |
| `too many streams`, `full`, `too many dials`, `byte limit` | the caps below |

## who may use it

A **member** is a certificate that either

1. is in this computer's gate `paired` list (it paired with this computer's one-time code), or
2. is pinned, with `paired_at`, in this computer's peer book (`~/.kula-node/peers.json`): this
   computer paired with it as a master.

Both are needed because pairing has a direction. A phone added by scanning the computer's host QR
has the computer in *its* list, not the other way round, so the gate's paired list alone would
turn it away.

- **There is no pin path on this channel.** The server never answers `pin`, so nobody pairs through
  this door; an open pairing code stays unspent.
- **Membership gives no rights on `rpc` or `api`.** A member only in the peer book still hears
  `not paired` on those channels. Who may run a model on a device is that device's gate's decision,
  made inside the pipe.
- The two ends of a stream need not be paired with each other. The target's gate decides: a pinned
  certificate, or its own open one-time code. The anchor never vouches. This is also how two far
  members pair for the first time.
- Removing a device on the anchor computer (`kula-node paired remove`, the dashboard) cuts its
  control connection and its streams, unless it is still a member through the peer book.

## what the anchor learns

Who talks to whom (certificate fingerprints), when, how many bytes, and both IP addresses. Never
the content: the inner TLS is end to end and pinned. The anchor computer's log says all of this
(`anchor: stream … → …, N bytes`). The anchor owner is a person in your circle; choose anchors as
you choose who may see that you were online and when.

## caps

Defaults, settable by the person (`share({ anchor: { … } })`, `AnchorHub.setCaps`):

| cap | default | when reached |
|---|---|---|
| streams per member (open and waiting) | 16 | `too many streams` |
| streams in all | 128 | `full` (the anchor computer's own dials count here too) |
| dials a minute, per member | 30 | `too many dials` |
| bytes a day, per dialing member, both ways | 5 GB (UTC day) | new streams `byte limit`, and the member's running streams are cut |

- **No idle cut.** An rpc stream sits idle between chats, and cutting it kills the loaded model.
  Dead legs are found by TCP keepalive (30 s) on every anchor leg and by the loss of the control
  connection.
- **Split streams are carried.** The anchor cannot tell channels apart and does not try; it is the
  last road, after the wi-fi and direct addresses. Whether a far split is worth it is the planner's
  call (stage 3), not the anchor's.
- The anchor computer's own dials (`dialLocal`, the in-process hop) count toward the total but not
  toward a member's caps: those bytes are the person's own.

## what it cannot do

- **No anchor without a reachable home.** If no circle computer has a public IPv4 with a port
  mapping or an open IPv6, there is nothing to dial. Carrier NAT on every home means no anchor.
- **A single anchor whose address changes is lost** until a new invite or a second anchor (stage 6:
  the address book). There is no DNS.
- **The anchor owner sees metadata** (above).
- **A network change kills a loaded split.** TCP cannot move to a new address; apart mode resumes.
- **Far split is slow and heavy** on uplink and mobile data: the weights cross the anchor.
- **Networks that block unusual outbound ports block the gate**, and with it the anchor.
- **A phone is never an anchor.** Its gate answers `bad channel` to `anchor`.

## in the code

| what | where |
|---|---|
| the channel in the gate (members, no pin, keepalive) | `node/src/gate.ts`, `serveTls` |
| registry, caps, pipes, `dialLocal` (the in-process hop) | `node/src/anchor.ts`, `AnchorHub` |
| membership: paired list or peer book | `node/src/anchor.ts`, `circleMembers` |
| a member's side: register and keep the control connection | `node/src/anchor.ts`, `joinAnchor` |
| a stream to a member, ready for the gate handshake | `node/src/anchor.ts`, `dialAnchor` |
| turning it on | `share({ anchor: true \| caps })` in `node/src/share.ts` (no CLI flag yet) |
| events (register, leave, open, close, refuse) | the gate's `onAnchor`, apart from `GateEvent` |
| tests | `node/test/anchor.test.ts`: three gates on 127.0.0.1 |

The gate's `rpc` channel is now held by **certificate** in v2 (by address in v1): every stream
through an anchor or a relay arrives from 127.0.0.1, and two far masters must not share the slot.

## next

1. Routes: a road through an anchor next to the LAN and direct addresses, tried staggered; far
   split with the estimate shown (`RPC_ROUND_TRIPS` 1.1, measured 16.11.2026).
2. Join: the anchor's invite (the `kula-peer` v3 code with `anchor: true` and a second code for the
   pair-back), "make this computer an anchor" in the app, carrier NAT said plainly.
3. The phone: dials the anchor and keeps the control connection while sharing.
4. The circle's address book and a second anchor.
