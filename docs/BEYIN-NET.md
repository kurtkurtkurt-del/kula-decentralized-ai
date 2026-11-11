# beyin-net: brain to brain

Design and proof of the layer between homes, 11.11.2026. No networking yet: how the words
travel (cable, Wi-Fi, later the direct internet path) is another piece of work. This page is
what the words are and what each brain does with them. Code: `node/src/godseye/net/` (pure,
imports nothing, not even node's crypto). Tests: `node/test/beyin-net.test.ts` (the parts) and
`node/test/beyin-net-sim.test.ts` (twenty homes, four time zones, three days).

## the picture

- **A home is a cell.** Its phones and computers are one AI: a model can be split across them
  (split mode) because they sit a few milliseconds apart. A model is **never split across
  homes**: the latency would kill it, and a layer's activations say too much.
- **Across homes only work is shared**, the way apart mode shares it at home: whole jobs, or
  pieces of a job that stand alone (summarise these 200 pages one by one, translate these
  paragraphs, label these photos, run this eval set).
- **Three rings.** HOME: this home's own devices. CIRCLE: homes this home trusts directly,
  friends. WORLD: anyone. Whoever runs a piece reads its prompt in plain text, so a piece goes
  only as far as the person allowed. Hardware attestation (a phone proving it runs an untouched
  build) can widen this later; it is not assumed.
- **Follow the night.** Phones that are idle and charging in the world's night run other homes'
  long jobs. A question asked at 09:00 in Istanbul is answered by phones sleeping in Asia and
  America, and Istanbul's phones answer them back twelve hours later.
- **No money.** Reciprocity: who did how much for whom, in receipts both sides sign and keep.
  Credit travels only along friendship chains (A trusts B, B trusts C), never as a currency.
- **No central brain.** Every home's brain (god's eye, `node/src/godseye/`) keeps its own books
  and talks to other brains. No global agreement, no proof-of-work, no token. It never acts:
  every step that lets work out or in is a card the person answers.

## what we take from others, and what not

