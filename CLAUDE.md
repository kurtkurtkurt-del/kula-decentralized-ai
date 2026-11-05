# kula decentralized ai — working notes

- The passport measurement is not written here. `app/modules/passport-measure` compiles
  device-passport's `passport-core` (`../device-passport/passport-core`); kula only has the
  Expo bridge (`PassportMeasureModule.kt`) and what it accepts (`app/src/passport/contract.ts`).
  To change the measurement, change device-passport and follow its
  `passport-core/contract/CONTRACT.md`. Never copy Measure.kt into kula again.
- After device-passport's core changed: in `app/` run `npm run passport:sync`, then
  `npx jest passport-contract`, and commit `modules/passport-measure/vendor` with what it
  needed. `npm run passport:check` (in the gate) fails while the snapshot is behind.
- `modules/passport-measure/vendor/` is generated: never edit it by hand.
- Servers: development = the Mac's local server (`app/.env.development.local`), a release apk =
  kula's own Supabase project (`app/.env.production`). Never afterhours' project, never an
  `app/.env.local` (Expo loads it into release builds too). Release apks only via `npm run apk`,
  which runs `npm run release:check` first. README: "A live server".
- `app/modules/kula-llama` carries llama.cpp **b11157** (PrivateLM's release; the cluster speaks RPC
  proto 7 only between equal versions). The tree under `android/src/main/cpp/llama.cpp` is fetched and
  patched by `tools/llama-src.mjs`, never edited by hand; change the tag or `tools/patches/` there.
  ggml's RPC server must stay on 127.0.0.1 behind the gate (`Gate.kt`); never bind it to the network.
