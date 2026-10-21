# passport-core contract

Two apps measure a device with the same code:

- **device-passport** (this repo): `app` depends on `:passport-core`.
- **kula decentralized ai** (`../kula-decentralized-ai`): its Expo module
  `app/modules/passport-measure` compiles `passport-core/src/main/java` from here when this
  folder sits beside it, and a snapshot of it (`vendor/`, refreshed by
  `npm run passport:sync` in `kula-decentralized-ai/app`) when it does not.

So a change here reaches kula on its next build. This file says what a change may do
without breaking kula, and the files next to it are what both sides test against.

## The door

kula calls exactly one thing: `PassportCore.measureJson(context, deviceId)` and reads
`PassportCore.API` and `PassportCore.SCHEMA`. Everything else in the module may change.

## The kinds of change

| Change | What to do here | What happens in kula |
|---|---|---|
| Better measurement, same fields (a faster bandwidth test, a new SoC name) | nothing beyond the code | its next build measures better; nothing to do |
| A **new field** in the passport | add it to `Passport` and `toJson()`; bump `SCHEMA` minor (0.2 → 0.3); add `passport-0.3.json`; set `schema` in `contract.json` | kula reads any `passport/0.x`, keeps fields it does not know and sends them on; its test lists them so someone can show them |
| The **estimate rule** (`estimateModel`) | change it, then `estimate-cases.json` (the unit test fails until it matches) | kula's JS fallback has its own copy (`src/data/passport.ts`); its test reads these cases and fails until that copy follows |
| A field **renamed, removed, or its unit changed** | bump `SCHEMA` major (`passport/1.0`) and `API`; write `passport-1.0.json` | kula refuses the native result (falls back to its JS measurement) and its test fails until kula is taught the new shape |
| A **signature in `PassportCore`** | bump `API` | kula's build fails or, if it builds, it falls back and its test fails until `SUPPORTED_API` includes the new number |

## Rules for the code here

- Plain Android + kotlinx-coroutines only. No Compose, CameraX, zxing: the Expo module
  does not have them. Those belong in `app`.
- `minSdk` 24 (kula's floor). Nothing that needs a newer API without a version check.
- Numbers are rounded half up (`floor(x * 10 + 0.5) / 10`), the same as `Math.round` in JS.
- Package `com.pasaport` stays; kula's bridge imports from it.

## Files

- `contract.json`: `api`, `schema`, `min_sdk`, `rounding`; `PassportCoreContractTest`
  checks them against the code, kula's `passport-contract.test.ts` against its own.
- `passport-0.1.json`, `passport-0.2.json`: one passport of each schema. The newest must have
  exactly the keys `toJson()` writes (the unit test checks).
- `estimate-cases.json`: inputs and the label and speed the old rule (`largest_model_q4`,
  `est_tps`) must give. kula's JS fallback copies this rule.
- `budget-cases.json` (0.3): inputs and the `budget` and `estimate` objects the phase-1 rule
  (`Probe.kt`, `Rule`, `Quant`) must give. Kotlin only: kula reads these fields, it does not
  recompute them. Its factors are guesses until a phone-alone calibration; change them here
  and in the cases together.

## History

| Schema | Date | What came |
|---|---|---|
| passport/0.1 | 20.10.2026 | the first passport |
| passport/0.2 | 21.10.2026 | `device_id`, `kind`, `os` (together, qr) |
| passport/0.3 | 21.10.2026 | phase 1: `mem_bw_read_gbs`, `bw_threads`, `best_threads`, `clusters`, `cpu_features`, `thermal`, `gpu`, `wifi`, `budget`, `estimate`, `measure_ms` |

## Checks

```bash
./gradlew :passport-core:testDebugUnitTest      # here
cd ../kula-decentralized-ai/app && npm run passport:check && npx jest passport-contract
```
