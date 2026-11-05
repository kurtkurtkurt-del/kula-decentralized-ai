# bench: measured numbers for the planner

The planner (`app/src/llm/sim/model.ts`, `fit.ts`, `cluster.ts`; `node/src/planner.ts`) guesses a
device's speed as `tok/s ≈ bandwidth × 0.6 / model_gb`. A bench measures it instead. One run on one
device writes one **record**; the record's shape is `tools/bench-schema.json` and the same on both
sides:

- computer: `kula-node bench --model <file.gguf> [--peer id…]` → `~/.kula-node/bench/<yyyy-mm-dd>.json`
  (a second run that day: `-2`, `-3`, …) and a table on stdout.
- phone: settings → "measure speed" (`app/src/app/bench.tsx`) → kept in kv-store (`bench.history`,
  the newest 20), "share as json" hands the same record to the share sheet.

The schema check, the median, the `/blob` size rule and the lookup the planner uses live in one
file with no imports, `app/src/bench/core.ts`; `node/src/benchcore.ts` is a byte-for-byte copy and
`node/test/bench.test.ts` fails when they differ (after editing, `cp app/src/bench/core.ts node/src/benchcore.ts`).

## units

| unit | meaning |
|---|---|
| tok/s | tokens per second |
| ms | milliseconds, wall clock |
| MB/s | megabytes per second, **MB = 1024² bytes** (as everywhere in the planner) |
| GB/s | memory bandwidth, 10⁹ bytes per second (as in the passport) |

Every timed thing runs `RUNS` = 3 times. A *series* is `{unit, runs: [3 numbers], median, tokens?}`;
read the **median**, look at `runs` for the spread (a hot phone shows a falling series).

## fields

| field | what | how it is measured |
|---|---|---|
| `v`, `kind` | `1`, `"kula-bench"` | |
| `at` | ISO time of the run | |
| `source` | `node` or `app` | |
| `device` | `id` (kula-node's `~/.kula-node/id`, the phone's passport device id), `name`, `kind`, `os`, `cpu`, `threads`, `ram_total_mb`, `ram_free_mb` | free RAM: vm_stat on macOS, the native module on the phone |
| `model` | `id` (catalog id on the phone; file name lowercased without `.gguf` on a computer), `file`, `size_bytes`, `quant`, `layers` | gguf header (`node/src/gguf.ts`), the loaded model on the phone; `null` without a model |
| `local.mem_bw_gbs` | memory bandwidth, GB/s | computer: 64 MB copied back and forth 4× on a worker thread (`sysinfo.measureBandwidth`, what `share` advertises); phone: native `memBandwidth(fast cores)` |
| `local.prompt` | reading the prompt, tok/s; `tokens` = prompt tokens | computer: llama-server's own `timings.prompt_per_second`; phone: prompt tokens (context used − reply) ÷ time to the first token |
| `local.gen` | decoding, tok/s; `tokens` = 64 | computer: `timings.predicted_per_second` (llama-server `/completion`, `cache_prompt:false`, `ignore_eos`, temperature 0); phone: native `generate` 64 tokens with a reset, its `tps` |
| `local.first_token_ms` | request → first token, ms | wall clock |
| `peers[]` | one row per peer asked for; with none, one `loopback: true` row against this device's own gate (computer: an in-process gate + api; phone: its own gate when shared) | |
| `peers[].gate_rtt_ms` | tcp connect + the gate's handshake (hello, proof, OK) on the `api` channel, ms | `probe` 3 times; on the phone through `probePeer`, so the js↔native hop is in it |
| `peers[].tunnel_mb_s`, `tunnel_mb` | `GET /blob?mb=10` through the api channel, MB/s | the whole body read; both workers serve N MB (1024²) of zeros, N capped at 64 (`BLOB_MAX_MB`), `400 {"error":"need mb"}` for anything but digits ≥ 1 |
| `peers[].apart` | the peer runs the whole model by itself: `gen` tok/s (its `/chat` `tps`: tokens ÷ (ms − firstMs)), `first_token_ms` | computer only: `/load` (the peer fetches the file from this computer), then `/chat` 64 tokens 3 times |
| `peers[].error` | why a peer has no numbers (`connect timeout`, `wrong secret`, …) | |
| `split` | `peers` used, `load_s` (llama-server start → `/health` over rpc), `token_ms` (ms per decoded token), `tps` (1000 ÷ median token ms) | computer only, when llama.cpp is here and a peer answered; the planner's own shares |
| `skipped[]` | `{what, why}` for every part not measured | e.g. `split: no llama.cpp here (run: kula-node setup)` |

## how the planner uses it

`measuredTps(records, device, model)` (core.ts) returns the newest `gen` median for `'self'` (the
device that ran the bench) or a peer id (its `apart.gen`) on the same model — same `id`, or same
`file` and `size_bytes`. Loopback rows never count. When there is a number:

- `withMeasured(device, model, tps)` (sim/model.ts, copied into node) sets the device's `eff` so that
  `estimateAlone` gives back exactly the measured tok/s; the split planner, the load and token time
  estimates and the "alone is faster" verdict all follow from that.
- `fitOn(passport, model, measured)` shows the measured number as the high end (hot phones still at
  half) and sets `fit.measured`; the model page says "measured".
- the apart dispatcher (phone `engine.ts`, computer `apart.ts`) starts each device at its measured
  speed instead of the estimate; the first reply refines it as before.

Without a record everything is as it was: bandwidth × efficiency.

## reading a result

- `gen` is what one device does alone. `bandwidth × 0.6 / model_gb` is the old guess: if the measured
  number is far below, the device is throttling or the efficiency is lower (Mac M1, 5.11: 59 tok/s on
  Qwen3 0.6B Q8 → eff ≈ 0.54; the 34 tok/s the profiles carry was measured another way, through
  `/v1/chat/completions`, and the gap is not explained yet).
- `first_token_ms` ≈ `prompt tokens ÷ prompt tok/s` + one token. Long prompts make prompt speed matter.
- `gate_rtt_ms` above ~20 ms on a lan or a `tunnel_mb_s` under ~5 MB/s means the network, not the
  phones, sets the split's pace (each token costs 3 round trips per worker). The emulator's NAT gave
  1.3 MB/s.
- `split.tps` below the best single `gen` means alone is faster: the planner says so too once the
  numbers are measured.

## real runs

| when | device | model | gen tok/s | prompt tok/s | first token | mem bw | gate rtt | tunnel |
|---|---|---|---|---|---|---|---|---|
| 5.11.2026 | Mac M1 8 GB (kula-node, loopback) | Qwen3 0.6B Q8_0 | 59.1 (59.1 / 65.5 / 58.6) | 1202 (123 tok) | 104 ms | 51.0 GB/s | 1 ms | 446 MB/s |
