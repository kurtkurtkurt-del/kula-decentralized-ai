# ilerleme — gerçek modeller, telefon kümesi, bilgisayarlar, beyin v0

Plan: `~/.claude/plans/memoized-kindling-puddle.md` (4.11.2026). Bu dosya her adımda güncellenir:
ne yapıldı, ne doğrulandı, ne kaldı. Döndüğünde önce burayı oku.

## durum (son güncelleme 5.11.2026 01:30)

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
| release apk | yapıldı (13 dk) | `dist/kula-decentralized-ai-0.1.0.apk`, 83 MB; içinde libllama, 4 cpu varyantı, libggml-rpc, libkula_llama (arm64) |
| emülatörde uçtan uca | yapıldı | kuruldu; modeller sekmesi açıldı, native modül yüklendi (CPU backend armv8.2_2); passport ölçüldü; Qwen3 0.6B indirme + öldür-yeniden aç ile devam etti (Range) ✓; toplu test: 8 cevap, 30–46 tok/s; **kullanıcının telefonunda (Galaxy S25+) Gemma 3 1B çalıştı** |
| küme testi (Mac dev-gate + rpc-server) | **yapıldı, emülatör + Mac** | bölünmüş: 27/29 katman `RPC0[127.0.0.1:…]`te (Mac 415 MB), sohbet cevap verdi; ayrı: toplu test 8 cevap, Mac + emülatör paylaştı. Ekran görüntüleri `docs/shots/` |
| Bölüm 2 kula-node | yapıldı (ayrı oturum) | dal `claude/kula-node-bcceb3`, 4 commit, push yok; 9 test; Mac'te gerçek model api kanalından aktı. **Bu dala henüz birleştirilmedi** |
| Bölüm 3 beyin/check | taslak | `~/Desktop/claudecode/beyin/check/spec/PROTOCOL.md` (kendi git reposu); kod yok |

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

## 5.11 gece 00:40–01:30 (Opus 5.5, küme testi)

Hepsi emülatörde (`kula35`) + Mac'te `tools/dev-gate.mjs` ile denendi; commit'ler `4f58ae1`, `1c65cb9`.

