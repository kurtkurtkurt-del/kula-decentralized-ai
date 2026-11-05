# ilerleme — gerçek modeller, telefon kümesi, bilgisayarlar, beyin v0

Plan: `~/.claude/plans/memoized-kindling-puddle.md` (4.11.2026). Bu dosya her adımda güncellenir:
ne yapıldı, ne doğrulandı, ne kaldı. Döndüğünde önce burayı oku.

## ci (5.11 sabah, cloud oturumu, dal `claude/ci`, `claude/integrate-night` üstüne)

GitHub Actions kuruldu: `.github/workflows/`. Her action sha ile sabit (`# vX.Y.Z` yorumu yanında); dependabot
(`.github/dependabot.yml`) haftada bir action'ları, ayda bir `app/` ve `node/` npm paketlerini (expo/react-native
major'ları hariç) günceller.

- **check.yml** — her push ve PR. Dört iş paralel, her birinde `timeout-minutes`, her iş kendi tablosunu ve
  sondaki `summary` işi genel tabloyu `$GITHUB_STEP_SUMMARY`'ye yazar: `app` (npm ci + cache, tsc, expo lint,
  jest --ci, passport:check), `node` (node 20 ve 22 matrisi; build + test), `audit-jvm` (temurin 17 +
  gradle 8.14.3, `audit-jvm` gradle testleri; düşerse rapor artifact), `gate` (`backend/tools/gate.mjs` tam
  olarak; katman süreleri `.qa/gate-proof.json`'dan tabloya).
- **apk.yml** — elle (`profiles`: both/min/full) ya da `v*` etiketinde. ubuntu, temurin 17, android-actions ile
  SDK + `ndk;27.1.12297006` + `cmake;3.22.1`, `.llama/*.tar.gz` için actions/cache (anahtar llama-src.mjs'deki
  TAG'den), `llama-src.mjs` + `--check`, `release:check`, sonra `npm run apk`. Matris: `min`
  (`-PkulaLlamaVariants=min`, 90 dk sınır) ve `full` (150 dk). `unzip -l` ile `libllama.so`, `libggml-rpc.so`,
  `libggml-cpu-*` aranır (full'de en az 2 varyant; armv9 görülürse hata), boyut ve apksigner sertifikası özete
  yazılır, apk `kula-apk-<profil>-<ref>` artifact'ı olur. İmza: `KULA_KEYSTORE_B64` (+ `KULA_KEYSTORE_PASSWORD`,
  `KULA_KEY_ALIAS`, `KULA_KEY_PASSWORD`) secret'ı varsa onunla; yoksa debug imza ve `::warning`.
- **node-release.yml** — `v*` etiketi ya da elle: kula-node build + test + `npm pack` + geçici klasöre kurulum
  denemesi; `kula-node-<tag>` artifact'ı.
- `app/tools/apk.mjs` iki düğme kazandı (başka bir şey değişmedi): `KULA_GRADLE_ARGS` (gradle'a ek argüman) ve
  `KULA_KEYSTORE_FILE` + parola/alias env'leri (prebuild'den sonra üretilen `android/app/build.gradle`'a imza
  bloğu ekler; `android/` yine elle düzenlenmiyor, prebuild her seferinde sıfırdan yazıyor).
- `app/src/app/index.tsx`: `expo lint` kırmızıydı (`react-hooks/set-state-in-effect`: oturum gelince effect
  içinde `setDone`). Yönlendirme artık türetilmiş (`done || (ready && session)`); davranış aynı. Lint 0 hata.
- README: üç rozet + "CI" bölümü.

**Yerelde doğrulananlar (bu kutuda):** `actionlint` 1.7.7 üç workflow'u temiz geçti (shellcheck kurulamadı,
`act` yok). app: tsc ✓, lint ✓ (0 hata, 7 uyarı), jest 68/68 ✓, passport:check ✓. kula-node: 28/28 ✓.
`backend/tools/gate.mjs`: GATE PASS (backend 40 s, 7 katman). audit-jvm gradle: bu kutunun proxy'si Maven
Central'a 429 veriyordu; 6. denemede indi, 21/21 ✓.

**CI turları:** 1. tur (`7ac35f5`): app ✓, node 20/22 ✓, gate ✓, audit-jvm ✗ — `AuditorGateTest.replayAndClock…`
satır 61: beklenen `connect,end,reject,reject,connect,end` sırası bozuk. Sebep testte: gate önce `onEvent(end)`
çağırıp sonra defter satırını yazıyor; test callback'i bekleyip hemen sonraki hello'yu attığı için yavaş runner'da
`reject` satırı `end`'den önce düşüyor (Mac'te hiç görünmedi). Düzeltme yalnız testte (`waitForLines`: her
hello'dan sonra defter satır sayısını bekle); Gate.kt değişmedi. Yerelde 21/21 ✓. **2. tur (`fcde2eb`): altı iş de yeşil** (app, node 20, node 22, audit-jvm, gate, summary) —
https://github.com/kurtkurtkurt-del/kula-decentralized-ai/actions/runs/41988114488

**Kalan / sana:** apk.yml bu oturumda koşturulmadı (yalnız elle ya da `v*` etiketiyle tetiklenir; ilk `full` koşusu
~1–2 saat, `min` ile başla: Actions → apk → Run workflow → profiles: min). İmza için repo secret'ları:
`KULA_KEYSTORE_B64` (`base64 -i kula.keystore`), `KULA_KEYSTORE_PASSWORD`, `KULA_KEY_ALIAS`, `KULA_KEY_PASSWORD`;
yoksa apk debug imzalı çıkar ve koşu uyarı taşır. Gradle cache yalnız main'de yazılır (`cache-read-only`); dal
release'e/main'e alınınca ısınır. `claude/ci` release ve main'e dokunmadı, PR açılmadı.

## bütünleştirme (5.11 sabaha karşı, cloud oturumu, dal `claude/integrate-night`)

Üç gece dalı `origin/release/local-2026-10-20` (`9a2f91f`) üstüne sırayla merge commit'iyle alındı, squash yok,
çakışma çıkmadı: `vibrant-cori-y4ox9r` (gerçek gece işçisi) → `loving-dijkstra-ku8d4t` (kula-node 2. tur,
`claude/kula-node-bcceb3`'ü içerir) → `quirky-einstein-hy2v69` (beyin/check v0). Release ve main'e dokunulmadı;
PR açılmadı. Bu dalı release'e sen alacaksın.

### ne birleşti
- `app/src/night/`: `LlamaWorker` (gece, ayrı modda, cihaz başına bir birim), `jobs.ts` (60 demo birimi, 8'i bilinen
  cevaplı), passport kartında birim/doğru sayıları; `useNight` native modül + yerel model varsa gerçek işçiyi seçer.
- `node/`: kula-node (`setup`, `share`, `probe`, `ledger`); TS kapı (`gate.ts`), işçi API'si (`api.ts`), imzalı
  zincirli defter (`audit/`), Linux/Windows kurulum, api uyum testleri.
- `app/modules/kula-llama`: `audit/` (Ledger, DeviceKey, Checks, Auditor), Gate'e isteğe bağlı denetçi, hello'da
  isteğe bağlı 4. alan (saat), `audit-jvm/` (Android SDK'sız gradle), `AUDIT.md`.

### birleştirirken bulunup düzeltilenler
1. **İki defter aynı baytları imzalamıyordu.** Ledger.kt imzayı `prev` değerinin kapanış tırnağına kadar (kapanış
   `}` olmadan) atıyor; TS defter `}` dahil imzalıyordu. Telefonda yazılan defter node'da (ya da tersi) hiç
   doğrulanmazdı. TS tarafı düzeltildi; `node/test/audit-vectors.json` artık `tools/audit-vectors.json`'un birebir
   kopyası (gate-vectors gibi) ve node testi Kotlin vektörlerini bayt bayt üretiyor. (`8193436`)
2. **`chatLocal` hatada hiç bitmiyordu** (engine.ts): native `onDone` hata getirince listener içinde `throw` vardı,
   söz askıda kalıyor, cihaz "busy" kalıyordu; gecede bu telefonun döngüsü sonsuza asılırdı. `reject` oldu, test
   eklendi (`engine-local.test.ts`). `LlamaWorker` yükleme sürerken `stop()` gelirse bir kez daha `unload` eder.
3. **node kapısı half-open değildi**: istek sonrası FIN gönderen istemci geç cevabı kaybediyordu (dün gece dev-gate'te
   düzeltilen hatanın aynısı). Tüm bacaklar `allowHalfOpen`; `close()` açık bağlantıları kapatıyor (telefon
   bağlıyken ctrl-c asılıyordu); Tunnel'ın yerel bacağına baştan error listener; rpc yuvası async connect'ten önce
   alınıyor; hello/proof Kotlin gibi `trim`. API: istemci `/chat` ya da `/load` ortasında koparsa iş iptal, `busy`
   serbest (yoksa o telefon bir daha 409 yiyordu); modelsiz `/chat` ApiServer.kt gibi 409; `/unload` meşgulken 409.
   Hepsine test. (`c3511bf`)
4. **Kotlin audit** (`bcbbe6d`): `java.util.Base64` API 26, app minSdk 24 → Android 7'de işçi süreci açılışta
   düşerdi; kendi `B64.kt`. Denetçi kancaları `runCatching` içinde ve `NO` cevabı kayıttan önce yazılıyor
   (defter yazılamazsa kapı kimseyi düşürmüyor). Sunucu hello/proof'u sınırlı (256 bayt) byte-byte `readLine` ile
   okuyor (önceden sınırsız BufferedReader: kimlik doğrulamasız LAN'dan heap doldurulabilirdi). `ReplayRing` en çok
   64 adres tutuyor. `claim` satırı yalnız bir master en az 256 MB koyduktan sonra yazılıyor (öncesi her dakika sahte
   `reject:"claim"` üretiyordu).
5. `tools/dev-gate.mjs` 4 alanlı hello'yu da kabul ediyor (3 alanlı eski hello her yerde kabul: Gate.kt, node, dev-gate).

### sorulan üç şey
- `LlamaWorker` ↔ düzeltilmiş `chatRemote`: uyumlu. İşçi `chat(..., { device })` kullanıyor; `chatRemote` readyState
  3/4 düzeltmesi aynen duruyor; `stop` → `/stop` + abort → reject → işçi `alive` değilse saymıyor.
- quirky-einstein'ın Gate'i 3 alanlı hello: kabul ediyor (`p.size == 3 || 4`), `AuditorGateTest` `Gate.probe` ile
  (3 alan) deniyor; saat kuralı yalnız 4. alan gelince.
- loving-dijkstra'nın TS kapısı: `node/test/gate-vectors.json` == `tools/gate-vectors.json` (diff boş), 3 vektör iki
  tarafta da geçiyor.

### testler
| nerede | komut | sonuç |
|---|---|---|
| `app/` | `npx tsc --noEmit` | geçti |
| `app/` | `npx expo lint` | 1 **eski** hata (`index.tsx:14` setState-in-effect, release'te de var), 9 uyarı |
| `app/` | `npx jest` | 68/68 geçti (7 dosya; +2 yeni) |
| `node/` | `npm test` | 28/28 geçti (+4 yeni) |
| `app/modules/kula-llama/audit-jvm` | `gradle test` (JDK 21, Android SDK yok) | 21/21 geçti (GateTest 2, AuditorGateTest 3, B64 2, Checks 7, DeviceKey 3, Ledger 3, Vectors 1) |
| `:kula-llama:testReleaseUnitTest` | — | **çalıştırılamadı**: bu makinede Android SDK/NDK yok; aynı test sınıfları audit-jvm'de koştu |
| apk derleme | — | yapılmadı (SDK yok); Kotlin değişiklikleri yalnız JVM'de derlendi, `WorkerService.kt` değişikliği (CLAIM_MIN_HELD_MB) JVM testine girmiyor, Android derlemesinde görülecek |

### telefonda release'e almadan önce dene
1. `npm run apk` ile derle (Kotlin: Gate.kt, WorkerService.kt, audit/ değişti). Emülatör + Mac dev-gate ile bölünmüş ve
   ayrı modu bir kez daha: dün geceki iki ekran görüntüsünün aynısı çıkmalı.
2. **Gece gerçek işçi**: telefonu şarja tak, pencere içinde, tutulan bir proje ve yerel bir model (Gemma 3 1B) varken
   passport kartında "birim" sayısı artmalı; "geceyi bitir" sonrası kart gelmeli. Mac dev-gate `--model` ile eşliyken
   iki cihaz adı ve her birinde birim görünmeli. Mac'i kapatınca o cihaz 5 dk "out", telefon devam etmeli.
3. **Defter**: işçi olarak paylaşımdan sonra `files/beyin/ledger.jsonl` dolmalı (connect/end/health); `kula-node ledger
   verify` ile Mac'te yazılan defter doğrulanmalı. Telefon defterini Mac'e çekip aynı komutla doğrulamak iki
   uygulamanın gerçekten aynı formatta olduğunun son kanıtı (vektörler geçti, canlı dosya denenmedi).
4. **kula-node**: `node/README.md`'deki `setup` + `share`; telefon bilgisayarı QR'dan eklesin, ayrı modda toplu test,
   sonra wi-fi'yi kesip telefonun 30 sn içinde yeniden sohbet edebildiğine bak (busy serbest kalmalı). `share`
   sırasında ctrl-c anında dönmeli.
5. Eski telefon/eski apk ile yeni işçi: eşleşme hâlâ çalışmalı (3 alanlı hello).

### açık kalanlar (düzeltilmedi, not)
- Ledger.kt: süreç satır ortasında ölürse yarım son satır zincire giriyor, `verify` ondan sonrasını hep reddeder;
  açılışta son satırı denetleyip kırpmak gerek. `DeviceKey.loadOrCreate` 3 satırdan kısa dosyayı sessizce yeni
  anahtarla eziyor; anahtar/alg/publicKey modülden dışarı verilmiyor (telefon dışında doğrulama yok).
- `Json.kt` ↔ `JSON.stringify`: `\b` `\f`, yalnız surrogate ve bazı ondalıklar farklı yazılır; bugünkü alanlarda
  çıkmıyor ama sözleşme bu.
- `claim` kuralı RSS ile ölçüyor; cihazın gerçek boş belleğiyle ölçülmeli.
- node: `--secret` bayrağı `ps`'te görünür (env/dosya seçeneği yok); `/load` girdileri (size, sha256 biçimi)
  doğrulanmıyor; `download` https→http yönlendirmeye izin veriyor; `share()`'in spawn argümanlarını sabitleyen test yok
  (127.0.0.1 bağlanması kodla doğrulandı: `-H 127.0.0.1`, `--host 127.0.0.1`).
- Gate.kt: `busy` kontrolü ile `currentPeer` ataması atomik değil; `connects++/rejects++` çok iş parçacığından.
- lint'teki eski `index.tsx:14` hatası.
- Güvenlik gözden geçirmesi: RPC sunucusu üç yerde de yalnız 127.0.0.1 (`Native.serve("127.0.0.1:…")`,
  `ggml-rpc-server -H 127.0.0.1`, dev-gate); secret hiçbir log satırında yok (QR/JSON çıktısı tasarım gereği).

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
