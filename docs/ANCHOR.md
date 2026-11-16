# the anchor

How two kula devices that cannot reach each other still talk: through a computer of the circle
that both can reach. Decided and built on 16.11.2026; this page replaces decision 4 and layers 3
and 4 of [INTERNET.md](INTERNET.md). The gate it lives in is described in [GATE.md](GATE.md).

## what it is

An **anchor** is an always-on circle computer whose gate can be reached from the internet: a
router port mapping (`kula-node share --anchor`, or the page's switch, below) or an open IPv6 address. The other devices dial
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

Defaults, settable by the person (`share({ anchor: { … } })`, `AnchorHub.setCaps`, the page):

| cap | default | when reached |
|---|---|---|
| streams per member (open and waiting) | 16 | `too many streams` |
| streams in all | 128 | `full` (the anchor computer's own dials count here too) |
| dials, per **friend's** device: a token bucket | 120 at once (`dialBurst`), refilled at 30 a minute (`dialsPerMinute`) | `too many dials` |
| bytes a day, per dialing **friend's** device, both ways | 5 GB (UTC day) | new streams `byte limit`, and the member's running streams are cut |

- **The byte cap is for friends' devices only** (the person's decision, 16.11.2026). A dialing
  member whose record in the anchor computer's peer book is ring `circle` (or `world`) is capped;
  the person's own devices (ring `home`) never are. A member without a record yet (it paired with
  an invite, the pair-back has not run) is capped until it has one. The ring is read again
  whenever the peer book changes, so `kula-node peers ring <device> home|circle` or the page's
  ring setting counts at the next check (`AnchorOptions.capped`, `ringCapped` in `node/src/join.ts`).
- **The dial rate is a friend's cap too** (the same ring rule): a bucket of 120 dials that refills
  at 30 a minute. llama.cpp opens about 13 short rpc connections per far worker for each load, and
  one refused dial aborts llama-server, so a load has to fit in the burst; a window of 30 a
  minute did not (16.11.2026, T1). The person's own devices have no dial rate cap.
- The stream caps (per member, in all) hold for everyone: they guard against a broken device, not
  a friend.
- The page sets the friend cap next to the switch: "a friend's device may pass up to N GB a day
  through this computer". It is kept with the switch (`~/.kula-node/anchor.json`) and set on the
  running anchor at once.
- `engine.anchor()` says `capDay` (the friend cap) and `memberMaxDay` (the most one capped member
  passed today), so the brain can hold the two against each other.

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
| turning it on | `share({ anchor: true \| caps })` in `node/src/share.ts`; `kula-node share --anchor`; the page's switch (`node/src/ui/sharehere.ts`) |
| one-time codes beside the gate's own (invites, pair-back codes) | `node/src/join.ts` `OneTimeCodes`, `TlsServer.codes` in `node/src/gate.ts` |
| the invite and the pair-back | `node/src/join.ts`, `AnchorHost` |
| joining: pairing with the invite, the store of joined anchors | `node/src/join.ts`, `joinWithInvite`, `~/.kula-node/anchors.json` |
| staying registered with every joined anchor while sharing | `node/src/join.ts`, `AnchorLinks` (started by `share`) |
| whose bytes are capped (ring) | `node/src/join.ts`, `ringCapped`; `AnchorHub.capped` |
| the switch, its setting, what the router said in plain words | `node/src/ui/sharehere.ts` (`anchorWords`, `anchorShareView`) |
| join tests: three homes, codes, pair-back, typed entry, router words, the switch, the page | `node/test/anchor-join.test.ts` |
| events (register, leave, open, close, refuse) | the gate's `onAnchor`, apart from `GateEvent` |
| tests | `node/test/anchor.test.ts`: three gates on 127.0.0.1 |
| roads: an address or `{via:'anchor', anchor:<fp>\|'self'}`, the staggered pick, `openRoad`, `roadDialer` | `node/src/road.ts` |
| a peer's anchors (`anchors` in its record and its v3 code), the route kept by the probe | `node/src/peers.ts` |
| tunnels along a road (api and rpc), `probeOver`, `peekOver` | `node/src/gate.ts` |
| far split: rpc along the road, each worker's own link in the estimate | `node/src/planner.ts`, `node/src/split.ts`, `node/src/sim.ts` |
| roads tests: order, back to the lan, self, apart, network test, split | `node/test/roads.test.ts`, `node/test/sim-rtt.test.ts` |

## roads (stage 3, 16.11.2026)

- A **road** is an address (lan, ipv6, mapped) or a stream through an anchor:
  `{via:'anchor', anchor:<fingerprint>}`, or `{via:'anchor', anchor:'self'}` when this computer is
  the anchor and the device registered here (one hop, in-process). The peer record's `route` is
  a road; `reachedBy` stays an address kind and is null on an anchor road.
