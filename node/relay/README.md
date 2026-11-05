# kula-relay

A blind pipe between two kula devices that cannot reach each other (both behind
NAT). The worker connects out and registers; the relay hands it a six digit code;
the master connects out with the code; the relay copies bytes between the two and
understands none of them: the gate's TLS 1.3 (protocol v2, `docs/GATE.md`) runs
end to end inside the pipe. The full description, the trust argument and the
limits are in `docs/RELAY.md` at the repository root.

```
npm install && npm run build && PORT=8787 npm start     # or: npm run dev
docker build -t kula-relay . && docker run -p 8787:8787 kula-relay
fly launch --no-deploy --copy-config && fly deploy      # fly.toml
# render: connect the repository; the blueprint is render.yaml
curl http://127.0.0.1:8787/health
```

Environment: `PORT` (8787), `HOST`, `RELAY_CODE_TTL_S` (600), `RELAY_MAX_WORKERS`
(1000), `RELAY_MAX_STREAMS` (16 per session), `RELAY_MAX_MB` (1024 per session),
`RELAY_CONNECTS_PER_MIN` (120 per ip), `RELAY_BAD_CODES_PER_MIN` (10 per ip).
Nothing is written to disk. Behind a proxy the first `x-forwarded-for` address
counts as the client.

Then: `kula-node share --relay wss://<relay>` on the worker, `kula-node peers add
"<code> <pin>" --relay wss://<relay>` and `kula-node chat --mode apart` on the
master; on the phone "share this phone › share far away" and "connected devices
› add by code". Tests: `npm test` here runs `../test/relay.test.ts` against this
server with the real gate.