| work | what it does | what we take | what we leave |
|---|---|---|---|
| Petals (BigScience, 2022) | runs one large model across volunteers on the internet, layers on different machines | that it works, slowly; that a dishonest peer can return wrong activations and nobody notices | splitting a model across homes: latency and privacy say no. We split only inside a home |
| BOINC, Folding@home | volunteer computing since 2002: jobs sent to many hosts, results compared | **quorum** (a result is valid when copies agree), **adaptive replication** (a host with a clean history is replicated less; overhead falls towards one), **homogeneous redundancy** (floating-point results are compared only between numerically equal hosts) | credit as a leaderboard (SETI@home's credit cheaters are why BOINC replicates at all) |
| BitTorrent | peers upload to those who upload to them (choking, tit for tat), with an optimistic unchoke for newcomers | serve first those who gave you most; a small gift share so a newcomer can start | upload speed as the measure: we count signed receipts |
| Tribler's TrustChain / ConTrib (TU Delft) | each peer keeps its own hash-chained ledger; every interaction is a record both sides sign; no global consensus; fraud is detected after the fact. Ran for years against free-riding | exactly this: **bilateral signed receipts in each side's own chain**, no global book. kula already has the per-device chain (AUDIT.md) | the global reputation computed over everyone's records |
| Ripple's first design (Fugger, 2004) | IOUs passed along chains of people who trust each other, no currency | **credit along trust lines**: a stranger is served on a friend's word, and each hop keeps its own balance | the later token and the global ledger |
| TOPLOC (Prime Intellect, ICML 2025) | checks that a provider ran the claimed model by hashing top-k activations; tolerant of GPU non-determinism | the way out when two honest devices do not give bit-identical text: compare activation fingerprints, not text | not needed while both copies run the same file on the same llama.cpp build with greedy decoding |
| Bittensor | a token (TAO); validators score miners; a global consensus pays out | nothing but the lesson: once work is paid, everyone optimises for the score, not the work; a chain and a token need global agreement | money, global consensus |
| Akash | a marketplace: providers bid for workloads, paid in a token | nothing: it sells compute to strangers | prices, bids, settlement |

**Why not money.** A price turns a friend's idle phone into a seller's stock, invites the people
who are best at gaming scores, and needs what kula refuses: a global book everyone agrees on,
an exchange, a company in the middle. kula's question is smaller and older: did you help me,
did I help you, does a friend of mine vouch for you. A receipt answers that between two homes
without anyone else. Credit that cannot leave the chain of friends cannot be sold, hoarded or
inflated; the worst a cheater can take is the trust its friends gave it plus a few gifts.

## the messages

All plain JSON, `v: 1`, types in `node/src/godseye/net/types.ts`, checked on arrival by
`parseMessage()` (anything not exactly one of these shapes is dropped whole). Units: one unit is
a thousand tokens through a one-billion-parameter model (2 000 tokens on an 8B model = 16 units).

| message | from → to | says |
|---|---|---|
| `offer` | giver → its circle, or anyone | "from 01:00 to 06:00 three phones idle, up to 8B, ring circle, 20 % gift share" |
| `ask` | asker → each ring, filtered | "a project of 200 pieces"; the world sees only the world-ok pieces' sizes, never the title (`askFor()`) |
| `grant` | giver → asker | "copy 0 of piece 17 runs on device d1 by 03:10, on credit along giver → B → you" |
| `work` | asker → the one device granted, over the gate | the prompt, the model's sha256, the seed. Content travels only now, only to that device |
| `result` | device → asker | the answer and its digest, signed by the device |
| `warn` | asker → its friends | "device X lied to me", with the signed result lines and what they were held against |
| `vouch` | a friend in the middle → the giver | "I stand for A towards you for 30 units until 06:00", signed |
| receipt | device, then asker; both keep it | below |
| `revoke` | asker → giver | "I take back receipt <sha256>: it was wrong", with the evidence |

### the receipt

The ledger's style (AUDIT.md): keys in a fixed order, no spaces, integers; a signature is over
the line up to its own field and is appended last. Two signatures: the device that did the work
signs first, the home it worked for countersigns when it accepts the answer.

```
{"v":1,"kind":"receipt","t":1762822800000,"job":"h04-1-9","piece":"h04-1-9-17","copy":0,"units":16,
 "model":"<sha256>","ring":"world","result":"<digest>","device":"<32 hex>","giver":"<home>","taker":"<home>",
 "via":["<home>"],"gift":false,"checked":true,"gsig":"<base64>","tsig":"<base64>"}
```

- `gsig` signs the text before `,"gsig"`; `tsig` signs the text before `,"tsig"` (so it covers
  `gsig` too). `checkReceipt()` also rebuilds the line from its fields: a key slipped in or
  reordered fails even with both signatures intact.
- `ring` is in the receipt: anyone holding it can see the piece was allowed to travel that far.
- Each side appends the countersigned line to its **own** hash-chained receipts file (same
  chaining as the ledger, `prev` = sha256 of the line before). A separate file, so older ledger
  verifiers never meet unknown kinds. Neither home can change a receipt alone; nobody else
  needs to agree.
- The balance **is** the receipts: `tally()` walks them and carries each one's units along
  giver → via → taker. Nothing else holds a number.

## matching

The giver's brain decides, because the devices are its own (`match()`): of all copies it heard
of, which ones its idle devices take this window. The asker checks every grant again
(`allowed()`) before a word of content leaves.

1. **Rings, both ways.** The asker's piece may go only as far as its label: `home` to this
   home, `circle` to a home the asker trusts directly, `world` to anyone. The giver takes work
   only from as far as its offer says. A friend-of-a-friend is the world as far as privacy goes.
2. **Order.** This home's own work first. Then homes the giver owes (debts are paid first,
   whoever they are: tit for tat). Then the most room on credit (friends, friends of friends).
   Then strangers from the gift share. Ties are broken by a coin per offer, so no name always
   comes first.
3. **Gifts are a try, not a living.** The offer's gift share (here 20 %) goes to homes with no
   credit, but a stranger may owe one giver at most `GIFT_CAP` (24 units, a piece or two) in
   gifts before it must give something back.
