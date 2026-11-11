# kula over the internet

Today kula devices meet over a USB cable or the same Wi-Fi, through one gated port
([GATE.md](GATE.md): TLS 1.3, pinned certificates both ways). This page is the path to devices
anywhere, and step 1 of it, which is in the code (11.11.2026).

The agreed principle:

- **No machine owns the network.** Any participant's reachable device can play the roles
  (address book, introducer for hole punching, limited relay). Third machines run by us are not
  the default; the hosted relay of [RELAY.md](RELAY.md) stays an opt-in for whoever runs one.
- **Identity is the key; an address is only a hint.** Whatever answers at an address is the
  device only if it shows the pinned certificate. A wrong or stale address costs a timeout, never
  trust.
- **QUIC is the future transport** (one UDP socket for hole punching, streams, connection
  migration when a phone changes networks). TCP + TLS stays for what already works.
- **Meet inside your circle first**: the devices you paired know each other's addresses and can
  introduce you. A public DHT is a later fallback, and only if the person wants it.

Measured on the lead's current network: no global IPv6, and neither NAT-PMP nor UPnP answered.
That network is closed; home networks differ (most home routers do UPnP, many PCP or NAT-PMP,
and a growing share of ISPs hand out IPv6).

## the layers

Each layer is tried only when the one before did not reach the device. All of them carry the
same gate protocol; none changes who is trusted.

| # | layer | what it needs | who else is asked | covers |
|---|---|---|---|---|
| 1 | **IPv6 direct** | both ends have global IPv6; the router's IPv6 firewall lets the gate port in (or a PCP pinhole) | nobody | ISPs with IPv6, most mobile networks (inbound often blocked) |
| 2 | **router port mapping** (PCP, NAT-PMP, UPnP-IGD) | the router speaks one of them and has a public IPv4 (no carrier NAT) | the person's own router, only when they opt in | most home networks with a public IPv4 |
| 3 | **QUIC hole punching** with an introducer from your circle | an introducer both sides can reach (a circle device that has layer 1 or 2); both NATs not symmetric | a circle device | most of the rest: two homes, a phone on mobile data and a home |
| 4 | **limited relay on a circle device** | a reachable circle device willing to carry bytes, with caps | a circle device (sees only TLS records) | symmetric NATs, carrier NAT on both sides |
| 5 | **DHT** (later, optional) | a public DHT (e.g. the mainline DHT via pkarr, or a libp2p Kademlia) | strangers' machines | finding a device's current address when no circle device knows it |

The DHT only *finds* (key to signed address hints); it never carries traffic. Layers 3 and 4
need layers 1 and 2 somewhere in the circle: an introducer or a relay has to be reachable itself.
That is why step 1 is layers 1 and 2.

### 1. IPv6 direct

With global IPv6 there is no NAT: the device's address is reachable if the router's firewall
allows it. Most home routers block inbound IPv6 by default and offer a per-device "open" switch;
PCP can also open an IPv6 pinhole (the same MAP request with an IPv6 client address; not done
yet, see below). The gate has to listen on IPv6 at all, which it did not: kula-node bound
`0.0.0.0` and the phone binds `0.0.0.0` too.

### 2. Router port mapping

Three protocols ask a router to forward a port, all on the local network only:

