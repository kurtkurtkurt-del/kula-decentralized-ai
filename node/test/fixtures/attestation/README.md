# attestation test chains

Real Android key attestation certificate chains used by `node/test/attest.test.ts`. They are
copied unchanged from the `testdata` of Google's key attestation library,
https://github.com/android/keyattestation, which is licensed under the Apache License 2.0
(https://www.apache.org/licenses/LICENSE-2.0). Copyright the Android Open Source Project.

| file | device, Android version, security level, key, root |
|---|---|
| `walleye_sdk27_TEE_EC_NONE.pem` | Pixel 2, API 27, TEE, EC, factory chain (RSA root) |
| `marlin_sdk29_TEE_EC_NONE.pem` | Pixel, API 29, TEE, EC, factory chain (RSA root) |
| `caiman_sdk36_TEE_EC_RKP.pem` | Pixel 9 Pro, API 36, TEE, EC, remotely provisioned (RSA root) |
| `tegu_sdk36_TEE_EC_2026_ROOT.pem` | Pixel 9a, API 36, TEE, EC, the 2026 EC root |
| `tegu_sdk36_SB_EC_2026_ROOT.pem` | Pixel 9a, API 36, StrongBox, EC, the 2026 EC root |

Their attestation challenges are Google's test app's, so every one of them stops at kula's
challenge check by design; the tests check every other rule on chains built under a test root.
