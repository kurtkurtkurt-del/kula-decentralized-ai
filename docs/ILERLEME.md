# ilerleme — gerçek modeller, telefon kümesi, bilgisayarlar, beyin v0

Plan: `~/.claude/plans/memoized-kindling-puddle.md` (4.11.2026). Bu dosya her adımda güncellenir:
ne yapıldı, ne doğrulandı, ne kaldı. Döndüğünde önce burayı oku.

## durum (son güncelleme 4.11.2026 23:40)

| adım | durum | not |
|---|---|---|
| llama.cpp b11157 indir + yama | yapıldı | `.llama/b11157.tar.gz` sha doğrulandı; PrivateLM yaması `app/modules/kula-llama/tools/patches/` |
| Mac host derlemesi | yapıldı | `.llama/host/`: `ggml-rpc-server`, `llama-server`, `llama-cli` (Metal) |
| Emülatör | imaj indi, avd `kula35` kuruldu (4 GB RAM) | henüz açılmadı |
| kula-llama modülü (gradle, CMake, JNI, Kotlin) | yapıldı, tek başına derlendi | commit `a969577`; `-PkulaLlamaVariants=min` ile 57 sn |
| JS katmanı `src/llm/*` | yapıldı | native, catalog (sha256'lar HF'den), fit, hf, store, peers (qr v2), cluster, engine |
| deste silindi, `data/projects.ts` | yapıldı | flow sekmesi, ProjectDeck, BigPicker, Pill gitti; i18n anahtarları temizlendi |
| ekranlar | yapıldı | `(tabs)/models`, `model/[id]` (mod sorusu), `chat`, `share`, `peers`; together'da "dene" |
| testler / lint / tsc | geçti | 69 test; lint'te 2 **eski** hata var (index.tsx:14, bir dosya :74 — setState-in-effect, benden önce de vardı) |
| README / CREDITS / CLAUDE.md | yapıldı | commit `0560748` |
| release apk | **sürüyor** | `npm run apk` arka planda; log `/tmp/claude-501/apk.log` |
| emülatörde uçtan uca | bekliyor | |
| küme testi (Mac dev-gate + rpc-server) | dev-gate yazıldı, el sıkışma Mac'te kendi kendine test edildi | `modules/kula-llama/tools/dev-gate.mjs` |
| Bölüm 2 kula-node | **ayrı oturumda sürüyor** | worktree dalı `kula-node`; session "kula-node" |
| Bölüm 3 beyin/check | bekliyor | |

## nasıl test edilir (emülatör + Mac)

```bash
# 1. emülatör
~/Library/Android/sdk/emulator/emulator -avd kula35 -no-snapshot -gpu swiftshader_indirect &
~/Library/Android/sdk/platform-tools/adb wait-for-device
# 2. apk
~/Library/Android/sdk/platform-tools/adb install -r dist/kula-decentralized-ai-0.1.0.apk
# 3. Mac işçi (bölünmüş mod için): kapı 50551, arkasında ggml-rpc-server
cd app/modules/kula-llama && node tools/dev-gate.mjs --secret <64 hex> --host 10.0.2.2
#    yazdırdığı json'u telefonda "cihaz ekle → yapıştır" ile ekle (emülatörde panoya adb ile:)
~/Library/Android/sdk/platform-tools/adb shell am broadcast -a clipper.set -e text '<json>'  # ya da ekranda yaz
# 4. ayrı mod: dev-gate'e --model .llama/models/Qwen3-0.6B-Q8_0.gguf ver; llama-server api kanalında çalışır
```

## notlar

- Oturum modeli/eforu kendi oturumumdan değiştirilemiyor; Fable 5.1'deyim.
- **Cloud olmadı:** repoda GitHub remote yok, cloud oturumu klonlayacak yer bulamadı. Bir GitHub reposu açıp
  `git remote add origin … && git push -u origin release/local-2026-10-20` yaparsan sonraki parçayı cloud'a veririm.
  kula-node bunun yerine yerel ayrı oturumda (worktree) yazılıyor.
- 3:33'te token yenilenince devam etmem için tek seferlik bir uyandırma kurulu (yalnızca bu oturum açıkken geçerli).
- apk.mjs `prebuild --clean` yapar; `android/` her seferinde yeniden üretilir, elle hiçbir şey durmaz. İlk apk denemesi
  yanlış klasörden çalıştığı için düştü (package.json yok), ikinci deneme `app/` içinden.
- Expo'nun typed routes dosyası (`.expo/types/router.d.ts`) `expo start` ile üretilir; ben elle güncelledim ki tsc
  geçsin; bir sonraki `expo start` zaten yeniden yazar.
