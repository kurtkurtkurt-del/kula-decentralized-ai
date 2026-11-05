# credits

kula's own code is MIT. What it carries from others is below. The music, the DJ
photos, the spark photos and the weather and football data that afterhours credited here went
with afterhours' screens; their credits are in git history (`git show 9d5919f:app/CREDITS.md`).

## type

- Archivo (the wordmark, `assets/fonts/ArchivoLogo.ttf`) — SIL Open Font License 1.1 —
  https://github.com/Omnibus-Type/Archivo; the license is beside the font
  (`assets/fonts/ArchivoLogo-OFL.txt`).
- Inter Tight and JetBrains Mono — SIL Open Font License 1.1 — through `@expo-google-fonts`.

## photos

`assets/intro/concert.jpg` (the backdrop and the project fallback): "Audience enjoying a concert
(Unsplash).jpg", Wikimedia Commons, CC0 —
https://commons.wikimedia.org/wiki/File:Audience_enjoying_a_concert_(Unsplash).jpg

`assets/feed/` (left from afterhours; nothing in `src/` loads them today): Unsplash, Unsplash
License, cropped square at 900×900.

- t3.jpg — Aleksandr Popov — https://unsplash.com/photos/j4esZ9owgzA
- f2.jpg — OurWhisky Foundation — https://unsplash.com/photos/SdTKkcdz9mY
- r2.jpg — Simon Maage — https://unsplash.com/photos/tXiMrX3Gc-g
- a2.jpg — Abstral Official — https://unsplash.com/photos/hOlmdNbFqtM
- e1.jpg — Danny Howe — https://unsplash.com/photos/bn-D2bCvpik
- h1.jpg — peter bucks — https://unsplash.com/photos/bFhL-ov72RM
- f3.jpg — Considerate Agency — https://unsplash.com/photos/UrzN-8K1PCE

The seed projects' photos (`backend/sql/03_seed_projects.sql`) load at runtime from
images.unsplash.com under the Unsplash License.

## code

- llama.cpp — MIT — https://github.com/ggml-org/llama.cpp — release b11157, fetched at build time by
  `modules/kula-llama/tools/llama-src.mjs`; two small log-line patches in `tools/patches/`.
- llama_flutter_android (dragneel2074) and PrivateLM (orailnoor, techjarves) — MIT —
  https://github.com/orailnoor/cross-platform-llm-client — the JNI, the runtime CPU-variant loading, the
  cluster planning and the worker service in `modules/kula-llama` were ported from them on 4.11.2026.
- The models themselves carry their own licenses (apache-2.0, gemma, llama3.2, mit); each one links to
  its license from the models tab.
- device-passport (the same author) — the phone measurement, compiled in from `../device-passport/passport-core`
  through `modules/passport-measure`; `vendor/` is a generated snapshot of it.
- ggml's RPC backend and `rpc-server` are part of llama.cpp (MIT); kula puts a gate in front of them and
  never changes them.

## code added since 4.11.2026

In the app (all MIT, installed with `npx expo install`): `expo-camera` (scanning a device's qr), `expo-clipboard`
(pasting a code), `react-native-qrcode-svg` and `react-native-svg` (drawing the share qr), `expo-battery` and
`expo-network` (the night's conditions), `expo-notifications` (the night's sticky notification), `expo-sharing`
(exporting the ledger), `expo-sqlite` (the kv-store), `expo-file-system` (free disk space).

In `node/` (kula-node): `bonjour-service` — MIT — https://github.com/onlxltd/bonjour-service (mDNS, `_kula._tcp`);
`qrcode-terminal` — Apache-2.0 — https://github.com/gtanner/qrcode-terminal (the qr in the terminal);
`tsx` and `typescript` (MIT, development only). llama.cpp's release archives are downloaded by `kula-node setup`
from https://github.com/ggml-org/llama.cpp/releases/tag/b11157 (MIT) and are not redistributed here.

Protocol v2 of the gate (branch `claude/gate-tls`) uses the platform's own TLS (Android's Conscrypt, Node's
OpenSSL); the certificates are written as DER by hand in `GateCert.kt` and `node/src/tls.ts`, no BouncyCastle.