4. **One copy of a piece per home**; a check copy excludes the home holding the first. Devices
   the asker no longer takes work from are skipped; a piece needs a device whose `maxB` fits.
5. Each grant has a `due`: twice the expected time, at least an hour. Late copies go back to the
   queue without that home.

## verification

Both copies of a checked piece run the **same model file** (sha256 in the piece) on the **same
llama.cpp build** (b11157 everywhere, CLAUDE.md) with **greedy decoding and a fixed seed**, so
honest devices give the same tokens, and the digest of the answer is compared. That is BOINC's
homogeneous redundancy. Where that ever fails (a GPU path with different rounding), the
fallback is an activation fingerprint in the TOPLOC style, not a text diff: an open question.

- **Adaptive replication** (`rates()`, `plan()`). In each home's book, a device with fewer than
  8 checked answers has every piece checked: run by a second home, or swapped for a canary.
  After that, by its score: at least 10 % of pieces go twice and at least 5 % are canaries, more
  as the score falls. The coin is `coin(seed, piece, device)` (FNV-1a), the same on every machine.
- **Canaries.** A piece whose answer this home already knows (it ran it in its own night) is
  sent in place of a real one. It looks like any other piece. It catches what replication
  cannot: two liars who agree with each other.
- **Judging** (`judge()`). Copies agree: accepted, both `good`. Copies disagree: the asker runs
  the piece on its own devices (the only answer it trusts) and the wrong one is `wrong`. Three
  or more copies with a strict majority: the minority is `outvoted`. A canary answered wrong is
  `wrong`.
- **Recall.** When a device is caught, every answer it gave this home that nobody checked runs
  again (`recall()`), and the receipts for them are revoked with the evidence.

## reputation

Every brain keeps its own book (`reputation.ts`); there is no global score.

| outcome | effect |
|---|---|
| `good` | +1 good |
| `late` | +1 late (weight 1): it took the piece and did not bring it back |
| `outvoted` | +1 bad (weight 8), +1 proof; two proofs within the book = banned 30 days |
| `wrong` | +1 bad, +1 proof, banned 30 days at once: a proven lie (honest hardware does not get a known answer wrong) |
| `warned` | a friend caught it and showed the proof: +1 bad, banned 7 days |

Score = (1 + good) / (2 + good + 8·bad + late), counts halving every 30 days; a new device is
0.5. Below 0.4 it gets no work from this home. A home whose device was banned gets no work
from this home and does no work for it while the ban lasts (the owner chose to cheat, not the
phone).

## reciprocity

`credit.ts`. `gave[x][y]` is what x did for y, read from receipts. A person gives trust as a
number: "I will do up to 100 units for Ayşe before anything comes back".

- **Direct room** x → y = trust(x, y) − (what y owes x). Without trust it is only what x owes y:
  **a debt is always honoured**, even to a stranger.
- **Along a chain.** C may serve A on B's word when C trusts B and B trusts A: the room is the
  weakest hop, **halved for every friend in between**, at most three hops (giver, two friends,
  asker). When it happens, the receipt names B in `via`, and the units are carried hop by hop:
  C did 16 for B, B did 16 for A. B's own standing does not change; its word moved. In the wild
  each hop's number comes from that hop's signed `vouch` (with an `until`), so B cannot be
  spent twice behind its back.
- **Limits.** What a home can take beyond what it gives is bounded by the trust its friends gave
  it plus `GIFT_CAP` per stranger. In the simulation: 4 friends × 100 + 19 × 24 = 856 units.
- **Why chains are not optional.** Follow the night makes direct tit for tat impossible: zone 0
  sleeps while zone 1 asks, zone 1 sleeps while zone 2 asks, and so on round the planet. Nobody
  ever serves the home that serves it. Only credit that moves along friendships closes the
  circle, and the simulation shows it does.

## what each ring may see

