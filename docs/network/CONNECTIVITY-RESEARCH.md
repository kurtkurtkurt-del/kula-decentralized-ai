# kula over the internet: connectivity and security research

Research of 13 November 2026. Nothing here is built; nothing in the code changed. Web sources
are from 2025 and 2026 and are listed at the end. Where a number is my own estimate and not a
measurement or a cited figure, the text says "estimate".

## 0. The target and the short answer

**Target (owner, 13 Nov 2026).** In about two months (mid-January 2027) friends around the world
join their phones and computers over the internet and run a large open-weight model together, on
kula's own software and under kula's own security. Friends only, no strangers. The
infrastructure must not be built around one model: it has to run whatever the best open model is
at the time (today usually a very large mixture-of-experts model) and keep working as models
grow.

**Decision proposed.** Build one thing first, the **kula link**: an authenticated, encrypted
connection between two paired devices that dials a key and not an address, goes direct whenever
the networks allow (IPv6, router port mapping, QUIC hole punching), and otherwise falls back to
a relay run by a device of the circle. The existing gate protocol runs unchanged inside it, and
ggml's RPC stays on 127.0.0.1 behind the gate. On top of the link, allow split mode between
friends' homes with a planner that cuts the model into as few internet hops as possible. iroh
1.x is the candidate library for the link, after a two-week spike; if the spike fails, the
fallback is the gate's existing TCP + TLS over IPv6 and mapped ports plus the relay code kula
already has.

**The three findings that shape everything.**

1. **Speed over the internet is set by the number of internet cuts, not by bandwidth or phone
   count.** Every generated token crosses every cut once. Tokens per second are at most
   `1 / (cuts × round-trip time + compute time)`. Ten cuts at 100 ms give under one token per
   second before any computing. So the architecture must minimise cuts (few, large spans; one
   home holding the whole model whenever one can), and treat the many-phone split as the slow
   path for work that can wait.
2. **A friend who computes a slice of the model can read the conversation.** Published attacks
   (CCS 2025 and others) rebuild prompts from intermediate activations, at deep layers too.
   Phones offer no usable enclave to an ordinary app (Android's protected VMs are for
   platform-signed apps only). Cryptographic alternatives are far too slow. So the limit on
   what a peer sees is a policy, the trust ring, not a technical guarantee; and wrong results
   are caught by checking (replication, canaries, activation fingerprints), not prevented.
