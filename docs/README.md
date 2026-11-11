# docs

Technical pages are in English; the user guide is in both languages; the status page, the
progress log and a few pages written on Turkish branches are in Turkish (marked *tr*).

## start here

| page | for |
|---|---|
| [../README.md](../README.md) | what kula is, the three modes, how to try it |
| [DURUM.md](DURUM.md) *tr* | where the project stands: done, not yet run on a device, open decisions |
| [GUIDE.en.md](GUIDE.en.md) · [GUIDE.tr.md](GUIDE.tr.md) *tr* | using it: install, measure, which model, chat, joining phones, a computer, the night, troubleshooting |
| [ARCHITECTURE.md](ARCHITECTURE.md) | how it is built: components, processes, data flow per mode, file locations, why |

## the parts

| page | for |
|---|---|
| [GATE.md](GATE.md) | the one open port: protocol v1 and v2, QR formats, refusal reasons, the tunnel, the dev gate |
| [AUDIT.md](AUDIT.md) | beyin v0, the auditor: ledger format, keys, checks, verifying a chain, the audit page |
| [NIGHT.md](NIGHT.md) | the night: conditions, scheduler, jobs, the morning report, the limits |
| [NODE.md](NODE.md) | kula-node: install, commands, running a cluster from a computer, the dashboard, beyond the local network |
| [RELAY.md](RELAY.md) *tr* | kula-relay: two devices behind NAT, the protocol, limits, deployment |
| [PLANNER.md](PLANNER.md) *tr* | the split planner and the apart dispatcher, the simulator and its calibration |
| [BACKEND.md](BACKEND.md) *tr* | the night on the server: schema, row-level rules, privacy, edge functions, the ledger plan |
| [SERVERS.md](SERVERS.md) | which build talks to which server, the demo world, setting up the live project |
| [SECURITY.md](SECURITY.md) | the security review: threat model, findings and fixes, remaining risks |
| [BEYIN.md](BEYIN.md) | kula and beyin: free joining, the brain as a service, what stays open protocol |
| [BEYIN-NET.md](BEYIN-NET.md) | brain to brain between homes: rings, offers and asks, verification, receipts, credit along friendships, the 20-home simulation |

## background

| page | for |
|---|---|
| [HISTORY.md](HISTORY.md) | the afterhours fork, pasaport and poorman's ai, the demo world, the simulated night, what was removed |
| [ILERLEME.md](ILERLEME.md) *tr* | the progress log: every branch, decision and test run, as it happened |
| [design/](design/) | HTML prototypes kept from the fork: the passport screen, the logo |
| [shots/](shots/) | screenshots from the emulator-plus-Mac cluster runs |

## elsewhere in the repository

| page | for |
|---|---|
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | rules of the tree, tests, commit style, security reports |
| [../node/README.md](../node/README.md) | kula-node's own reference |
| [../node/relay/README.md](../node/relay/README.md) | running the relay |
| [../backend/README.md](../backend/README.md) | the backend's files and commands |
| [../app/modules/kula-llama/AUDIT.md](../app/modules/kula-llama/AUDIT.md) | the native auditor in short |
| [../web/README.md](../web/README.md) | the Mac passport script and the legacy pages |
| [../app/CREDITS.md](../app/CREDITS.md) | licenses and credits |

`node tools/docs-links.mjs` (from the repository root, also a layer of the gate) checks that
every relative link and anchor in these pages resolves.