| | home | circle (a friend) | world (a stranger) |
|---|---|---|---|
| the offer (window, how many devices, model size) | yes | yes | yes, if the offer is to the world |
| device names, battery, where they are | yes | no (devices are ids) | no |
| an ask's title (the person's words) | yes | yes | no |
| an ask's pieces | all | circle and world pieces | world pieces only, sizes only |
| a piece's prompt and answer | yes | the circle and world pieces it was granted | the world pieces it was granted, in plain text |
| receipts | its own | those it signed | those it signed |
| reputation | its own book | warnings with proof | nothing |

## failure and cheating

| case | what happens |
|---|---|
| a device takes work and never answers (lazy, out of battery, gone) | `due` passes, `late` in the book, the copy goes back without that home; no receipt, so no credit |
| a wrong answer to save work | caught by the second copy or a canary during burn-in; afterwards by the 10 %/5 % sample. Proven once: banned, its unchecked answers recalled, friends warned |
| a sleeper: honest until trusted, then lying | the sample never goes below 15 % per piece; with many homes each home's book starts fresh, so in practice it stays in burn-in for long |
| two liars agree | canaries catch them; the check copy never goes to the first copy's home |
| a free rider asks a lot, gives little | served after everyone with credit; gifts capped per stranger; it can take at most its friends' trust plus the gifts |
| a home claims work it did not do | needs the asker's countersignature; a receipt cannot be made alone |
| a receipt is replayed | job, piece, copy and device make it unique; both chains already hold it |
| an asker refuses to countersign good work | the giver stops serving it (no receipt, the giver's book drops it); the work was idle anyway |
| a friend vouches for more than it has | each vouch is signed with units and `until`; a giver holds them and stops at the sum |
| a stranger reads a world piece | it may: that is what world means. Only the person sets a piece's ring; the brain never widens it |
| new identities to collect gifts (Sybil) | each costs a full burn-in and gets 24 units per giver; open question below |
| two honest devices disagree (rounding) | outvoted is a strike, not a ban; the home's own re-run decides; see verification |
| a home's brain is wrong or hacked | it can only suggest; the person answers every card; the gate still refuses anything not paired |

## what the person sees and decides

The brain only suggests (`cards.ts`, the same idea as the god's eye cards in
`godseye/types.ts`). Kula's engine carries out a tap; the brain never does.

- **Lend tonight?** "3 devices idle 01:00–06:00: lend them?" — lend to anyone / friends only / not
  tonight. Says who is owed most and will be served first.
- **Send a project out?** "thesis: 200 pieces, 180 may go out" — "20 stay on this home's devices.
  180 may go to anyone whose night it is: they read those in plain text." — send them out /
  friends only / keep all at home.
- **Caught.** "Ali's phone gave a wrong answer" — what proved it, that its home gets no more
  work, how many pieces run again — tell my circle / only note it.
- **Owed.** "Ayşe did 340 units more for you": her work goes first on your devices.
- **Taker.** "X took 600 units more than it gave": it now only gets the gift share — keep it so /
  give it more room.
- Trust numbers (how much for whom) are set by the person, never by the brain.

## the simulation

`node/test/beyin-net-sim.test.ts`: 20 homes in 4 time zones (UTC+0, +6, +12, +18), 3 devices
each (two up to 8B, one up to 4B, 50 units an hour), night 00:00–06:00 local, so exactly one
zone sleeps at any hour. Every home asks a 50-piece project at 09:00 local each day, in turn a
world project (90 % world-ok), a circle project (70 % circle) and a private one (all home); a
deadline of 24 h. Friendships: each home with the next and the one five on, both ways, 100 units
each. Thirteen homes honest; four lazy (lend one device of three, drop half of what they take,
ask three projects a day); two cheat (40 % wrong answers, all cheaters give the same wrong
answer, so two of them on one piece agree); one sleeper (honest for its first 12 pieces, then
50 % wrong). Three days of asks and a fourth to settle, hour by hour, with real ed25519 receipts.

Results (deterministic, run 11.11.2026):

- **Privacy**: no home piece left its home, no circle piece went to a non-friend, in grants and
  in all 2 218 receipts. Every honest home's private pieces were done at home, in its own night.
- **Cheaters**: every cheating device was stopped by the first home that caught it after 1 to 5
  pieces; the sleeper's devices after 13 to 18 pieces, 1 to 6 after they turned. No honest device
  was ever caught. A home that caught a device granted it nothing afterwards; its friends stopped
  too. 1 wrong answer was accepted and stayed, of 3 557 pieces done (an unchecked answer
  from a device that asker never caught, so nothing was recalled).
- **Reciprocity**: honest homes gave 14 284 units and got 11 740; each honest home got between
  0.58 and 1.09 of what it gave. Honest homes had everything done; lazy homes 84 % of what they
  asked; cheating homes 22 %, since homes that caught them stopped serving them. Every receipt
  checks, and the balances equal `tally()` of the receipts.
- **Night**: no piece for another home ran outside the giver's night; in every hour of the day
  the zone doing others' work is the zone whose night it is. World-ok pieces were done in a
  median of 7 h; private ones waited 15 h for their own home's night.
- **The cost**: of 2 559 runs for other homes, 1 063 were check copies and 470 canaries. Over
  three days nearly every device stays in burn-in in nearly every home's book (8 checked answers
  per pair, 20 homes × 60 devices). In a steady state the cost falls to the 10 % + 5 % floor.