3. **A direct connection is usually possible but never always.** The largest measurement so far
   (4.4 million attempts, 167 countries) finds hole punching succeeds about 70 % of the time
   once both sides have a helper; Tailscale reports over 90 % in typical conditions and
   near-total failure on some carrier-NAT networks. A fallback is therefore part of the
   foundation. The only fallback with no outside party is a relay on a reachable device of the
   circle; every other fallback (n0's relays, Tor, Nostr relays, a DHT) involves strangers'
   machines that see metadata, and is the owner's decision.

**What needs the owner's decision** is collected in section 8.

## 1. Where kula stands (read from the repo)

- **One port, one protocol.** The gate (`docs/GATE.md`, `Gate.kt`, `node/src/gate.ts`): TLS 1.3
  with a self-signed certificate per device, pinned by fingerprint on both sides, a one-time
  pairing code whose proof covers both fingerprints, replay and clock checks, one master at a
  time on the `rpc` channel. ggml's RPC server and the worker API listen only on 127.0.0.1.
- **Identity.** A device key (Ed25519, or P-256 where needed) with the device id as the first
  16 bytes of SHA-256 of the public key; an Android Keystore attestation exists (`Attest.kt`,
  `KeyStoreAttester.kt`); a hash-chained signed ledger per device (`docs/AUDIT.md`).
- **Internet, step 1 is in the code** (`docs/INTERNET.md`): dual-stack gate on kula-node, router
  port mapping (PCP, NAT-PMP, UPnP) as opt-in, several addresses in the QR. Its plan already
  names the next steps: phone dual-stack, a circle address book, QUIC hole punching with a
  circle introducer (iroh after a spike), a limited relay on a circle device, a DHT only if
  decided.
- **A relay exists as code** (`docs/RELAY.md`, `node/relay/`, `Relay.kt`): a WebSocket pipe;
  the gate's TLS runs end to end inside it, the relay sees TLS records only. It was written for
  a hosted service and stopped there; the same program can run on a circle computer.
- **Brain-to-brain messages exist as pure code** (`node/src/godseye/net/`): rings
  (home, circle, world), offers, asks, grants, signed receipts, quorum and canary checking,
  reputation, two-hop warnings.
- **The passport** (`app/src/passport/contract.ts`, measured by device-passport's
  `passport-core`): RAM budget, memory bandwidth, thermal state, link speed. It is exactly the
  capability record a planner needs.
- **llama.cpp b11157** with RPC protocol 7.0.0; equal versions only.
- **The app's account server** (`docs/SERVERS.md`: the Mac's local server in development,
  kula's own Supabase project for a release apk, a demo world while that is empty) is not in
  the cluster's path and nothing here puts it there. It must not become the meeting point for
  devices by convenience: that would be a hosted server in the middle.

**Three earlier decisions the new target touches.** They are the owner's to change; the report
assumes the new target changes them only as far as stated:

| earlier decision | where | what the target needs |
|---|---|---|
| "Split mode never goes over the internet" | `INTERNET.md`, decision 4 | split mode between homes of the friends ring is allowed, as the slow path |
| "A model is never split across homes" | `BEYIN-NET.md` | the same; whole-model work (apart mode) stays the preferred way between homes |
| "The internet path is parked" | circle decisions, 11 Nov | un-parked for friends; strangers and the world ring stay closed |

Unchanged and respected: no hosted relay or tunnel of ours; ggml RPC never bound to the
network; no strangers; every home tests devices for itself.

## 2. The scale the infrastructure must handle

This section is model-agnostic. Two current frontier open models serve only as illustrations.

### 2.1 What a frontier open model looks like today

| | DeepSeek V4 Flash (July 2026) | DeepSeek V4.1 Flash (Sept. 2026) | a small MoE for comparison |
|---|---|---|---|
| total parameters | 284B | 552B backbone, plus 196.6B of lookup tables ("Engram") read sparsely | about 30B |
| active per token | 13B | 8B (prompt), 16B (generation) | about 3B |
| layers | 43 | 40 (20 causal encoder + 20 decoder) | about 48 |
| experts per layer | 256 routed + 1 shared, 6 used | 384 routed + 1 shared, 6 used | about 128, 8 used |
| hidden width | 4096, carried as 4 parallel residual streams | not confirmed (one source: about 5.1k) | about 2048 |
| weights at about 4 bit | about 150 to 170 GB (community GGUF figures) | about 298 GB without the tables, about 500 GB with | about 18 GB |
| smallest usable quantization | not checked | about 122 GB (1-bit class, 83 % top-1 agreement) to 165 GB (2-bit class) | n/a |
| runs in llama.cpp | yes, architecture `deepseek4` is in b11157 (checked in the vendored tree) | reported merged in mainline on 25 Oct 2026; **not in b11157** (the tree has no Engram code) | yes |

Sources: the Hugging Face card, the V4 paper, a local-hosting guide with the file sizes, the
Transformers documentation (section 10). The small-MoE column is from memory, for scale only.

What this means for any design:

- **Weights are 150 to 500 GB**, forty or more layers, thousands of experts. One layer alone is
  4 to 8 GB at 4 bit: more than many phones can give. One expert is only 15 to 20 MB.
- **Only 3 to 5 % of the weights are touched per token.** The rest sits idle. This is the one
  property that makes phones plausible at all, and it is not used yet (2.5).
- **New architectures arrive faster than engines follow.** V4.1 added an encoder-decoder
  layout, shared state across layers and disk-backed lookup tables; llama.cpp followed about
  six weeks later. "Runs whatever is best" in practice means "runs whatever the vendored
  llama.cpp tag runs", and a tag change moves the whole circle at once, because RPC only talks
  between equal versions.

### 2.2 How llama.cpp's RPC splits a model (read from the b11157 tree)

- The split is at the level of the **compute graph**, not of a model family: tensors are placed
  on devices layer by layer and the scheduler cuts the graph where the device changes. Any
  model llama.cpp runs can be split this way. That is the model-agnostic mechanism kula already
  has, and the reason to keep it.
- **Star topology.** The master talks to each worker; workers never talk to each other. An
  activation that goes from worker A to worker B travels A → master → B.
- **About one round trip per remote span per token** in the steady state: `SET_TENSOR` and
  `GRAPH_RECOMPUTE` are sent without waiting, `GET_TENSOR` waits for the answer. (Read from
  `ggml-rpc.cpp`; to be confirmed by measurement.)
- **Expert tensors are one block per layer** (`ffn_gate_exps` and its siblings are
  three-dimensional tensors holding all experts). Stock llama.cpp cannot put single experts on
  different devices; `--cpu-moe` only moves a layer's experts between GPU and CPU on one host.
- **Weights live in RAM on the worker.** They arrive over the wire or from a local cache found
  by hash (`SET_TENSOR_HASH`, an FNV hash, good for caching and not for security).
- **No fault tolerance.** A worker that disappears takes the session with it (and, per
  `SECURITY.md` finding 19, can abort the master's process).
- **No authentication, no encryption, a client can write the server's memory.** The upstream
  README says: "Never run the RPC server on an open network or in a sensitive environment!"
  The 2024 advisories (for example CVE-2024-42479, an arbitrary write in `set_tensor`, fixed in
  b3561) show what that means.

### 2.3 Activation traffic over a cut

Per token, one cut carries the inter-layer state once: `width × streams × bytes per number`.

| inter-layer state | bytes per token per cut (32-bit floats) | as 16-bit |
|---|---|---|
| width 2048, one stream | 8 KB | 4 KB |
| width 4096, one stream | 16 KB | 8 KB |
| width 8192, one stream | 33 KB | 16 KB |
| width 4096, 4 streams (the V4 family; b11157 sets the inter-layer width to `hc_mult × n_embd`) | 66 KB | 33 KB |

In the star, each remote span costs the master one upload and one download of that size per
token.

- **Generation.** Ten remote spans at 66 KB: 1.3 MB per token through the master. At one token
  per second that is about 10 Mbit/s, half of it upload, and about 4.7 GB per hour. Fine on
  home broadband, out of the question on mobile data. A conventional model at width 4096 needs
  a quarter of that.
- **The prompt is the bandwidth problem.** A 2,000-token prompt is 131 MB per cut per direction
  at 66 KB per token. With ten remote spans the master uploads and downloads about 1.3 GB
  before the first answer token. On a 20 Mbit/s uplink that is about nine minutes (estimate).
  Long prompts over many cuts do not work as they are.

What reduces it, in order of effect: fewer cuts; 16-bit activations on the wire (half);
workers forwarding to each other directly (the master's uplink drops out, total traffic
halves); keeping the conversation's state on the workers so a prompt is paid once; sending the
prompt in chunks so the stages overlap.

### 2.4 Token rate at internet round-trip times

`seconds per token ≈ Σ round-trip time of each remote span + compute time`. Compute time for a
frontier MoE on phone-class memory is taken as 0.3 s per token (estimate: 13 to 16 billion
active parameters at about 4.5 bits are 7 to 9 GB of memory traffic per token; the passport
measures what a device really moves). Network jitter, loss and thermal throttling come on top,
so real numbers will be lower than these ceilings.

| remote spans | 20 ms | 50 ms | 100 ms | 200 ms |
|---|---|---|---|---|
| 2 | 2.9 tok/s | 2.5 | 2.0 | 1.4 |
| 5 | 2.5 | 1.8 | 1.25 | 0.77 |
| 10 | 2.0 | 1.25 | 0.77 | 0.43 |
| 30 | 1.1 | 0.56 | 0.30 | 0.16 |
| experts fanned out across the internet (one round trip per layer, 40 layers) | 0.9 | 0.43 | 0.23 | 0.12 |

Reading the table:

- **Thirty phones in thirty places is the worst layout**: a sixth of a token per second on
  intercontinental links, before jitter.
- **A relayed path counts double or more**: its round trip is the sum of both legs.
- **Placing single experts across the internet is worse than placing spans** whenever there are
  fewer spans than layers, because every layer needs its own round trip. Expert placement
  belongs inside a home, on the local network, where a round trip costs a millisecond.
- For comparison, Petals reported up to 6 tokens per second for a 70B model and up to 4 for a
  180B model over the internet, with GPU servers each holding many consecutive layers, so two
  to four hops. The lesson is the same: few hops.

### 2.5 What does not work, and what would

Does not work:

- Stock RPC with one remote phone per layer, chatting interactively.
- Long prompts across many cuts in the star (2.3).
- Single experts placed across internet links.
- Phones on mobile data as workers (carrier NAT, data volume, battery, Doze).
- Pushing weights from the master over the internet (tens of GB over a home uplink).
- Expecting b11157 to run a model whose architecture was merged after it.

What would, in the order it should be built:

1. **The planner minimises internet cuts.** If one home of the circle can hold the model (a
   friend's workstation, or several devices on one local network), run it there whole (apart
   mode): zero cuts, the internet round trip is paid once per request and not once per token.
   Otherwise cut into the fewest, largest contiguous spans, ordered so the sum of round-trip
   times is smallest. The many phones of one home count as one place.
2. **Every worker fetches its own weights** by URL and SHA-256 (the `/load` rule kula already
   has) and RPC finds them in the local cache by hash.
3. **Speculative decoding.** A small draft model at the asker's home proposes several tokens;
   the distributed model checks them in one pass. The network cost is then divided by the
   number of tokens accepted per pass (the compute cost is not). Papers from 2025 model exactly
   this trade-off for edge networks. Example (estimate): ten spans at 100 ms with three tokens
   accepted per pass move from 0.77 to about 1.6 tokens per second.
4. **Throughput instead of latency.** Many independent pieces in flight at once (the "pieces"
   of `BEYIN-NET.md`): each stream is slow, the sum is not. This is where a circle of sleeping
   phones is strong: long jobs overnight.
5. **Weights served from flash, not RAM** (later). Because only 3 to 5 % of an MoE is touched
   per token, a worker can map the weight file from storage and keep only the hot experts in
   memory. A phone with 12 GB of RAM and 200 GB of free storage could then hold twenty times
   more of the model. llama.cpp already reads V4.1's lookup tables this way (`--lazy-mode`);
   the RPC server does not. This is the lever that makes very large models fit on few devices,
   and it needs a patch and measurements (random-read speed of phone storage decides it).
6. **Home span server and direct forwarding** (later). One device per home fronts the home's
   devices, so a home is one cut; workers pass activations to the next worker directly.

Scale illustration only, not a sizing: with stock RPC (weights in RAM, 6 to 10 GB usable per
flagship phone) 300 GB of weights are thirty to fifty phones; a laptop with 64 GB counts for
six to eight phones; a workstation with 512 GB holds the 3-bit build alone. The formula
(`weights ÷ usable memory`, then the table above) holds for any model.

## 3. Threat model

Assets: the prompt and answer; the activations and the conversation state on workers; the
worker's memory, processor, storage, battery and data volume; device and home keys; the pairing
moment; the membership of the circle (who is whose friend); addresses and online times.

Adversaries. A1 to A5 are those of `SECURITY.md`; the internet adds the rest.

| | adversary | what they can do | answer in the design |
|---|---|---|---|
| A1 | a stranger on the same network | connect, listen, redirect | gate TLS with pinned keys (exists) |
| A2 | a stranger who saw a pairing code | pair within its lifetime | 10-minute one-time code (exists); add a confirmation both people see (5.1) |
| A3 | a paired device that turned bad, as master | make the worker load a model, write the worker process's memory over RPC | grants per peer, one master, worker confinement, fresh process per session (5.6) |
| A4 | another app on the same phone | reach 127.0.0.1 | unchanged, open; no cheap fix |
| A5 | the model's download host | wrong or huge file | URL policy and SHA-256 (exists) |
| A6 | anyone on the internet path (ISP, café Wi-Fi, a scanner) | scan the gate port, read and change packets, block UDP | everything inside QUIC/TLS between pinned keys; an address is only a hint; handshake limits (exist) |
| A7 | the operator of a third-party piece (relay, DNS, DHT node, signalling relay) | see IP addresses, key ids, timing, volume; drop or delay; not read content | no such piece by default; each is an opt-in with its visibility written down (section 4) |
| A8 | a friend's device that is curious, as worker | read the activations it computes and so the conversation | ring policy; the ends of the model stay home; no worker sees the whole circle (5.6) |
| A9 | a friend's device that lies, as worker | return wrong tensors, slow down, drop out | replication, canaries, activation fingerprints, receipts, two-hop warnings (5.7) |
| A10 | many fake identities (Sybil), or a peer that hides the honest ones from you (eclipse) | flood a discovery system, win votes, isolate a device | not reachable in the friends ring: admission is a person's act; discovery is not a public DHT (5.8) |
| A11 | a thief or a lost device | use the device's keys and pairings | home roster with removal, short-lived device credentials (5.9) |
| A12 | whoever records traffic today to decrypt later | read old prompts once key exchange breaks | hybrid post-quantum key exchange where the library offers it (5.5) |
| A13 | the supply chain (a model file, llama.cpp, a new network dependency, the apk) | run code on every device | pinned tag and hashes, own signing key (exist); a new dependency is a decision (section 8) |
| A14 | a global observer correlating traffic | learn who works with whom and when | out of scope; named as a risk |

Not promised: hiding a prompt from the device that computes on it; anonymity towards friends
(a direct connection shows each side the other's IP address); protection against a rooted or
unlocked worker; availability against a party that blocks UDP and relays.

## 4. The options compared

### 4.1 Connecting

"Third party" means a machine that neither the owner nor a friend runs.

| option | what works peer to peer | third-party piece, and who runs it | what that piece sees | maturity and fit (Android, React Native/Kotlin, Node) |
|---|---|---|---|---|
| **IPv6 direct** | everything, if both ends have global IPv6 and inbound is allowed | none | nothing | In step 1 on kula-node. Mobile carriers are largely IPv6 (T-Mobile US about 93 %), but mobile and many home networks drop unsolicited inbound, so alone it is not enough; with simultaneous sending (hole punching) IPv6 is the easy case because no address is rewritten |
| **Router port mapping** (PCP, NAT-PMP, UPnP) | everything, where the router has a public IPv4 | the person's own router | nothing outside the home | In step 1, opt-in. Fails behind carrier NAT |
| **QUIC + hole punching** (the technique under iroh, libp2p DCUtR, Tailscale) | data path direct after a simultaneous open | an introducer both can already reach, to exchange addresses and timing; an address reflector (classic STUN, or QUIC address discovery from any peer) | introducer: both IPs, key ids, timing; no content | Success about 70 % ± 7 % when the helper stage works (4.4 M attempts, 167 countries, IMC 2026); TCP and QUIC equal; 97.6 % of successes on the first try. About 29 % of attempts fail earlier, at the helper stage. Fails when both sides have per-destination mappings (older data: about 11 % of peers; about 40 % of carrier NATs in 2016). No mobile-only breakdown published |
| **iroh 1.x** (n0, Rust) | dial by public key; QUIC with NAT traversal in the handshake (QUIC-NAT-traversal draft) and multipath; n0 says about 95 % of data typically flows direct | relays for the first packets and as fallback; by default n0's public relays and n0's DNS (`dns.iroh.link`). Both replaceable: relay binary is open source and self-hostable, discovery is pluggable | relay: which keys connect, which pairs exchange traffic, IPs, when and how much; no key to decrypt; not told when a pair goes direct. n0 calls its public relays rate-limited and not for production | Stable wire protocol and API since June 2026; 1.1.0 (Sept. 2026) fixed three security bugs. Official Node.js and Kotlin bindings; **Android must be built from source with the NDK**, the Maven artifact does not cover it; n0 says to run it in a foreground service. Best fit of the libraries: it matches "identity is the key, an address is a hint" |
| **libp2p** (DCUtR, circuit relay v2, AutoNAT) | direct after DCUtR; a toolbox with DHT, pubsub | relays for coordination: any public libp2p node, strangers; bootstrap nodes | relay: peer ids, IPs, timing; relayed data is encrypted end to end; public relays cap a relayed connection (defaults 2 minutes, 128 KiB), so they coordinate, they do not carry | Mature in Go and Rust. Weak where kula lives: js-libp2p lacks solid QUIC hole punching in Node, the JVM version is immature on Android. Public-DHT discovery brings the eclipse and Sybil problems measured on IPFS |
| **WebRTC data channels** (ICE, STUN, TURN) | direct after ICE; the most field-tested NAT traversal | STUN servers (usually Google's public ones), TURN relay for the rest (someone must run or rent it), and a signalling channel | STUN: your IP; TURN: IPs, timing, volume, encrypted payload; signalling: connection offers | Very mature on Android (`react-native-webrtc`, libwebrtc) and usable in Node. Heavy, browser-shaped, identity is not key-native, data channels are not built for bulk tensors. A fallback candidate, not the foundation |
| **Tailscale** (WireGuard mesh) | WireGuard tunnels, direct when possible; "well north of 90 %" direct in typical conditions (Tailscale, 2025) | Tailscale's coordination server (accounts, keys, who may reach whom) and DERP relays; peer relays on your own nodes since 2025 | coordination: device list, keys, IPs, connection metadata; DERP: encrypted packets, IPs, timing | Excellent product; the gate would work over it unchanged with kula's TLS inside. But: an account at a company for every friend, the company in the control path, and on Android it takes the single VPN slot. Tailscale itself reports that Indian carrier NATs often prevent direct paths. Useful at most as a quick test rig |
| **headscale** | the same clients | a coordination server (and usually a DERP) that **we** would run on a public address | the same, on our machine | That is a server of ours: against the standing rule |
| **Yggdrasil, cjdns** | an encrypted IPv6 overlay with key-derived addresses | public peers run by volunteers, unless every home peers directly | peers on the route: metadata of the traffic they carry | Yggdrasil is alive but alpha (0.5.13, Feb. 2026) and slowing; cjdns is mostly historical. Traffic follows the overlay's tree, so latency is poor; on Android it needs the VPN slot. Not a fit |
| **Tor onion services** (Arti) | a device behind any NAT becomes reachable by its onion address; strongest metadata protection | the Tor network, thousands of volunteer relays | nothing linkable: no relay knows both ends | Arti hosts onion services and ships in Tor's Android VPN beta; Briar has run Tor in the background on Android for years. Round trips of hundreds of milliseconds and low throughput: unusable per token (section 2.4), good for **signalling** and for whole requests in apart mode |
| **I2P** | similar idea, garlic routing | I2P's volunteer routers | nothing linkable | Slow start, heavy router on Android. No |
| **Veilid** | private routes, DHT, Rust core with Flutter bindings | Veilid's public network and bootstrap nodes | route hops see encrypted traffic | 0.5.0 in Dec. 2025, pre-1.0, small network. Too young to build on |
| **Nostr relays as rendezvous** | nothing by itself: a mailbox for small encrypted notes ("here is where I am, let us punch now") | public Nostr relays, hundreds, run by anyone | ciphertext, the recipient tag, IP, timing (gift wrap hides the author, not the addressee) | Simple (WebSocket on port 443 passes everywhere), libraries on every platform; Trystero uses Nostr, BitTorrent trackers and MQTT this way for WebRTC. Only for signalling, with rendezvous keys that change per period so a relay cannot follow a device |
| **BitTorrent mainline DHT** (pkarr, BEP 44) | signed records "key → current address or relay", readable by anyone who knows the key | millions of strangers' DHT nodes | the key looked up, the IPs of publisher and seeker | Proven and huge; iroh can use it. Kademlia DHTs are open to Sybil and eclipse attacks (shown repeatedly on IPFS, again in 2025). It only finds, never carries |
| **A relay on a circle device** | bytes piped by a device a friend already runs; gate TLS end to end inside | none; needs one reachable device in the circle (IPv6 or mapped port) | a friend's device sees IPs, timing, volume, TLS records | kula's own relay code exists and is tested on the computer side; iroh's relay can be self-hosted the same way |
| **Bluetooth, Wi-Fi Direct, Wi-Fi Aware** | nearby devices without any network | none (Google's Nearby Connections is a library in Play services, offline) | nothing | Wi-Fi Direct is mature on Android; Wi-Fi Aware depends on the chip and its iOS 26 interop is still rough; Bluetooth LE is too slow for activations (section 2.3) and fine for pairing. For the same room; not on the path to the target |

### 4.2 Running on Android in the background

- **A phone cannot keep a port open to the internet.** On mobile data it sits behind carrier NAT
  and a firewall; on Wi-Fi behind the home router. A phone always dials out or hole-punches;
  the reachable devices of a circle are computers at home.
- **Doze** (unplugged, still, screen off) suspends network access, ignores wake locks and
  defers jobs until rare maintenance windows. A foreground service is not exempt from it; only
  the user's battery-optimisation exemption is, and Google Play allows asking for that only in
  narrow cases. **Connecting a charger ends Doze.**
- **Foreground services** must declare a type. `dataSync` and `mediaProcessing` are limited to
  six hours per day since Android 15. kula's worker already uses `specialUse` in its own
  `:worker` process, which has no such timer. Android 16 tightened jobs started from a
  foreground service, not the service itself. Vendor battery killers remain a field problem.
- **Wake-up from outside** in Doze is only possible through Firebase Cloud Messaging, which is
  Google's service and sees the wake-up times.
- **NAT mappings for UDP die after tens of seconds**, so a link kept alive needs a packet every
  25 seconds or so, which costs battery when unplugged.

The rule that removes almost all of this: **a phone works for others only while charging and
on unmetered Wi-Fi.** Then there is no Doze, no carrier NAT (home routers punch far better), no
data bill, and heat is the only limit. That is also when a phone is idle. No Google wake-up
service is needed. The asking phone is in the person's hand, in the foreground.

### 4.3 How others handle workers they do not trust

| project | what it does | what kula can take |
|---|---|---|
| **Petals** | layers of one model on volunteers over the internet. Its own documentation: servers holding the first layers can recover the input; a faulty or malicious server can return wrong outputs, not checked by default; for sensitive data run a private swarm of trusted people. Fault tolerance and load balancing across leaving servers are solved there | the proof that it works at a few tokens per second with few hops; the private-swarm answer (that is kula's friends ring); the way sessions survive a leaving server |
| **Exo** | splits models across a home's machines; discovery on the local network; no authentication or TLS on its API according to a 2026 guide | nothing for security; it assumes a trusted network |
| **llama.cpp RPC** | graph-level split, proof of concept, insecure by its own words | the model-agnostic split; it must stay behind the gate |
| **Bittensor** | a token; validators score miners; known problems are weight copying and validator collusion | a warning: once a score pays, the score is gamed. Needs a chain and a currency, which kula refuses |
| **Prime Intellect, TOPLOC** | a fingerprint of the top activations, 258 bytes per 32 tokens, checked up to 100 times faster than the inference; tolerant of hardware differences; detects a changed model, prompt or precision | the right tool to compare two honest devices that do not produce identical bits |
| **Nous Psyche** | decentralised training; a coordinator on Solana; random witnesses check results with Bloom filters; pauses when quorum is lost | random witnesses and quorum, without the chain |
| **Gensyn Verde** | two or more providers run the task; on disagreement a bisection finds the single step that differs, and a referee re-runs only that; needs bit-exact operators (RepOps) | the idea of pinpointing a disagreement; bit-exact operators do not exist for phone processors |
| **zkML, opML** | cryptographic or fraud-proof verification of inference. Proofs take seconds for GPT-2 and minutes for a 13B model on servers | nothing for phones in the coming years |
| **Canaries with reference activations** (arXiv 2607.19490, July 2026) | the asker mixes secret inputs with known activations into the traffic; a tampering node deviates far more than hardware noise; the abstract reports perfect separation over 408 configurations | fits kula directly: `verify.ts` already has canaries for whole pieces; this is the same for spans |
| **Enclaves on phones** | Android's protected VMs (pKVM, AVF) isolate memory even from the host, but only platform-signed apps may create them; confidential computing for ordinary Android apps is still a research proposal (MobiSys 2026); no enclave reaches the phone's GPU or NPU | not available. Keystore attestation proves where a key lives and that the boot is verified, not what a computation did |

## 5. The recommended architecture

Seven layers. Each is independent of the model and of the layer below it.

```
  7  rings and grants      who may ask whom for what          (home, circle; world closed)
  6  inference security    what a worker sees, what is checked
  5  placement             spans, cuts, joins and leaves       (model-agnostic planner)
  4  the gate              KULA2 inside TLS, channels rpc/api  (exists, unchanged)
  3  the kula link         dial a key: direct first, circle relay as fallback
  2  finding each other    local network, circle address book, circle anchor
  1  identity              device key, home key, roster
```

### 5.1 Identity and keys

- **Device key** (exists): generated on the device, in the Android Keystore where possible,
  never exported. The device id stays the hash of the public key.
- **Home key** (new): one key per home, above its devices. It signs the **roster**: the list of
  the home's device keys with a version number that only grows. Friends pair with a home once
  and accept its devices by the roster, so adding a phone at home needs no new pairing with
  every friend, and removing one is one signed message. The home key lives on two of the home's
  devices and on paper (5.9).
- **Link key**: the transport's own key (an iroh endpoint key), bound to the device key by a
  signature exchanged over a link that is already pinned. It can change without touching the
  identity.
- **Attestation** stays a hint (`Attest.kt`): a statement, rooted at Google, that the key is in
  secure hardware and the boot is verified. The chain can be checked offline against pinned
  roots; Google changed the root in 2026, so both must be kept. It says nothing about what the
  device computes.
- **Pairing at a distance** (new, needed for friends abroad). Today pairing is a QR scan in the
  same room. For a friend in another country: an invitation (home key fingerprint, one-time
  code, where to meet) sent over a channel the two already use, and then **both people read
  the same six digits to each other** on a call before either side stores the other. The digits
  come from both keys and the session, so whoever sat in the middle of the first channel is
  caught. This also closes the open point in `SECURITY.md` that the master screen says "paired"
  without a check.

### 5.2 Finding each other

In this order; identity is always the pinned key, so a wrong address costs a timeout and never
trust.

1. **Local network**: mDNS, as today (with a per-network id later, `SECURITY.md` finding 15).
2. **The circle's address book** (`INTERNET.md` step 3): each device keeps the last addresses
   where its paired devices answered and tells them over links that are already pinned.
   Records are signed by the device, carry a counter and a short lifetime, so an old record
   cannot be replayed.
3. **A circle anchor**: one or more reachable devices of the circle (a home computer with IPv6
   or a mapped port) that every member can find at a stable address. The anchor keeps the
   address book, introduces two members for hole punching, tells a member the address it is
   seen from (QUIC address discovery, so no public STUN server), and relays within caps.
4. **Outside meeting points, only if decided** (section 8): a Tor onion service on the anchor
   (reaches a circle whose every device is behind carrier NAT), Nostr relays or the mainline
   DHT holding records sealed to the circle under a lookup key that changes per period.

### 5.3 Transport: the kula link, direct first

One API for everything above it: `open(deviceKey, channel)` gives a byte stream. Underneath it
tries, in parallel, and keeps the best:

1. the local network address;
2. global IPv6, with simultaneous sending so stateful firewalls open;
3. the router's mapped port (opt-in, exists);
4. QUIC hole punching through the anchor;
5. the relay on a circle device.

A relayed link keeps trying to become direct. QUIC brings what phones need: one UDP socket,
many streams without blocking each other, and migration when the phone changes network.

**Library.** iroh 1.x after a spike (section 6); it already implements 2, 4 and 5 and dials
keys. It is configured with **no n0 infrastructure**: a relay map that names only circle
anchors, n0's DNS discovery off, kula's address book as the discovery service. The spike must
confirm that this configuration works and that an anchor can run without a public DNS name and
a public certificate authority (iroh's relay normally wants both; a relay cannot read or forge
anything, so a pinned self-signed certificate would be enough, if the library allows it).

**Fallback plan without a new dependency**, if the spike fails: the gate's TCP + TLS over IPv6
and mapped ports, plus kula's existing relay program on a circle computer. No hole punching, so
more traffic is relayed and slower; the layers above do not change.

### 5.4 Fallback when no direct path exists

Ranked by how little any outsider learns:

| fallback | outsider involved | sees | cost |
|---|---|---|---|
| **relay on a circle anchor** (recommended default) | none | a friend's device: IPs, timing, volume, ciphertext | needs one reachable home in the circle; double round trip |
| **Tor onion service** for signalling, and for whole requests | Tor volunteers | nothing linkable | slow; a second Rust dependency (Arti); its onion-service side was still marked young in 2024 |
| **Nostr relays** for signalling only | relay operators | ciphertext, a rendezvous tag, IP, timing | none to speak of; only helps hole punching, carries no traffic |
| **n0's public iroh relays** | n0 | endpoint keys, pairs, IPs, timing, volume | zero effort, works at once; rate-limited, "not for production" by n0's own words |
| **mainline DHT** for addresses | strangers' nodes | the key sought and both IPs | Sybil and eclipse exposure |

The strict answer to "the most secure fallback with no server of ours": the **circle anchor**
when any home of the circle is reachable; when none is, **Tor** is the most secure and the
slowest, and n0's relays are the most practical and the most visible. Both are third parties.
Neither is in the default.

### 5.5 Encryption and replay protection

- **Outer layer**: QUIC with TLS 1.3 between link keys. **Inner layer**: the gate's TLS 1.3
  between device certificates with the KULA2 handshake, unchanged. Two layers cost little next
  to inference and mean the gate's guarantees do not depend on the new library. Later the two
  can be bound into one handshake.
- **No 0-RTT.** QUIC's early data can be replayed; it stays off.
- **Replay**: the gate's nonce and two-minute clock window (exists); every work or span request
  carries session id, a step counter that only grows, the model's hash and the span, inside the
  encryption; address records carry counters; receipts are hash-chained (exists).
- **Record now, decrypt later**: prompts are worth protecting for years. The hybrid key
  exchange X25519MLKEM768 is an RFC since August 2026 and already carries a large share of web
  traffic. Use it on the outer layer as soon as the library's TLS offers it; signatures can
  stay classical for now.
- **The pairing code**: today an HMAC over a 64-bit one-time code, good for ten minutes. For
  pairing at a distance add the spoken digits of 5.1; a password-authenticated key exchange
  would be the next step up.

### 5.6 Inference security: what a worker sees and can do

What a worker **sees**, honestly:

- A worker holding a span sees the activations entering and leaving it for every token. From
  those the prompt can be rebuilt (Petals says so itself; CCS 2025 shows three attacks; a 2025
  paper shows depth does not protect; shuffling the hidden state does not either). Treat every
  worker in a split as able to read the conversation.
- No technical fix exists on phones today: no enclave for ordinary apps (4.3), and computing on
  encrypted data is slower by several orders of magnitude.

So the limits are these:

1. **The ring decides, per conversation, set by the person, never widened by software**
   (exists as `Ring` in `types.ts`). Home-only work never leaves home. Friends-ring work may be
   read by the friends who compute it; the owner decided on 11 Nov that personal data may go to
   friends' devices. The app says so in plain words where the ring is chosen.
2. **The ends stay home.** Token embedding, the first span, the last span and the sampler run
   in the asker's home. Friends receive only middle-layer activations, never text. This raises
   the cost of reading; it is not privacy.
3. **Star topology on purpose.** Workers talk only to the master. A worker learns neither who
   else takes part nor their addresses. Each friendship stays between two homes.
4. **Nothing is kept.** Conversation state on a worker lives in memory, bound to the session,
   and the worker process ends with the session. No activation is logged.
5. **Apart mode first.** A whole model on one friend's home shows the conversation to one
   friend; a split shows it to several.

What a worker (or a master) **can do**, and the limits:

- ggml's RPC lets the master write the worker process's memory. The gate decides who may be
  that master; across the internet this needs more than pairing:
  - **Grants**: a paired home gets rights per channel (`api`, `rpc`), with quotas and an end
    date, signed by the home key. `rpc` is granted to friends explicitly, not by default.
  - **One master, one session, one fresh worker process**; memory cap; the worker's own rules
    on heat, battery, charging and Wi-Fi always win (the owner's order: privacy, device health,
    speed).
  - **Confinement** (phase 2): the RPC server in an Android isolated process that receives its
    sockets and weight files as file descriptors, so a break-in reaches neither the app's data
    nor the device key. Today the `:worker` process shares the app's user id.
  - **Model files** only by URL policy and SHA-256, never pushed (exists).
- Towards the master: a worker returns only tensors of the size the master asked for; the
  master adds time limits and must survive a vanished worker (finding 19).

### 5.7 Wrong tensors

Prevention is impossible; detection is cheap enough. Three checks, all model-agnostic:

1. **Canary inputs** (phase 1): the master mixes inputs whose activations at each cut it already
   knows (computed at home once per model and span) into the stream. A worker cannot tell them
   apart. Deviation far above hardware noise is proof.
2. **Activation fingerprints** (phase 2): a TOPLOC-style fingerprint of the top values at each
   cut, kept in the receipt. Two devices that ran the same span agree within a tolerance even
   on different chips; text or bit comparison would not.
3. **Replicated spans** (phase 2): a second home holds the same span; a share of tokens is sent
   to both (BOINC's adaptive replication, already in `verify.ts` for whole pieces: everything
   for a new device, one in ten for a proven one).

The outcomes feed what exists: signed receipts, each home's own reputation book, warnings with
evidence that travel two hops. In the friends ring the purpose is mostly to find a broken
device or a bad build, and to keep honest people honest.

### 5.8 Sybil and eclipse

- **Friends ring**: an identity costs a human friendship and a spoken confirmation. There is no
  vote to win and no open table to flood. Credit already travels only along trust lines with
  limits (`credit.ts`), which bounds what any fake identity behind a friend can take to that
  friend's limit. This is the same bound social-graph Sybil defences aim for.
- **Eclipse** needs a discovery system an attacker can fill. The circle's address book has
  none: records are signed, come only from paired devices, and a wrong one costs a timeout. A
  malicious anchor can refuse service, which is why a circle should have two.
- **World ring, later**: this is where both attacks become real, and the reason not to adopt a
  public DHT now. What would be needed then: a cost per identity (hardware attestation, one
  key per real device), checks on every stranger's work (5.7 at full rate), and discovery that
  does not trust a single lookup path.

### 5.9 Losing and rotating keys

- **A device is lost or sold**: its home publishes a new roster without it; friends' devices
  drop it at the next contact. Device credentials become short-lived (weeks, renewed
  automatically by the home key) instead of today's ten-year certificate with no revocation,
  so a device that is not renewed fades out even from a friend who was offline.
- **The home key**: held by two devices of the home and printed once as a QR for a drawer.
  Later: split among three friends so that any two can restore it, and a commitment to the next
  key inside the roster so a thief of the current key cannot rotate it.
- **Honest fallback for now**: with a handful of friends, losing everything means pairing again
  by hand. That is acceptable for the first version and must not be at world scale.
- **Algorithms**: every signed object carries a version, so a change of signature scheme is a
  new version, not a new protocol.

### 5.10 Metadata

| who | learns |
|---|---|
| a friend you connect to directly | your home's IP address, when you are online, how much work flows |
| a worker in your split | middle-layer activations (so, the content), not the other participants |
| the circle anchor | who of the circle is online, from where, who relays how much |
| your ISP and the networks between | that two addresses exchange encrypted UDP, how much and when |
| a third-party piece, if one is switched on | what section 4.1 lists for it |

Reduced where cheap: device ids that differ per network in mDNS; records in any outside store
sealed to the circle; no outside lookups by default. Not hidden: traffic timing and volume.

### 5.11 Placement that does not depend on the model

- **Unit**: a shard, a named group of tensors from the model file (a layer's trunk, a layer's
  expert block, embeddings, head, lookup tables), with size and hash. The planner knows shards
  and never model families.
- **Inputs**: each device's signed passport (memory budget, memory bandwidth, heat, charging,
  storage), the measured round-trip time between the master and each device, the brain's
  forecast of how long each device stays (with its uncertainty), and the ring.
- **Objective**: fit the model; then the smallest sum of round-trip times over the cuts; then
  the fewest homes that see activations.
- **Rules that follow from section 2**: a home that fits the whole model wins outright;
  spans are contiguous; experts are spread only inside a home; devices of one build tag only
  (RPC protocol and kula version go into the gate's hello, so mixed circles are told to update
  and not left to fail).
- **Joining and leaving**: a worker takes a span as a lease with an end time and answers a
  heartbeat. First version: when a worker leaves, the master re-plans and replays the
  conversation through the new layout (slow, simple, correct). Later, as Petals does: the
  master keeps the inputs of each span and replays only the lost span onto a standby that
  already holds the weights on storage.
- **Out of scope for the brain**: the brain observes, warns and suggests placement on cards; it
  does not act on its own (standing rule).

## 6. What to build

### Phase 1: now to mid-January 2027, the path to the target

Goal: friends' homes in at least two countries, at least one phone in each, run one model that
none of the devices could hold alone, split across the internet, every byte inside kula's link,
no outside server in the path by default; with measured tokens per second and a session that
survives one worker leaving.

| weeks | work | done when |
|---|---|---|
| 1 | **Measure first, with what exists.** Two homes, one with IPv6 or a mapped port (step-1 code), the `rpc` channel allowed over that address for one paired friend, a small model split in two. | a table of tokens per second against round-trip time, to check section 2.4 on real links |
| 1 to 2 | **iroh spike**, time-boxed. Build iroh-ffi for Android arm64 into the apk; Node binding in kula-node; custom relay on a home computer; n0 discovery off. | exit criteria: apk size and build time acceptable; a phone on home Wi-Fi and a computer in another network connect by key and go direct; the relay works without n0 and, if possible, without a public DNS name; the foreground service holds the link for a night on a charger. Otherwise take the fallback plan of 5.3 |
| 1 to 3 | **Identity for a circle**: home key and roster; pairing at a distance with spoken digits; grants per channel; phone gate dual-stack and `addrs` in its QR (`INTERNET.md` step 2). | a friend abroad is paired without a QR scan; removing a device is one action |
| 3 to 5 | **The kula link**: `open(deviceKey, channel)` in kula-node and the app; direct paths in parallel; circle address book; one circle anchor (introducer, address reflection, capped relay); the gate running inside the link. | the gate's tests pass through the link; a relayed link upgrades to direct; the ledger shows which path carried what |
| 4 to 7 | **Split mode between homes**: the planner of 5.11 with cuts minimised; workers fetch weights themselves; time limits and no abort when a worker vanishes; re-plan and replay on leave; workers only while charging on unmetered Wi-Fi; the ends at home; canary inputs at the cuts; a draft model at home for speculative decoding if the first numbers call for it. | a session survives pulling one worker's plug; a tampering test worker is caught by a canary |
| 8 to 9 | **Field test** with the friends' real networks (live PDF from the start, as usual): which pairs go direct, which relay, tokens per second per layout, heat, data volume. | the numbers decide phase 2 and the open decisions of section 8 |

Model for the first run: any model the vendored llama.cpp tag runs that is too large for one of
the participating devices. The infrastructure does not care which. Moving to a newer tag for a
newer model is its own step (`tools/llama-src.mjs`), and moves all devices together.

Not in phase 1: strangers, a DHT, Tor, Nostr, n0's relays, payment, enclaves, cryptographic
proofs, Bluetooth or Wi-Fi Aware, expert-level placement across devices.

### Phase 2: making large models practical (first quarter of 2027)

- Weights served from flash for MoE experts in the RPC worker (2.5, point 5), measured on real
  phone storage. This decides how large a model a small circle can hold.
- A home span server (one cut per home) and direct worker-to-worker forwarding; 16-bit
  activations on the wire.
- Standby replicas and Petals-style replay of a single lost span.
- Activation fingerprints in receipts; replicated spans at adaptive rates.
- The RPC worker in an isolated process.
- Hybrid post-quantum key exchange on the link; short-lived device credentials.
- Two anchors per circle. If the field test shows circles with no reachable home: the owner's
  decision on an outside meeting point (Tor signalling is the proposal).

### Phase 3: only if the world ring is ever opened

- Admission cost per identity, attestation as one input, full-rate checking of strangers.
- Discovery that survives Sybil and eclipse attempts; sealed records in a public store.
- Recovery of a home key through friends; pre-committed next keys.
- Expert-level placement inside a home; enclaves if Android opens protected VMs to apps.

## 7. Open risks

1. **Speed.** The ceilings of 2.4 are before jitter, loss and heat. A frontier model across
   many homes will be around one token per second or less. If that is not acceptable for chat,
   the split is for overnight work and chat goes to the one home that fits a model whole.
2. **Friends read.** No design here hides a conversation from the friends who compute it.
3. **The RPC surface.** A friend's master writes into the worker process. Until the worker is
   confined (phase 2), a compromised friend device is a compromised worker process, and that
   process can use the device key.
4. **iroh on Android** is a from-source native build; apk size, build time and battery are
   unknown until the spike. It is also a young 1.x with security fixes three months ago, and a
   new piece of the supply chain.
5. **No reachable home in a circle.** If every friend is behind carrier NAT without IPv6
   inbound, there is no anchor, and the choice is between an outside party and no connection.
6. **Hole-punching numbers are not for mobile.** The 70 % figure excludes earlier failures and
   has no mobile breakdown; the charging-on-Wi-Fi rule sidesteps this but narrows when phones
   can work.
7. **The engine lags the models.** A new architecture may be unusable for weeks, and exotic
   state shared across layers (as in V4.1) may split badly even once supported.
8. **Version lock.** One device on an old build blocks its home from a session; updates must
   reach every friend.
9. **Prompt traffic.** Until direct forwarding and 16-bit activations exist, long prompts over
   several cuts take minutes and gigabytes.
10. **Phones wear.** Nights of full load mean heat and battery ageing; the worker's own limits
    must stay stricter than any master's wish.
11. **Key loss** in the first version is repaired by pairing again.
12. **Unverified points in this report**: the llama.cpp pull-request number and date for V4.1
    come from one third-party page; V4.1's hidden width from one aggregator; the per-token
    round-trip count of RPC is read from code, not measured; compute time per token and
    flash-served experts are estimates.

## 8. Decisions for the owner

| # | decision | proposal | outside party involved |
|---|---|---|---|
| 1 | Allow split mode between homes of the friends ring (changes `INTERNET.md` decision 4 and one sentence of `BEYIN-NET.md`) | yes, as the slow path; apart mode stays preferred | none |
| 2 | iroh as a dependency in the apk and kula-node, after the spike | yes if the spike passes | n0 as the author of code, not as a service |
| 3 | A circle anchor: a home computer of the owner or a friend that introduces and relays, with caps | yes; opt-in per device, computers on mains power only | none; it touches that home's router (port mapping) or needs IPv6 inbound |
| 4 | Friends' devices see each other's home IP address on direct links | accept; say it in the app | none |
| 5 | `rpc` rights for friends | per friend, explicit, with an end date | none |
| 6 | Last resort when no home is reachable | none for phase 1; decide after the field test between Tor signalling (most private, slow) and n0's public relays (easy, n0 sees metadata) | Tor volunteers, or n0 |
| 7 | A public store for addresses (DHT, Nostr, DNS) | no | strangers |
| 8 | Tailscale as a quick test rig for week 1 | no need: the step-1 code gives the same measurement without an account at a company | Tailscale Inc., if chosen |

## 9. Sources

NAT traversal and transports

- https://arxiv.org/abs/2604.12484 : IMC 2026 measurement of DCUtR hole punching: 4.4 M attempts, 167 countries, 70 % ± 7.1 % conditional success, TCP equals QUIC, 97.6 % on the first try, about 29 % fail before the punch.
- https://arxiv.org/abs/2510.27500 : the earlier version of the same campaign ("Challenging Tribal Knowledge").
- https://tailscale.com/blog/nat-traversal-improvements-pt-1 : Tailscale reports direct connections "well north of 90 %" in typical conditions.
- https://tailscale.com/blog/peer-relays-international-networks : carrier NAT at Indian ISPs often prevents direct paths; peer relays as the answer.
- https://tailscale.com/kb/1257/connection-types : direct, peer-relayed and DERP-relayed connections.
- https://tailscale.com/docs/reference/faq/other-vpns : one VPN at a time on Android and iOS.
- https://iroh.computer/blog/v1 : iroh 1.0: stable wire protocol and APIs, QUIC NAT traversal and multipath, official Kotlin and Node bindings, public relays rate-limited.
- https://iroh.computer/blog/iroh-1-1-0 : iroh 1.1.0 security fixes (1 Sept. 2026).
- https://docs.iroh.computer/concepts/security-privacy : what iroh relays and discovery see; public relays not for production; Tor as a custom transport.
- https://docs.iroh.computer/languages/kotlin : Android needs a source build; run in a foreground service.
- https://docs.iroh.computer/concepts/relays : relay role, self-hosting.
- https://github.com/marten-seemann/draft-seemann-quic-nat-traversal : the QUIC NAT traversal draft; n0's variant is draft-bruynooghe-n0-quic-nat-traversal-00 (July 2026).
- https://quicwg.org/address-discovery/draft-ietf-quic-address-discovery.html : a QUIC peer reports the address it sees, replacing STUN.
- https://grants.protocol.ai/publications/decentralized-hole-punching/seemann2022.pdf : libp2p's decentralised hole punching; public nodes as limited relays.
- https://cdn.jsdelivr.net/npm/@libp2p/circuit-relay-v2@4.2.0/src/constants.ts : circuit relay v2 defaults: 2 minutes, 128 KiB per relayed connection.
- https://test-ipv6.run/faq/isp-ipv6-deployment-status : IPv6 share per carrier (secondary source).
- https://mailman.nanog.org/pipermail/nanog/2019-April/100465.html : why mobile operators filter unsolicited inbound traffic.
- https://github.com/dmotz/trystero : WebRTC signalling over Nostr, BitTorrent and MQTT.
- https://github.com/nostr-protocol/nips/blob/master/59.md : gift wrap: what a Nostr relay still sees.
- https://github.com/pubky/pkarr : signed records in the mainline DHT.
- https://blog.ipfs.tech/2020-10-30-dht-hardening/ : eclipse attack on the IPFS DHT and its hardening.
- https://arxiv.org/abs/2505.01139 : a 2025 Sybil attack that still eclipses content on IPFS.
- https://arti.torproject.org/FAQs : Arti supports hosting onion services; no relay role yet.
- https://blog.torproject.org/tor-vpn-beta/ : Tor's Android VPN built on Arti.
- https://briarproject.org/how-it-works/ : Briar: Tor, Wi-Fi and Bluetooth on Android without servers.
- https://briarproject.org/news/2023-briar-mailbox-released/ : a mailbox on a spare device of your own instead of a server.
- https://gitrepo.ru/yggdrasil-network/yggdrasil-go : Yggdrasil's state (0.5.13, alpha).
- https://git.hackliberty.org/Git-Mirrors/veilid/src/branch/main : Veilid's state (0.5.0, Dec. 2025).
- https://developer.apple.com/forums/thread/790195 : Wi-Fi Aware between iOS 26 and Android, interop reports.
- https://datatracker.ietf.org/doc/draft-ietf-tls-ecdhe-mlkem/ : hybrid post-quantum key exchange for TLS 1.3 (published as an RFC in August 2026).

Android

- https://developer.android.com/training/monitoring-device-state/doze-standby : Doze and App Standby rules, exemptions, charging ends Doze.
- https://developer.android.com/develop/background-work/services/fgs/timeout : six-hour limit for dataSync and mediaProcessing services.
- https://developer.android.com/develop/background-work/services/fgs/changes : foreground service types and permissions.
- https://developer.android.com/about/versions/16/behavior-changes-all : Android 16 changes to jobs started from foreground services.
- https://source.android.com/docs/core/virtualization/security : protected VMs only for platform-signed apps.
- https://www.shwetashinde.org/publications/aster_mobisys26.pdf : confidential computing for Android as a research proposal (MobiSys 2026).
- https://bayton.org/android/android-enterprise-faq/key-attestation-root-certificate-change/ : the 2026 change of the key attestation root.

Inference with untrusted workers

- https://github.com/bigscience-workshop/petals/wiki/Security,-privacy,-and-AI-safety : Petals on input recovery, wrong outputs and private swarms.
- https://arxiv.org/abs/2312.08361 : Petals over the internet: fault tolerance and load balancing.
- https://arxiv.org/abs/2503.09291 : prompt inference attacks on distributed inference frameworks (CCS 2025).
- https://arxiv.org/abs/2503.09022 : prompt inversion against collaborative inference.
- https://arxiv.org/abs/2507.16372 : "Depth gives a false sense of privacy".
- https://arxiv.org/abs/2505.18332 : hidden-state permutation does not protect prompts.
- https://arxiv.org/abs/2607.19490 : canary inputs to find tampering nodes in peer-to-peer inference (abstract only read).
- https://arxiv.org/abs/2501.16007 : TOPLOC activation fingerprints (ICML 2025).
- https://www.gensyn.ai/research/verde-a-verification-system-for-machine-learning-over-untrusted-nodes : Verde, refereed delegation, RepOps.
- https://nousresearch.com/?p=3635 : Psyche's architecture: coordinator, witnesses.
- https://docs.learnbittensor.org/concepts/weight-copying-in-bittensor : weight copying in Bittensor.
- https://arxiv.org/abs/2507.02951 : an empirical critique of Bittensor.
- https://www.usenix.org/conference/usenixsecurity25/presentation/qu-zkgpt : zkGPT: proving GPT-2 inference in under 25 s.
- https://arxiv.org/abs/2404.16109 : zkLLM: minutes per proof at 13B parameters.
- https://github.com/ggml-org/llama.cpp/blob/master/tools/rpc/README.md : "Never run the RPC server on an open network".
- https://osv.dev/vulnerability/CVE-2024-42479 : arbitrary write in llama.cpp's `rpc_server::set_tensor`, fixed in b3561.
- https://bestllmfor.com/guide/exo-cluster-llm-plusieurs-machines/ : Exo has no authentication or TLS (secondary source).
- https://arxiv.org/abs/2510.11331 , https://arxiv.org/abs/2507.12000 , https://arxiv.org/abs/2507.02620 : speculative decoding across edge networks and its latency models.

Models used as illustrations

- https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash : 552B backbone, 196B Engram, 8B/16B active, 40 layers, 384 + 1 experts, MIT.
- https://vdf.ai/blog/deepseek-v4-1-flash-local/ : file sizes per quantization, engines, the llama.cpp merge date (third party).
- https://arxiv.org/abs/2606.19348 : the DeepSeek V4 paper (43 layers, width 4096 for Flash).
- https://huggingface.co/docs/transformers/main/model_doc/deepseek_v4 : hyper-connections with `hc_mult` residual streams, expert width.

Read in the repo: `CLAUDE.md`, `docs/INTERNET.md`, `docs/RELAY.md`, `docs/GATE.md`,
`docs/SECURITY.md`, `docs/BEYIN-NET.md`, `docs/SERVERS.md`, `node/src/godseye/net/`,
`app/src/passport/contract.ts`, the worker's manifest, and the vendored llama.cpp tree at
b11157 (`ggml-rpc.cpp`, `src/models/deepseek4.cpp`, `tools/rpc/README.md`).