- **Bölünmüş mod çalışıyor.** Hata: passport "sığmaz" deyince paylaşma sorusu atlanıyor, `share=false` gidiyordu;
  planlayıcı canlı boş RAM'e bakıp "tek başına sığar" diyip bütün katmanları telefonda tutuyordu. Artık "split"
  seçmek = paylaşmak (`model/[id].tsx`). Sonuç: 27/29 katman Mac'te, sohbet cevap verdi
  (`docs/shots/split-emulator-mac.png`). Yükleme 335 s sürdü: 415 MB tünelden ~1.3 MB/s geçti (emülatör NAT'ı;
  gerçek wi-fi'de ölçülecek).
- **Ayrı mod çalışıyor**, üç hata vardı:
  1. Release apk 127.0.0.1'e düz HTTP'yi yasaklıyordu (`CLEARTEXT … not permitted`): api tüneline hiç fetch
     gitmiyordu — telefon-telefon ayrı modu da aynı yerden düşerdi. `modules/kula-llama/android/src/release/`
     altında yalnız 127.0.0.1/localhost için izin veren network-security-config; debug derlemeler değişmedi.
  2. `chatRemote` (engine.ts): son baytlar readyState 3'te gelince readyState 4'te `return` ile çıkıyordu, söz hiç
     bitmiyor, cihaz sonsuza "busy" kalıyordu. Düzeltildi.
  3. dev-gate: api kanalı çıplak llama-server'a gidiyordu (`/load` yok). Artık işçi API'sini (/status /load /chat
     /stop, ApiServer.kt ile aynı SSE) konuşan bir ara katman var; llama-server açılışta başlar, `/health` iyi
     olana kadar tünel açılmaz; soketler half-open (node varsayılanı cevabı kesiyordu).
  Toplu test: 8 cevap, Mac ve emülatör paylaştı (`docs/shots/apart-emulator-mac.png`).
- **GateTest (JVM)**: `./gradlew :kula-llama:testReleaseUnitTest` → 2/2 geçti, değişiklik gerekmedi.
- **Sekme aşağı çekme**: modeller sekmesi aşağı çekilince yerinde kalıyor, beyaz ekran yok.
- **Sohbet kutusu Gboard açıkken klavyenin üstünde** (`docs/shots/chat-input-above-gboard.png`).
- Emülatörde metin yazmak: `adb shell input text` ~100 karakterden sonra kesiyor; 15'erlik parçalarla yazıldı.
  Gboard ilk açılışta "stylus" tanıtımı açıp metni yutuyor.
- Lint: artık 1 eski hata (önceden 2). Testler 69/69.

### cloud dalları (01:25'te `git fetch`; hiçbiri birleştirilmedi)

| dal | ne getirdi | birleştirme |
|---|---|---|
| `claude/kula-node-bcceb3` | kula-node 1. tur (gate.ts + vektörler, setup/share/probe, http indirme) | `loving-dijkstra` içinde zaten var; ayrıca birleştirme gerekmez |
| `claude/loving-dijkstra-ku8d4t` (kula-node-2) | yukarıdaki + denetçi TS ikizi (imzalı, hash zincirli defter), Linux/Windows setup (offline test, `--dry-run`), api uyum testleri (SSE şekilleri bayt bayt) | HEAD ile çakışma yok (`merge-tree` temiz); yalnız `node/` ekliyor → **güvenli** |
| `claude/quirky-einstein-hy2v69` (beyin/check v0) | Kotlin `audit/` (Ledger, DeviceKey, Checks, Auditor), Gate'e isteğe bağlı Auditor + hello'da isteğe bağlı 4. alan (saat), WorkerService defteri yazar, JVM testleri (`audit-jvm/`) | çakışma yok; Gate 3 alanlı hello'yu hâlâ kabul ediyor, istemci hâlâ 3 alan yolluyor → dev-gate ve eski telefonlarla uyumlu. Birleştirince GateTest + audit testleri ve bir apk ile bir küme turu yeniden denenmeli → **güvenli, ama native; dene sonra** |
| `claude/vibrant-cori-y4ox9r` (night-worker) | `LlamaWorker`: gece işleri ayrı modda (`load(…,'apart')` + `chat(…, device)`), bilinen-cevaplı demo birimleri, passport kartında birim sayısı; 187 satır test | çakışma yok; bu gece düzelttiğim `chatRemote`'a dayanıyor (eski hâliyle uzak cihaz takılırdı) → **güvenli, bu daldan sonra** |

Önerilen sıra: vibrant-cori → loving-dijkstra → quirky-einstein (her birinden sonra `npm test`, en son apk + küme turu).

## 5.11 gece eklenenler (kullanıcı isteği)

- Her katalog modelinin bilgi sayfası var: neyi iyi yapar · ne için kullanılır (tr/en/de), indirmeden önce de açılır.
- Ana sekmeler aşağı çekilince kapanmıyor (`PullDownScroll closable={false}`).
- Giriş: "demo olarak gir" tek düğme; anonim giriş kapalıysa `demo@kula.app` ortak hesabı kullanılır (`AuthContext.signInAsGuest`). E-posta formu "hesabım var" bağlantısının arkasında.
- Sohbet kutusu klavyenin üstünde (`KeyboardAvoidingView behavior="padding"` Android'de de).
- Telefon USB'den bazen düşüyor ("charging only"); apk `dist/` içinde güncel, elle de kurulabilir.

## bulgular (emülatör)

- Emülatör 8 GB M1'de ağır: 4 GB AVD ile sistem ANR verdi; 2.5 GB ile çalışıyor. Gradle daemon'ları açıkken emülatör açma.
- `run-as` çalışmıyor (release apk debuggable değil); dosyalar yalnızca uygulama üzerinden görülebiliyor.
- ~~Bir sekmede aşağı çekme beyaz ekran bırakıyordu~~ — sekmeler artık kapanmıyor; 5.11 01:24'te emülatörde doğrulandı.
- Emülatörün passport'u: 2.4 GB RAM, bütçe 0.54 GB → her model "sığmaz" görünüyor; gerçek telefonda farklı.
- Uygulama öldürülünce yarım indirme listede görünmüyordu; düzeltildi (`1935ede`), yeniden derlenecek apk'da.

## cloud oturumları (5.11 gece, GitHub'a push'tan sonra)

- `beyin/check v0` denetçi kütüphanesi (Kotlin, `app/modules/kula-llama/.../audit/`, JVM testleri) — task_1848d4f9
- `kula-node-2`: denetçi TS ikizi, Linux/Windows setup (offline test), API uyum testleri — `claude/kula-node-bcceb3` üstüne — task_51c45240
- `night-worker`: SimulatedWorker yerine gerçek `LlamaWorker` (ayrı mod, toplu işler, bilinen-cevap kontrolü) — task_1ace2b70
- Üçü de kendi dalını açar; hiçbiri buraya birleştirilmedi. Sabah: `git fetch origin && git branch -r`.
- Kullanıcı: gece 3'ten sonra **Opus 5.5 high** ile devam edilsin, Fable değil. Bu oturum Fable; yeni oturum gerekir.

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

## 5.11 03:33 (uyandırma)

- Token yenilendi; Opus 5.5 high ile yeni oturum açmayı denedim, uygulama otomatik bir uyandırmadan oturum
  başlatmayı reddetti (yalnız kullanıcının kendi mesajıyla açılabiliyor). **Opus 5.5 ile oturum sabah elle
  açılmalı.** Önerilen brief: ILERLEME'yi oku → dört cloud dalını gözden geçir (birleştirme yok) → emülatör + dev-gate
  ile bir küme turu daha → gerekiyorsa `app/` içinde `npm run apk` → en üste "sabah özeti".
- Bu oturumda başka iş yapılmadı; ağaç temiz, HEAD `1873df7` + bu not.