- **Where anchors come from:** the record's `anchors` (fingerprint, address, name; the device
  registers there), then the anchors this computer is registered with (`EngineOptions.anchors`).
  A device is never its own anchor; this computer as an anchor is `'self'`.
- **The pick:** the tries start 250 ms apart in order (host/port, addrs, 'self', anchors); a try
  that fails starts the next at once; the first that shows the pinned certificate wins. Back on
  the lan the lan answers before the second try starts. A tunnel whose road stops working picks
  again before its next connection.
- **An anchor is reached at its own address**, never through another anchor.
- **Far split:** the rpc channel follows the road like the api channel. Only the hosted relay is
  still left out of a split. Each worker is measured along its road (both legs through an
  anchor) and the estimate sums the round trips per worker over its own link
  (`RPC_ROUND_TRIPS` 1.1, measured 16.11.2026). The plan says per device how it is reached and
  what its link costs a token.
- **Wired by stage 4 (join, below):** the page's switch turns the anchor on ('self' roads), and the
  engine's anchors come from the store of joined anchors.

The gate's `rpc` channel is now held by **certificate** in v2 (by address in v1): every stream
through an anchor or a relay arrives from 127.0.0.1, and two far masters must not share the slot.

## join (stage 4, 16.11.2026)

### make a computer an anchor

- **On the page:** devices → share this computer → **make this computer an anchor** (a switch, off
  by default). Sharing (re)starts with the anchor hub on (default caps), the gate on ipv6 and ipv4,
  and the router asked for the gate port (PCP, NAT-PMP, UPnP-IGD: [INTERNET.md](INTERNET.md)).
  Turning it off restarts sharing as before (this network only); stopping sharing turns it off.