- **PCP** (RFC 6887): UDP 5351 on the gateway, MAP opcode, says the external address in the
  answer, can do IPv6 pinholes. Newer routers (OpenWrt's miniupnpd, FRITZ!Box).
- **NAT-PMP** (RFC 6886): PCP's predecessor on the same port (Apple routers, miniupnpd). A
  NAT-PMP router answers a PCP request with version 0, which is the signal to fall back.
- **UPnP-IGD**: SSDP multicast discovery, an XML description over HTTP, SOAP `AddPortMapping`.
  The most widespread, the most baroque, and the one with a history of router bugs.

All three fail behind **carrier NAT** (the router's "external" address is itself private,
100.64.0.0/10 or RFC 1918): the mapping is made but nothing from the internet reaches it. The
client says so.

### 3. QUIC hole punching with an introducer from your circle

Both devices send UDP to each other's public address at the same moment, so each NAT sees an
outgoing flow and lets the answer in. Someone both can reach must tell each the other's public
address and the moment: the introducer. In kula that is any paired device of the circle that is
itself reachable (layer 1 or 2), never a machine of ours. A 2025 large-scale measurement of
libp2p's DCUtR found hole punching works for roughly 70% of NAT pairs, and that TCP and QUIC do
about equally well when synchronised precisely ([arXiv 2510.27500](https://arxiv.org/abs/2510.27500)).

### 4. Limited relay on a circle device

What [RELAY.md](RELAY.md) does with a hosted WebSocket relay, done by a circle device instead:
both ends connect out to it, it pipes bytes, and the gate's v2 TLS runs end to end inside the
pipe, so the relay sees only TLS records. Limits: only for devices of the same circle, a
bandwidth and time cap, the api channel only (apart mode; split mode over a relay is useless).

### 5. DHT, later

A device publishes a record signed by its key (key to address hints, short TTL) into a public
DHT; a circle member who lost track of it looks the key up. It leaks to strangers that the key
is online and from which IP. Only as a fallback, and only if the person decides for it.

## libraries (as of November 2026)

| | Node (kula-node) | Android (phone) | fit |
|---|---|---|---|
| **iroh 1.0** (n0, Rust; June 2026) | official Node.js binding | official Kotlin binding; Android aarch64/armv7 supported but built from source (the Maven artifact is not multiplatform yet); run it in a foreground service | dials keys, not IPs; QUIC (quinn) with hole punching; its relays are self-hostable and can be pointed at a circle device; stable wire protocol since 1.0 |
| **libp2p** | js-libp2p: TCP/WebSockets/WebRTC solid; QUIC and DCUtR hole punching weak because Node itself has no stable QUIC | jvm-libp2p is immature on Android; rust-libp2p via FFI is the realistic route | the most complete toolbox (circuit relay v2, DCUtR, Kademlia), the most moving parts |
| **node:quic** | experimental in 2026, needs a Node built with QUIC and `--experimental-quic` | n/a | not something a user's Node can be assumed to have |
| **Android QUIC** | n/a | Cronet (HTTP/3 client only), quiche / quinn via JNI | none is a peer-to-peer stack by itself |

Sources: [iroh 1.0](https://iroh.computer/blog/v1), [iroh Kotlin docs](https://docs.iroh.computer/languages/kotlin),
[iroh language support](https://www.iroh.computer/blog/iroh-language-support),
[Node.js QUIC docs](https://nodejs.org/api/quic.md),
[js-libp2p hole punching discussion](https://www.github.com/libp2p/js-libp2p/discussions/2388),
[libp2p hole punching spec](https://github.com/libp2p/specs/blob/master/connections/hole-punching.md).

## decisions

1. **Layers 1 and 2 now, on the existing gate (TCP + TLS 1.3), with no new dependency.** They
   need no third machine and no new transport: the gate already authenticates by pinned
   certificate, so an internet address is just one more hint. PCP, NAT-PMP and UPnP-IGD are
   small protocols; a dependency-free client (`node/src/portmap.ts`, about 450 lines) is less risk
   than a package that touches the router.
2. **Port mapping is opt-in** (`kula-node share --map-port`). It changes the person's router;
   only they decide. It refuses to run while v1 could be heard (`--no-tls`, `--secret`): v1
   proves no identity and carries prompts in plain text, it must never face the internet.
3. **Dual-stack is the default** for the gate (one `::` socket, IPv4 and IPv6). Exception: while
   v1 is on, the gate stays on IPv4 as before. `--ipv4-only` turns it off.
4. **Split mode never goes over the internet.** The rpc channel (one model across devices) needs
   LAN latency; it is only ever dialled at the peer's LAN address. A device reached only over
   the internet works in apart mode, and the brain says so on a card.
5. **For layer 3 (QUIC), iroh is the candidate**, not libp2p and not our own QUIC: it dials keys
   (our principle), it is stable since 1.0, it has both a Node and a Kotlin binding, and its
   relay/introducer role is a program a circle device can run. The gate protocol would run
   unchanged inside an iroh stream, the way it runs inside the relay's WebSocket today, so
   pinning and the ledger stay as they are. The iroh node key would be bound to kula's identity
   by a signature of the device key, exchanged over an already pinned link. To be confirmed by a
   spike before any code: the Android build from source, the apk size, the battery cost of a
   foreground service.
6. **No DHT until the person decides for it** (below).

## what step 1 does (in the code)

- **The gate listens dual-stack** (`node/src/gate.ts`): `startGateServer` with no `host` binds
  `::` with `ipv6Only: false`; a system without IPv6 falls back to `0.0.0.0`. `dualStack: false`
  is IPv4 only, a `host` is that host only (the tests keep `127.0.0.1`). An IPv4 client on the
  dual-stack socket is recorded as `10.0.0.5`, not `::ffff:10.0.0.5`, so the ledger, the busy
  check and the master-address exception of `/load` see the same peer as before.
- **The router is asked for the gate port** (`node/src/portmap.ts`, `kula-node share --map-port
  [--gateway <ip>]`): PCP first, NAT-PMP when the router answers PCP with version 0 (or not at
  all), then UPnP-IGD. The gateway comes from the system's default route (`/proc/net/route`,
  `route -n get default`, `route print`). The mapping is renewed at half the lifetime the router
  granted, on the same external port; it is removed on stop. One status line in the share log:

  ```
  port map: router 192.168.1.1 (pcp) maps 203.0.113.7:50551 to this computer's 50551, renews every 30 min
  port map: none (the router at 192.168.1.1 did not answer pcp, nat-pmp or upnp); the gate is reached on this network only
  ```

  UPnP is held to the router: an SSDP answer is followed only when its description URL is HTTP
  on the answering address itself and that address is private; the control URL must stay there
  too. An external address that is private or shared (carrier NAT) is reported and not put in
  the QR.
- **The QR may carry several addresses** (QR v3, kula-node's share):

  ```
  {"k":"kula-peer","v":3,…,"host":"192.168.1.20","port":50551,
   "addrs":[{"host":"192.168.1.20","port":50551,"via":"lan"},
            {"host":"2a02:810d::1234","port":50551,"via":"ipv6"},
            {"host":"203.0.113.7","port":50551,"via":"mapped"}],…}
  ```

  `host`/`port` stay the LAN address, so an old reader still works. `addrs` is written only when
  there is more than one way, only in v3 (never next to a v1 secret), IP literals only (no name
  is ever looked up for a hint), at most 8, a bad entry is dropped rather than the peer. The
  global IPv6 addresses are 2000::/3 only (no link-local, no ULA, no tunnel interfaces), at
  most two.
- **The client keeps the first address whose pinned certificate answers** (`node/src/peers.ts`
  `candidates`, `pickRoute`, `probePeers`): host/port first (the LAN, which mdns keeps current),
  then `addrs` in order. Each is asked with a TLS handshake and the hello, then hung up (nothing
  proven, no pairing code spent); the first that shows the pinned fingerprint becomes the peer's
  `route`, and apart mode's tunnel opens there (`dialOf`). Back on the LAN the route goes away on
  the next probe. A peer without a pinned fingerprint is never routed by `addrs`. The rpc
  channel is only ever probed and dialled at host/port.
- **The brain knows** (`node/src/godseye/branches/connections.ts`): the snapshot's device carries
  `reachedBy: 'lan' | 'ipv6' | 'mapped' | null` and its `via` is `internet` when the record in use
  answered only at an IPv6 address or a router's port. Such a device, while it answers, gets one
  card: "*name* is reached over the internet": answers are slower, apart mode only; its button
  looks again. The connections branch already treated `internet` as a kind (150 ms usual, drops
  often); its tile now counts it.

Tests (`node/test/portmap.test.ts`, `node/test/internet.test.ts`, the connections and cli tests):
fake PCP, NAT-PMP and UPnP routers on 127.0.0.1 (map, external address, version-0 fallback,
renewal at half the lease on the same port, delete on stop, refusal, silence within a bounded
time, carrier NAT, UPnP's permanent-lease fallback after error 725, an SSDP answer pointing
elsewhere not followed); the dual-stack gate with an IPv4 and an IPv6 client; QR `addrs`
parsing; and a route chosen past a silent LAN address and a stranger's gate, used by apart
mode's tunnel, and dropped again once the LAN answers.

## what needs a real home router

Nothing above has met a real router yet. To try at home: `kula-node share --map-port`, then from
outside (a phone on mobile data, a friend) `kula-node peers add <code>` and `kula-node peers
probe`. Worth checking:

- PCP on a FRITZ!Box or OpenWrt; NAT-PMP on an Apple or miniupnpd router; UPnP on a typical ISP
  router; what each grants as lifetime, and whether it keeps the external port on renewal.
- A router reboot (PCP/NAT-PMP epoch): the mapping is renewed on schedule, but a lost mapping is
  noticed only at the next renewal.
- Carrier NAT detection on a real ISP.
- Hairpinning: a device on the same LAN trying the mapped address. The client tries the LAN
  address first, so it should not matter.
- The IPv6 firewall: whether the gate is reachable on its global IPv6 address without a PCP
  pinhole.
- What scanners do to an open gate port: expect "no hello" and "not paired" refusals in the
  ledger; MAX_HANDSHAKES (32) caps half-open connections; the pairing code is 64 bits, single use,
  ten minutes.

## the phone (not done in this step)

- `Gate.kt` binds `InetSocketAddress("0.0.0.0", port)`. Dual-stack is one line:
  `bind(InetSocketAddress(port))` (the wildcard is dual-stack on Android; Java shows an IPv4
  client as an `Inet4Address`, so `peer` strings stay as they are). Keep it IPv4 while v1 is
  open, as kula-node does. Not done here: the JVM tests run only through the generated
  `app/android` project, which this branch does not have; it belongs with a `GateTest` case
  that probes the gate over `::1` and `127.0.0.1`.
- The phone's QR v3 could carry `addrs` too: its LAN address, global IPv6 addresses from
  `NetworkInterface`, and (on home Wi-Fi) a PCP / NAT-PMP mapping; the UDP part is plain
  `DatagramSocket`. On mobile data the phone is almost always behind carrier NAT: layer 3 or 4
  is its way in.
- `app/src/llm/peers.ts` ignores unknown fields, so today's app reads the new QR (it uses
  `host`/`port`). Reading `addrs` and trying them in order, with the pinned fingerprint
  deciding, is the same rule as `node/src/peers.ts`.
- ggml's RPC server and the api server stay on 127.0.0.1 on every device; only the gate is on
  the network, whatever the layer.

## the step plan

1. **Direct routes, no third machine** (this step): dual-stack gate, router port mapping
   (opt-in), several addresses in the QR, the client keeping the first that answers with the
   pinned certificate, the brain's card.
2. **The phone**: dual-stack `Gate.kt`, `addrs` in its QR, the app trying them; JVM and jest
   tests.
3. **The circle's address book**: each device remembers the last addresses where its paired
   devices answered and tells them, signed by its device key, over links already pinned. An
   address change (a new mapping, a new IPv6) travels through the circle instead of a new QR.
4. **Hole punching with a circle introducer** (QUIC, iroh after a spike): a reachable circle
   device introduces two others.
5. **Limited relay on a circle device**: caps, circle members only, api channel only, TLS end to
   end inside.
6. **DHT**, only if decided.

## open decisions for you

1. **DHT, yes or no?** It finds a device no circle member can, at the cost of telling strangers
   that a key is online and from which IP. Proposal: no for now; revisit after step 4.
2. **Which devices may introduce and relay?** Proposal: opt-in per device, computers on mains
   power by default, never a phone on mobile data; a relay capped (e.g. 1 GB a day, the api
   channel only, circle members only).
3. **Should the app offer port mapping?** Today only `kula-node share --map-port` asks the
   router. A phone or the Mac app could offer the same switch with an explanation.
4. **Dual-stack on the phone by default?** The same as kula-node (on, except while v1 is open)
   is the proposal.
5. **iroh as a dependency** (native Rust in the apk and in kula-node) for step 4, after a spike,
   or wait for libp2p's or Node's own QUIC to mature.