## open questions for the person

1. **Burn-in is per home.** Should a friend's clean history count in my book (a vouch for a
   device, not only a warning)? It would cut the verification cost by much and also let a
   sleeper ride on its friends' word.
2. **Warnings beyond friends.** Today a proof travels one hop. Should it go to friends of friends,
   with the evidence, so every home a liar meets already knows?
3. **Sybil.** A fresh identity gets a piece or two of gifts from each home and a full burn-in.
   Is that cheap enough to ignore, or should gifts need a friend's vouch too?
4. **How much trust by default?** The person sets a number per friend; what is the starting
   number the card suggests (here 100 units, about a phone's two hours)?
5. **Does the asker run tiebreaks itself?** It is the only answer it trusts, but costs its own
   night; a third copy to a high-score device is cheaper and weaker.
6. **Do canaries cost the asker's night?** Each needs an answer known in advance. A home with
   no idle night (a lone phone) has none to plant.
7. **What does the world get?** The world ring is plain text to strangers. Is it ever on by
   default, or always a card per project?

## map nodes

New nodes for the brain map (another agent writes them). Parent names are the map's branches;
`beyin-net` is a new branch beside them.

| title | parent | one line |
|---|---|---|
| beyin-net | (root) | brain to brain between homes: offers, asks, receipts; no networking, no money, no centre |
| a home is a cell | beyin-net | a model is split only inside a home; across homes only whole pieces travel |
| three rings | beyin-net | home, circle (friends), world (strangers read world pieces in plain text) |
| offer and ask | beyin-net | "three phones idle 01–06, up to 8B, circle" / "200 pieces, 180 world-ok" |
| the giver decides | planner | the giving brain matches what it heard: own work, debts, credit, then gifts |
| follow the night | forecast | idle charging phones in the world's night run others' long jobs |
| adaptive replication | trust and verification | new devices checked always, trusted ones by a 10 % sample |
| canaries | trust and verification | known-answer pieces that catch liars who agree with each other |
| the home decides a tie | trust and verification | when two copies disagree the asker runs it itself |
| a book per home | trust and verification | reputation from what happened between us; no global score |
| warnings with proof | connections | a caught liar is told to friends with the signed evidence |
| signed receipts | memory | the device signs, the asker countersigns, both keep it in their own chain |
| revoke | memory | a receipt taken back with proof when its answer was wrong |
| credit along friendships | beyin-net | a stranger is served on a friend's word, halved per hop, at most three hops |
| debts first | beyin-net | whoever helped me is served first, friend or not (tit for tat) |
| gift cap | beyin-net | a newcomer may owe one giver a piece or two, no more |
| why not money | beyin-net | a price turns friends into sellers and needs a global book |
| lend and send cards | advisor | the person decides every step out or in: lend tonight, send a project, who was caught |
| the 20-home simulation | beyin-net | four time zones, three days, honest, lazy and cheating homes: the proof |
