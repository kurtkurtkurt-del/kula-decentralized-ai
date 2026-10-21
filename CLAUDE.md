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