- **In a terminal:** `kula-node share --anchor` (implies `--map-port`, tls only). It prints what
  the router said and an invite (for a friend's computer), and a new invite each time one is used.
- **It stays on:** the switch is a setting (`~/.kula-node/anchor.json`); `kula-node ui` starts
  sharing with the anchor again after a restart. Sharing keeps the computer awake
  ([awake.ts](../node/src/awake.ts)), so it is awake for as long as the anchor is on.

What the page says, by state:

| state | words (shortened) |
|---|---|
| off | "off. turned on, your devices that are away from home … reach each other through this computer." |
| starting | "starting: sharing this computer and asking the router for a door…" |
| the router mapped the port | "the router opened the door: from the internet this computer answers at 203.0.113.5:50551." |
| the router mapped, but did not say its address | "the router opened port 50551, but did not say its address on the internet." |
| no answer from the router | "no answer from the router: open TCP port 50551 to this computer (192.168.1.5) by hand in the router's settings (often called "port forwarding"), then make an invite." |
| the router refused | "the router said no (pcp: not authorized): open TCP port … by hand …" |
| carrier NAT (the address the router reports is itself private or shared) | "your provider does not give this home a public address: this computer cannot be an anchor from outside; it can still be a member of another anchor." |
| a global ipv6 address | "… over ipv6 it may also answer at [2001:db8::5]:50551, if the router lets it in." |
| not confirmed | "not confirmed from outside yet: that shows once a device registers here from away from this network." |
| confirmed | "reached from outside: a device came in from the internet." Only once a member registered from an address that is neither private nor loopback (`engine.anchor().reachable`); no outside service is asked. |

### invite a computer

With the anchor on: **invite a computer**, after saying whose it is (mine / a friend's). The invite
is the anchor's `kula-peer` v3 code (`peerCode`): its certificate fingerprint, its addresses from
outside (the router's mapped address, global ipv6; only the lan address when there is none, and
the page says so), a one-time code `pin`, `anchor: true` and a second one-time code `hpin`. It is
shown as text to copy and as a qr, works **once, for 10 minutes**, and a new invite kills the one
before. The typed form is printed beside it: address, code, the certificate's first 16 hex.

"Mine" makes the joiner ring `home` in the anchor's peer book (never byte-capped); "a friend's"
ring `circle` (capped, above). The person can change it later like any ring.

### join an anchor

On the other computer: devices → add a device → **paste a code** (or `kula-node peers add <invite>`),
or **type it** with the address, the code, the certificate start (16 hex or more) and "an anchor's
invite" ticked. Then:

1. It pairs with the anchor's gate with `pin` (the usual pin proof, which covers both
   certificates; the anchor's certificate is pinned from the invite, or checked against the typed
   start at TLS before the code is spent). The anchor is now in its peer book (`anchor: true`,
   ring `circle` until the person says otherwise) and in `~/.kula-node/anchors.json`.
2. While it shares (the page starts sharing for it when it was off; a terminal runs
   `kula-node share`), it **registers** with every joined anchor and stays registered
   (`AnchorLinks`: reconnects with backoff, along the invite's addresses).
3. Its gate opens `hpin` for **the anchor's certificate only**. When it registers, the anchor dials
   it through its own hub (the in-process hop) and pairs with `hpin`: the far version of the host
   qr. Now each is pinned and paired on the other side; the anchor keeps it in its peer book,
   reached through `'self'`. A typed invite has no `hpin`: both sides derive it from `pin`
   (`pairBackCode`).
4. Its engine takes the joined anchors as its roads (`EngineOptions.anchors`), and its share qr
   names them (`anchors`), so a device that pairs with it on the wi-fi can later reach it through
   them. Forgetting the anchor on the page leaves it.

What the joiner hears when it does not work:

| the anchor's gate said | words |
|---|---|
| `pin used` | "this invite was used already: each invite works once. ask for a new one." |
| `pin expired` (ran out, or a newer invite replaced it) | "this invite ran out (it works for 10 minutes). ask for a new one." |
| `wrong pin` | "the code does not match the anchor's invite: check it, or ask for a new invite." |
| `not paired` (no invite open) | "the anchor has no invite open: ask for a new one." |
| another certificate at TLS | "the certificate does not match what the anchor shows: not joining" (typed), or the next address is tried |
| nothing answers | "the anchor does not answer at …: is it on, and is its door open from where you are?" |

The gate remembers a used or expired invite code for 30 minutes, only to say which of these it
was. Besides the qr's own code it keeps any number of such one-time codes (`TlsServer.codes`), each
spent by the first pairing, and a pair-back code only for the one certificate it names.

On the page each device row says how it is reached now: **on this wi-fi**, **over the internet**
(a global ipv6 address or a router's port), or **through anchor X** (through this computer, when
it is the anchor).

## the phone (stage 5, 16.11.2026)

The phone is a member, never an anchor: its gate still answers `bad channel` to `anchor`.

- **Joining:** devices → scan or paste the anchor's invite (its qr json, or kula-node's base64url
  line), or type it in the code field as `address code certificate-start`, e.g.
  `203.0.113.5:50551 0123456789abcdef 9f86d081884c7d65`. The phone pairs with the anchor's gate with
  `pin` (natively, `Anchor.join`), keeps the anchor in `files/gate/anchors.json` with the pair-back
  code (derived from `pin` when typed) and as a peer (pinned, paired, `anchor: true`).
- **While "share this phone" runs** (manual or auto), the worker registers with every joined
  anchor (`Anchor.Links` in `WorkerService`), pings every 25 s, reconnects with backoff (1 s doubling
  to 30 s) and at once on a network change (`ConnectivityManager` default-network callback), under
  the existing foreground service, wake lock and wifi lock. A stream the anchor opens is piped into
  the phone's gate on 127.0.0.1. Its gate opens the pair-back code for the anchor's certificate
  only (`Gate.ExtraCodes`); the anchor pairs back through 'self' and the store forgets the code.
  Joining while the phone is not shared asks the person to share it within 10 minutes.
- **The phone as master:** a device's roads are host/port, its code's `addrs`, then anchors (the
  device's own code's, then the ones this phone joined), tried 250 ms apart, the earliest that
  shows the pinned certificate wins (`src/llm/roads.ts`, `pickRoad`; one at a time while a pairing
  code is unspent). The road is kept on the peer (`route`) and both channels follow it: apart
  mode's api tunnel and the split's rpc tunnels (`Gate.Tunnel(anchor=…)`, an SSLSocket inside the
  SSLSocket to the anchor). Only hosted-relay peers stay out of split. A refused dial with
  `too many dials` makes the tunnel wait up to a minute instead of failing llama.cpp.
- **The rpc slot** on the phone's gate is held by the client certificate (v2), not the address.
- The device rows say **on this wi-fi**, **over the internet** or **through anchor X**.
- The phone's own share qr names its joined anchors (`anchors`), so a computer that pairs with it
  on the wi-fi can later reach it through them.
- Tests: `android/src/test/.../AnchorNodeTest.kt` against node's own anchor
  (`modules/kula-llama/tools/anchor-fixture.mjs`: node/src's gate, AnchorHub and AnchorHost),
  `AnchorTest.kt`, and `src/__tests__/anchor-roads.test.ts`.

## next

1. ~~Routes~~ (done 16.11.2026, "roads" above).
2. ~~Join~~ (done 16.11.2026, "join" above).
3. ~~The phone~~ (done 16.11.2026, above; on a real phone still to be shown).
4. The circle's address book and a second anchor.
