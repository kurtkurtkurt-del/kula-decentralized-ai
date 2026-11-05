# ilerleme — gerçek modeller, telefon kümesi, bilgisayarlar, beyin v0

Plan: `~/.claude/plans/memoized-kindling-puddle.md` (4.11.2026). Bu dosya her adımda güncellenir:
ne yapıldı, ne doğrulandı, ne kaldı. Döndüğünde önce burayı oku.

## integrate-all (5.11 sabah, cloud oturumu, dal `claude/integrate-all`)

`origin/claude/integrate-night` (`ec1ba27`) üstüne beş gece dalı sırayla merge commit'iyle alındı, squash yok;
her dalın commit'leri origin'dekiyle aynı (hepsi `--is-ancestor`). Release ve main'e dokunulmadı; PR açılmadı.

### sıra ve çakışmalar
| # | dal | çakışma | nasıl çözüldü |
|---|---|---|---|
| 1 | `claude/models-library` | yok | — |
| 2 | `claude/night-2` | `docs/ILERLEME.md` | iki bölüm de kaldı |
| 3 | `claude/node-master` | `docs/ILERLEME.md` | iki bölüm de kaldı |
| 4 | `claude/audit-ui` | yok | — |
| 5 | `claude/gate-tls` | `Gate.kt`, `node/src/gate.ts`, `tools/dev-gate.mjs`, `app/src/llm/engine.ts`, `node/README.md`, `ILERLEME` | aşağıda |

- **Gate.kt**: gate-tls'in yapısı (`handlePlain` / `handleTls` / `admit`, aynı portta v1 + v2) alındı; integrate-night'ın
  denetçi sertleştirmesi üstüne kondu: her denetçi kancası `audit {}` / `runCatching` içinde (defter yazılamazsa kapı düşmez;
  TLS'te denetçi patlarsa kapının kendi replay/saat kontrolü devreye girer), `NO` cevabı kayıttan **önce** yazılıyor, boş
  hello `no hello`. Bounded `readLine` iki tarafta da vardı.
- **node/src/gate.ts**: gate-tls'in v2 sunucusu (`servePlain` / `serveTls` / `admitted`) + integrate-night düzeltmeleri:
  her bacak `allowHalfOpen` (sunucu, yerel hedef, uzak, Tunnel'ın yerel bacağı), `close()` açık yuvaları kapatıyor (hem kapı
  hem Tunnel), rpc yuvası async connect'ten **önce** alınıp hata halinde bırakılıyor (`letGo`), hello/proof `trim`,
  Tunnel'ın yerel bacağına baştan error listener.
- **dev-gate.mjs**: v1 hello 3 ya da 4 alan + 4. alan rakam kontrolü (Gate.kt gibi); v2 her zaman 4 alan `KULA2`.
- **engine.ts**: import satırı — `peerTls` (gate-tls) ve `registerEngine` (models-library) birlikte.
- **peers.ts / peers.tsx / i18n**: çakışmadı; QR v3 (`peers.ts`) ve eş rozetleri (`peers.tsx`) ayrı dosyalarda, dict parçaları
  ayrı önekler kullanıyor (yeni `i18n.test.ts` çakışma olmadığını doğruluyor).

### bütünlük kontrolleri
- **dev-gate `--tls` ↔ node kapısı ↔ Kotlin**: `node/test/gate-vectors.json` == `tools/gate-vectors.json` ve
  `audit-vectors.json` da birebir (diff boş). v2 pin kanıtları `GateTlsTest` (Kotlin) ve `gate-tls.test.ts` (node) ile aynı
  vektörlerden. Üstüne yeni `node/test/devgate.test.ts` gerçek `dev-gate.mjs --tls`i başlatıp node istemcisiyle v1 (3/4 alan),
  yanlış pin, eşleşmemiş, pin ile eşleşme, eşleşmiş pinsiz, harcanmış pin, yabancı cihaz, yanlış parmak izi senaryolarını geçiyor.
  (dev-gate'e `--dir` eklendi; test geçici dizin kullanıyor, repo `.llama/`si kirlenmiyor.)
- **`LlamaWorker` ↔ night-2 planlayıcısı ↔ `chatLocal` reject düzeltmesi**: uyumlu. İşçi `chat()`i `await` ediyor, hata
  `catch`e düşüp cihazı 5 dk "out" yapıp birimi yığına geri veriyor; reject olmadan (eski `throw`) bu catch'e hiç
  düşülmüyordu. `stop()` yükleme sürerken gelirse ikinci `unload` duruyor. `scheduler.test.ts`, `engine-local.test.ts` yeşil.
- **kula-node `chat` api ↔ ApiServer.kt**: `ApiServer.kt` hiçbir dalda değişmedi (`a969577`); node-master'ın `api.ts`
  değişiklikleri `conformance.test.ts` + `api.test.ts`ten geçiyor.
- **Kotlin derlemesi**: `Gate.kt`, `GateCert.kt`, `audit/` JVM'de derlendi ve test edildi. `KulaLlamaModule.kt` /
  `WorkerService.kt` (audit-ui'nin defter fonksiyonları + gate-tls'in `identity`/`TlsServer`i) yalnız gözle birleştirildi:
  `SoftwareKey`, `gateDir`, `pairedFile`, `key` tanımları yerinde; **Android derlemesi bu makinede yok**.

### testler
| nerede | komut | sonuç |
|---|---|---|
| `app/` | `npx tsc --noEmit` | temiz (her merge'den sonra) |
| `app/` | `npx expo lint` | 0 hata, 9 uyarı (night-2 eski `index.tsx:14` hatasını gidermişti) |
| `app/` | `npx jest` | 148/148 (15 dosya; merge 1: 99, 2: 132, 4: 143, 5: 146, +2 yeni `i18n.test.ts`) |
| `node/` | `npm test` | 55/55 (merge 3: 46, 5: 54, +1 yeni `devgate.test.ts`) |
| `app/modules/kula-llama/audit-jvm` | `gradle test` (JDK 21, Android SDK yok) | 29/29 (GateTlsTest 7 eklendi; merge 4'te 22/22) |
| apk / `testReleaseUnitTest` | — | **yapılmadı** (SDK yok) |

### telefonda denenecekler
1. `npm run apk` ile derleme: `KulaLlamaModule.kt` + `WorkerService.kt` birleşimi ilk kez Android'de derlenecek.
2. Paylaş → QR **v3** (parmak izi + kod) → ikinci telefondan tara → eşleşme → ayarlar → **beyin denetimi**: `pair` satırı
   ve eşler sayfasında rozet görünmeli; aynı telefon ikinci bağlanışta kodsuz girmeli; kod harcanınca QR yenilenmeli.
3. Mac'te `node tools/dev-gate.mjs --secret … --tls` (ya da `kula-node share --tls`): telefon v3 QR'ı okuyup bölünmüş/ayrı
   modda sohbet etmeli; eski v2 QR (secret) aynı portta çalışmaya devam etmeli.
4. Modeller: çok parçalı bir gguf indir (parça parça ilerleme, tek kayıt), "kullanılmayanları sil", boş alan uyarısı, kilitli
   HF deposunda "lisansı oku".
5. Gece: "bu gece çalış" açık, şarjda, pencere içinde → gerçek işçi başlamalı; şarjı çek → duraklamalı, tak → kaldığı
   yerden; sabah `night/report` ve passport kartında "dün gece" satırı. Bir eş kapanınca birim başka cihaza gitmeli (reject
   düzeltmesi), döngü asılmamalı.
6. kula-node yönetici modu: `kula-node peers add/probe`, `kula-node master …` ile telefonlar işçi olarak; `ledger`.
7. Eski telefon (Android 7, API 24): işçi süreci açılmalı (`B64.kt`).
## testler ve i18n (5.11 gündüz, cloud oturumu, dal `claude/tests-i18n`)

`origin/claude/integrate-night` (`ec1ba27`) üstüne; başka dal birleştirilmedi (gate-tls'in v3 qr'ı, models-library,
audit-ui bu dalda yok). Sonuç: app 176 test (önce 68), node 40 (önce 28), `npx tsc --noEmit` temiz, `npx expo lint`
0 hata (9 eski uyarı). Tek komut: `cd app && npm run gate` (tsc → lint → jest → i18n denetimi).

### i18n bütünlük testi (`app/src/__tests__/i18n.test.ts`, `npm run i18n`)
- 795 anahtarın üçü de (en/de/tr) dolu, `{yer}` tutucuları üç dilde aynı, küçük harf üslubu (biri büyükle başlıyorsa
  üçü de), her `.one/.other` çiftinde `{n}` var.
- Kaynak taraması (`src/`, testler/vendor/i18n hariç): `t('…')`, `tn('…')`, `tx('…')` ile istenen her anahtar sözlükte;
  `tx('day.' + x)` ve ``t(`peers.kind.${…}`)`` gibi 13 ön ek için arkasında en az bir anahtar var; anahtar tabloları
  (OfflineBar `KIND`, AuthContext hata eşlemesi) da "istenen" sayılır.
- **Eksik çeviri çıkmadı**; sözlük üç dilde tam. Eklenenler: `model.err.nomodel`, `chat.err.gone`, `chat.err.busy`
  (sohbet ekranı `nomodel` / `peer gone` / `peer http 409` kodlarını ham basıyordu).
- **Kullanılmayan 232 anahtar** (rapor, hata değil; test çalışınca listeyi basar): çoğu kaldırılmış ekranlardan
  (`onboarding.*`, `signup.*`, `tagline.*`, `call.*`, `terms.*`, `closed.*`, `settings.email/password.*`,
  `friend.result.*`). Silmedim: web sitesi sözlüğünün aynası, karar senin. Test tavanı: sözlüğün üçte birinden az.

### llm birim testleri (`cluster`, `fit`, `peers`, `store`, `engine-remote`, `hf`, `native`)
- `planSplit`: eş yok / tek eş / ulaşılamayan (sebebiyle `skipped`) / taşınmış eş (NSD ile yeniden bulunur) / sığıyor
  ama paylaş (hıza göre, kapasiteyle kesilir, taşan buraya döner) / çıktı katmanı yerelde (eşler gerekmiyorsa `used`
  boş) / bilinmeyen bw→4, ram→2000 / `peerArgs` ağırlıkları / `splitSummary`. Sahte kapı + jest sahte saat (relocate
  4 s bekler).
- `fit`: passport yok, bütçe yok (ram_free×0.8, heap tabanı), tight bandı, ctx önerisi (2'nin kuvveti, en çok 4096,
  hiçbiri sığmazsa 512), bant genişliği yoksa tps yok, `fitTogether` boş liste.
- `peers`: v2 qr bozuk girdiler (boş, `{`, `null`, dizi, yanlış `k`, v1/v3/"2"/eksik → `old`, id/host/port eksik,
  secret kısa/hex değil/null/dizi, kendi kodu → `self`), büyük harf hex, 8 eş tavanı, `myPeerQr` gizi kalıcı.
  **Düzeltme:** `isPeerQr('null')` `false` yerine `null` dönüyordu. v3 qr bu dalda yok; gate-tls birleşince
  bu dosyaya v3 vakaları eklenmeli.
- `store.reconcile`: silinmiş dosya düşer, `.part` model sayılmaz, katalogdaki yarım `.part` "interrupted" indirme
  olarak görünür (retry devam ettirir), bilinmeyen `.part` yok sayılır, liste okunamazsa çökmez; indirme olayları
  running→done→kaydet, error+retry, cancel; `forgetModel` seçimi temizler; hook'lar her yazımda yeniden çizer.
- `engine.chatRemote` sahte XHR ile: parçalı chunk'lar, ortadan kesilmiş satır, son bayt readyState 3'te gelip
  readyState 4 boş, her şey tek seferde 4'te, yorum/keep-alive/bozuk json atlanır, akışta `error`, **409 busy →
  `peer http 409`**, done'suz biten akış, soket ölürse `peer gone`, `stop()` abort + `/stop`. `chat()` cihaz seçimi
  (boş olan, açık `device`, `nomodel`), `load()` üç modda (apart'ta yüklenemeyen eş `skipped`'a, split'te `toobig`
  → unload + reject).
- `hf`: arama satırları (gated/lisans tag ya da card'dan), dosya ağacı (çok parçalı ve mmproj elenir, küçükten
  büyüğe), `hf 429/404`, `quantOf/paramsOf/kvGuess`.

### gece işçisi döngüsü (`night-loop`, `jobs`, `useNight`)
- Cihaz birimin ortasında koparsa: birim yığının önüne döner, öbür cihaz alır, kopan 5 dk dışarıda; kaynak `next()`
  fırlatırsa gece temiz biter; `done()` fırlatsa sayım sürer.
- `stop()` model yüklenirken: döngü başlamaz, bir kez daha unload, ekran kilidi kapanır; birimin ortasında `stop()`:
  cihazda durdurulur, geç gelen cevap sayılmaz/kaydedilmez; gece içinde ikinci `start()` eskisini bitirir.
- Bilinen cevap: `**Positive**`, `"positive".`, `Negative — …` doğru; `positively`, boş, "The sentiment is positive"
  yanlış; yanlış cevap cihazın kaydında, birim yine sayılır.
- `useNight`: koşullar (şarj/dolu, wifi isteğe bağlı, pencere, passport), bekleme sebebi sırası, sunucu başlatmayı
  reddederse başlamaz, koşul düşünce `endNight` toplamlarla, `endNow`, gerçek/simülasyon işçi seçimi, `startNightWatch`
  (30 s, app aktif, pil olayı). Hook `react-test-renderer` ile.
- **Bulgu (davranış, değiştirmedim):** yığın boşalmışken kopan cihazın birimi yığına döner ama gece bitmiş olur; birim
  o gece yapılmaz (demo kaynakta kaybolur, sunucu kaynağı ertesi gece verir). İlk test bunu belgeliyor.

### node
- `test/vectors.test.ts`: `app/modules/kula-llama/tools/gate-vectors.json` **dosyanın kendisi** okunur (kopya değil);
  `node/test/gate-vectors.json` onunla bayt bayt aynı olmalı; her vektör `clientProof/serverProof`'tan çıkar, kanal
  mesajın parçası. `app/` yanında yoksa atlanır.
- `test/api-errors.test.ts`: 404/yanlış metod; `/load` bozuk json, eksik alan, `..`/`/`/boş ad, yol → taban ad,
  kaynak 404, dinlenmeyen host, başlamayan backend (`kula-node setup` cümlesi); `/chat` modelsiz 409, mesajsız 400,
  backend 503 → akışta hata; sohbet sürerken `/load`/`/unload`/`/chat` 409 busy, `/stop wasBusy`, ikinci `/unload`
  zararsız; 1 MB üstü gövde reddi.

### kapsam (`npm run coverage`, `src/llm` + `src/night`)
Satır bazında hepsi ≥ %80: toplam %96.4 ifade / %88.6 dal / %99.2 satır. En düşük `native.ts` %85.7 ifade (modül
varken `return llama` satırı jest altında erişilmez). Önce `hf.ts` %0, `useNight.ts` %0, `native.ts` %43 idi.

### başka
- `src/app/index.tsx`: night-2'deki lint düzeltmesinin aynısı (effect içinde setState → türetilmiş değer); artık
  `expo lint` 0 hata, böylece `npm run gate` yeşil. night-2 birleşince çakışmaz (içerik aynı).
- Jest'in `jest.mock` fabrikası `mock` ön ekli olmayan dış değişkeni (tip parametresi adını bile) kabul etmiyor;
  `@/llm/native` sahtelerinde `get llama()` getter'ı gerekli (fabrika, `const`'tan önce çalışıyor).
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
## planlayıcı simülatörü (5.11 gece, cloud oturumu, dal `claude/planner-sim`, `integrate-night` üstüne)

Birleştirilmedi, PR yok. Ayrıntı: `docs/PLANNER.md`.

- **`app/src/llm/sim/`**: saf TS küme simülatörü. `model.ts` (import'suz çekirdek: bellek, tek başına /
  bölünmüş / ayrı mod maliyeti, `planShares`, `pickDevice`, `simulateApart`), `profiles.ts` (S25+, Pixel 8,
  orta 6 GB, eski 4 GB, emülatör, Mac M1, Linux 4090; wi-fi 5/2.4, hotspot, emülatör NAT; 9 katalog modelinin
  katman/hidden/vocab'ı). Ölçülen gerçeklere kalibre: Mac 34 tok/s → 32.6; emülatör↔Mac 415 MB / 335 s → 445 MB /
  347 s; S25+ Gemma 1B sığar; emülatöre hiçbiri sığmaz (`sim.test.ts`).
- **`planSplit` yeni kurallar**: ihtiyaç ctx'e göre (dosya×1.05 + kv + 300, fit.ts ile aynı); gömme + çıktı
  katmanı her zaman yöneticide (eski plan yavaş yöneticiye 0 MB verebiliyordu); aday sayısı token süresiyle
  seçilir → yavaş ağda daha az cihaz; `aloneFaster` bayrağı 1.15× eşiğiyle. Önce/sonra tablosu PLANNER.md'de.
  `cluster.ts` artık çekirdeği çağırır, `Plan`'a `est/estAlone/aloneFaster` eklendi; `load()` ctx'i geçirir.
- **Ayrı mod dağıtıcısı** (`engine.chat`): en-hızlı-boş yerine beklenen bitiş süresi (kuyruk + istem/8·tps +
  çıktı/tps); kısa istek boş yavaş cihaza, uzun istek hızlıyı bekler; ilk token gelmeden düşen eş 5 dk dışarı,
  istek bir kez başkasına; ölçülen tps cihaza yazılır. `engine-apart.test.ts` (sahte native + XHR).
- **Mod sayfası**: üç seçeneğin altındaki tahminler simülatörden (tok/s, "~N sn'de hazır", "wi-fi'de her token
  ~X ms", paylar, "tek başına daha hızlı olurdu"); paylaş sorusu da sayı gösterir; i18n en/de/tr
  (`mode.est.*`). Ağ şimdilik 5 GHz varsayımı.
- **node/**: `src/sim.ts` = `app/src/llm/sim/model.ts` kopyası (test bayt bayt karşılaştırır), `src/planner.ts`
  node-master'daki kopyanın aynı değişiklikle hâli (`planSplit/planWithProbe/tensorSplit`, `TooBig`).
  `tools/planner-vectors.json` (10 vektör, `tools/planner-vectors.gen.ts` üretir) iki tarafta da test edilir.
- Testler: app 90/90 (yeni: sim 18, engine-apart 4), node 35/35; tsc ikisinde temiz; lint: aynı 1 eski hata.
- Kalmış: telefonda ölçüm listesi PLANNER.md sonunda (telefon `eff`, gerçek wi-fi yükleme, bölünmüş tok/s);
  mod sayfasına ağ seçimi (5/2.4 GHz) eklenebilir; `node/` tarafındaki `mastercmd` bu dalda yok (node-master'da).
## ux cilası (5.11 gündüz, cloud oturumu, dal `claude/ux-polish`, taban `claude/integrate-night`)

Kullanıcı uyurken, soru sormadan. Üç commit; tsc temiz, lint'te yalnız eski `index.tsx:14` hatası, 80 test (12 yeni).

| madde | ne yapıldı | nerede |
|---|---|---|
| ilk açılış akışı | modeller sekmesinin üstünde adım çubuğu **ölç → indir → çalıştır → birleştir**: bulunduğun adım vurgulu, bir cümle neden, bir düğme sonrakine; her basamağa dokunulabilir. passport yoksa "bu telefonu ölç". dört adım da bitince (ya da "gizle") bir daha gelmez (kv `ux.flags`: `ran`, `stepsDone`; `ran`ı engine `load` başarınca yazar) | `components/StepBar.tsx`, `llm/steps.ts` (saf), `llm/store.ts` |
| hata sözlüğü | `classify()` ham metni bir türe indirir (ağ yok · disk dolu · sha tutmadı · eşe ulaşılamıyor · meşgul · sığmadı · yanlış secret · hf kilitli · 404 · 5xx · yarım kaldı · eş yok · native yok · model yok), `explain()` tr/en/de tek cümle; bilinmeyen türde kısa ham ipucu parantezde. modeller / model / sohbet / eşler / paylaş ekranlarında `(e as Error).message` kalmadı (eş qr kodlarının kendi `peers.err.*` sözleri korundu) | `llm/errors.ts`, `i18n/parts/ux.ts` (`err.*`) |
| boş durumlar | modeller ("en küçüğünü indir"), eşler ("kod tara"), sohbet (model yoksa "birini başlat"; varsa hangi modelin nerede cevap vereceği), hf araması için ipucu. tek cümle + tek düğme | `components/EmptyState.tsx` |
| indirme kartı | durum sözle, hız (mb/sn, store'da yumuşatılmış), kalan süre ("4 dk kaldı"/"az kaldı"), **duraklat / devam** (duraklatma = satırı tutan iptal; `.part` kalır, devam Range ile sürer), "arka planda sürer; uygulama kapanırsa kaldığı yerden devam eder" notu, ilerleme çubuğuna a11y değeri. model sayfasında da aynı kart | `components/DownloadCard.tsx`, `llm/progress.ts` (saf), `store.ts` `pauseDownload` |
| mod sheet'i | üç seçenek kart: tahmin (~tok/s), sığma rozeti, bir satır açıklama; devre dışıysa açıklama yerine **neden** ("bağlı cihaz gerekir" / "bütün cihazlara bile sığmıyor"); seçilen vurgulu (radyo), en altta tek "başlat · …" düğmesi; son seçilen mod hatırlanır | `app/model/[id].tsx` `ModeCard` |
| sohbet | yukarı kaydırınca "↓ en alta" düğmesi (akış seni aşağı çekmez), cevaba uzun bas → kopyala ("kopyalandı"), son cevapta "↻ yeniden üret" (kv cache sıfırlanır), tok/s satırı okunur (büyük sayı + kelimeler, 2 satıra sığar), üretim sırasında araç satırı yerine **belirgin durdur çubuğu** | `app/chat.tsx` |
| erişilebilirlik | bu ekranlardaki bütün Pressable'larda `accessibilityRole`/`Label` (gerekince `State`, `Hint`, `LiveRegion`), dokunma alanı ≥44 (btn'ler `minHeight: 44`, × düğmeleri 44×44, satırlar `minHeight: 56`), açık gri `meta` metinler okunur `mute`'a çekildi (kontrast), sabit yükseklikler kaldırıldı + `lineHeight` (dinamik yazı). Button bileşeni `disabled` ve a11y aldı | ilgili ekranlar, `Button.tsx`, `PickerSheet.tsx` |
| küçükler | haptics: seçimde (mod, picker, indir, çalıştır, eş ekle/sil) `selection`, indirme bitince `success`, hata `error`; QR gösterilirken parlaklık 1.0, kod gidince / sayfa kapanınca eski değer (`expo-brightness`, izin gerekmez) | `lib/haptics.ts`, `app/share.tsx` |

Notlar:
- `expo-haptics ~57.0.3`, `expo-brightness ~57.0.2` — `npx expo install` proxy yüzünden sürüm listesine ulaşamadı, `bundledNativeModules.json`daki sürümlerle `npm install` yapıldı. **Native modül: yeni dev build gerekir** (Expo Go'da zaten çalışmıyordu).
- Emülatörde/telefonda bakılmadı (cloud oturumu). Denenecekler: adım çubuğu passport yokken; indirmede duraklat → devam (Range'in `.part`tan sürdüğü); sohbette uzun cevapta "en alta"; QR'da parlaklık ve geri dönüş.
- `claude/models-library` ve `claude/audit-ui` aynı ekranlara dokunuyor; birleştirirken `models.tsx`, `model/[id].tsx`, `chat.tsx` çakışabilir.
## belgeler (5.11 cloud oturumu, dal `claude/docs`)

`origin/claude/integrate-night` üstüne yalnız belge; kod değişmedi. Öteki beş dal (`gate-tls`, `node-master`,
`night-2`, `audit-ui`, `models-library`) okundu ve belgelere dahil edildi; henüz birleştirilmemiş özellikler
belgede dalının adıyla işaretli (kapı v2, `kula-node peers/chat`, gece planlayıcısı ve rapor, beyin denetimi
ekranı, parçalı indirme).

### yazılanlar
- `docs/ARCHITECTURE.md` (en): bileşenler ve dosya rolleri, iki süreç (uygulama, `:worker`) şeması, kapı/tünel
  şeması, indirme · ayrı · bölünmüş · gece için ayrı mermaid sıra diyagramları, telefon/bilgisayar/depo dosya
  yerleri tablosu, "neden böyle" (RPC 127.0.0.1, ayrı süreç, Range + sha zorunlu, ayrı mod varsayılan,
  sürüm sabit, beyin yalnız kontrol eder, saf fonksiyonlar, ölçüm kula'nın değil).
- `docs/GUIDE.en.md`, `docs/GUIDE.tr.md`: kurulum (apk, demo olarak gir), ölçüm, hangi telefona hangi model
  tablosu + katalogdaki dokuz modelin ne için olduğu, mod sorusu, sohbet ve toplu test, iki telefonu QR ile
  birleştirme adım adım, bilgisayar ekleme (kula-node), gece koşulları ve "uygulama açık kalmalı" sınırı, sorun
  giderme (wi-fi istemci yalıtımı, hotspot, busy/channel closed/wrong secret, pil kısıtlaması: Samsung, Xiaomi,
  Huawei, OnePlus), SSS (Berlin → relay yok, Tailscale/ZeroTier + yalnız ayrı mod).
- `docs/GATE.md` (en, gate-tls'teki Türkçe taslağın yerine): v1 ve v2 tek belgede, QR v2/v3, ret nedenleri tablosu,
  tünel, dev-gate bayrakları, tehdit modeli tablosu, durum (v2 cihazda denenmedi).
- `docs/AUDIT.md`: defter biçimi ve imzalanan baytlar, olay alanları, anahtar, denetim kuralları ve sayıları,
  zincir doğrulama (Kotlin, `kula-node ledger --verify`, telefondaki ekran), rozetler, dışa aktarma/temizleme,
  bilinen boşluklar, testler.
- `docs/NIGHT.md`: koşullar tablosu, planlayıcı durum makinesi, parça, birim türleri, döngü, rapor alanları,
  ayarlar ve anahtarları, sınırlar.
- `docs/NODE.md`: kurulum (platform tablosu), `share/probe/ledger/peers/chat` komutları ve bayrakları, dosyalar,
  ilk çalıştırma, "yerel ağın ötesi" (relay yok; özel ağ ile ayrı mod).
- `docs/SERVERS.md`: eski README'nin demo/canlı sunucu bölümü olduğu gibi taşındı.
- `CONTRIBUTING.md`: ağacın kuralları (android üretilir, llama ağacı script'ten, passport sync, apk yalnız
  `npm run apk`, RPC 127.0.0.1, vektörler iki tarafta aynı), kurulum, test komutları tablosu, commit üslubu,
  dallar, belge dili, güvenlik bildirimi.
- `README.md` kısaltıldı: klasörler, belge tablosu, bir dakikada, kurallar, sunucular, lisans. Eski afterhours
  notları (1 300 satır) göreli yolları bozulmasın diye kökte `AFTERHOURS.md`'ye taşındı.
- `app/CREDITS.md`: device-passport, ggml rpc, 4.11'den beri eklenen paketler (expo-camera/clipboard/battery/
  network/notifications/sharing/sqlite/file-system, react-native-qrcode-svg, bonjour-service MIT,
  qrcode-terminal Apache-2.0, tsx), TLS'nin platformdan geldiği.
- `tools-docs-links.mjs` (kök, bağımlılıksız): bütün göreli bağlantılar ve `#` çapaları; `--external` ile dış
  adresler. Sonuç: 15 dosya, 57 bağlantı, 0 kırık. Dış kontrol: tek markdown dış bağlantı
  (`kurtkurtkurt-del.github.io/afterhours`, AFTERHOURS.md) bu konteynerden çözümlenemedi (ağ politikası);
  CREDITS'teki adresler düz metin olduğundan sayılmadı.

### kararlar
- Teknik belgeler İngilizce (kod ve yorumlar gibi), kılavuz iki dilde, ILERLEME Türkçe. GATE.md bu yüzden
  İngilizceye çevrilip tamamlandı.
- Henüz yazılmamış şeyler (relay, KeyStore anahtarı, sunucudan iş, `night_report` canlı rpc) belgede "yok" diye
  açıkça yazıldı; var gibi anlatılmadı.
- Başka dallardaki özellikler belgelendi ama birleştirme ya da PR yapılmadı; release/main'e dokunulmadı.

### açık kalanlar
- Belgeler koda göre yazıldı, cihazda doğrulanmadı: ekran adları i18n anahtarlarından, pil ayarı yolları
  üreticilerin genel menülerinden. Telefonda bir tur sonra GUIDE'ın 5., 7. ve 8. bölümleri gözden geçirilmeli.
- `node/README.md` bu dalda integrate-night sürümü; `node-master` birleşince `peers/chat` bölümü kendiliğinden
  gelir, NODE.md ona göre yazıldı.
- `docs/shots/` görüntüleri kılavuza bağlanmadı (emülatör görüntüleri; gerçek telefon görüntüsü alınınca).
## güvenlik incelemesi (5.11, cloud oturumu, dal `claude/security-review`)

`origin/claude/gate-tls` + `origin/claude/integrate-night` merge edildi (üç dosyada elle çözüm: `Gate.kt`,
`gate.ts`, `dev-gate.mjs`; gate-tls yapısı + integrate-night'ın yarım-açık soket/denetçi düzeltmeleri),
sonra bütün küme yüzeyi saldırgan gözüyle incelendi. Belge: **`docs/SECURITY.md`** (tehdit modeli, 20
bulgu, kalan riskler). Release/main'e dokunulmadı, PR yok.

- **Yüksek, düzeltildi:** telefonun işçi secret'ı `Math.random`'dan türüyordu → `expo-crypto`
  (`app/src/llm/random.ts`); `/load name` ile uygulama dizininde keyfi dosya yazma/silme → `ModelName.safe`.
- **Orta, düzeltildi:** `/load url` SSRF + yönlendirme (URL politikası, çözümlenen adres, 5 atlama); disk
  doldurma (boyut üst sınırı, 512 MB serbest); ApiServer başlık/gövde sınırları; tek-usta yarışı (`RpcSlot`);
  yarım açık bağlantı seli (`MAX_HANDSHAKES=32 → NO overloaded`); downgrade (`secret=null → NO no v1`,
  `kula-node share --tls` artık v1 kapalı); TOFU zehirleme (eşleşme kodu 10 dk, `NO pin expired`).
- **Düşük, düzeltildi:** JNI uçları yalnız `127.0.0.1` (`isLoopbackEndpoint`), paylaşım ekranı `FLAG_SECURE`,
  `/load` indirme için sha zorunlu, ret kaydı NO'dan önce.
- **Açık (karar):** telefon işçisi eski ustalar için v1'i hâlâ kabul ediyor (önerim: v3 ile eşleşince kapat);
  `kula-node share` varsayılanı hâlâ `--tls`siz; loopback'teki tünel/RPC aynı cihazdaki her uygulamaya açık;
  kv-store secret'ı yedeklere gidebilir (`allowBackup`); `paired` unutma arayüzü yok.
- Testler: JVM 36/36 (`GuardTest` 5, `GateSecurityTest` 3 yeni; `audit-jvm`'de proxy 429 yüzünden
  `gradle test --max-workers=1`), node 42/42 (`security.test.ts` 7 yeni), jest `security.test.ts` 3/3,
  `tsc` iki tarafta temiz; `expo lint`in tek hatası (`index.tsx` setState) önceden vardı. Android/NDK derlemesi
  yok: `ApiServer.kt`, `ModelDownloader.kt`, `WorkerService.kt`, `KulaLlamaModule.kt`, `kula_llama.cpp`
  değişiklikleri **cihaz derlemesinde** görülecek; `FLAG_SECURE` ve pin yenilenmesi emülatörde bakılmalı.
## aktarıcı (5.11 gündüz, cloud oturumu, dal `claude/relay`)

Soru: "Berlin'deki biriyle telefonlarımı birleştirebilir miyim?" Şimdiye kadar hayır (iki NAT). Bu dal
beyin'in aktarma hizmetinin ilk hâli; tam anlatım `docs/RELAY.md`.

- Dal: `origin/claude/gate-tls` üstüne önce `origin/claude/integrate-night` (çakışma: `Gate.kt`, `gate.ts`,
  `dev-gate.mjs` — v2 yapısı korundu, gecenin yarı açık boru / `audit{}` sarmalayıcı / rpc slot sırası /
  `\r\n` toleransı içeri alındı), sonra `origin/claude/node-master` (`peers`/`chat` komutları; yalnız doc
  çakışması) merge edildi. Release/main'e dokunulmadı, PR açılmadı.
- `node/relay/` **kula-relay**: `ws` üstünde WebSocket (gerekçe RELAY.md: PaaS/443/RN/çerçeveleme hazır).
  Kayıt `{id,name,fp}` → 6 haneli kod, 10 dk, dolunca yenisi; yönetici `{code}` ile gelir, akış başına ikinci
  bağlantı, aktarıcı ikili çerçeveleri boru yapar, içerik görmez. Aynı anda tek yönetici (`busy`), IP başına
  120 bağlantı/dk ve 10 yanlış kod/dk, oturum başına 1 GiB, 16 akış, 1 MiB çerçeve, 5 dk sessizlik.
  Dockerfile, `fly.toml`, `render.yaml`, README; `/health`.
- kula-node: `share --relay wss://…` (tls'i zorlar; QR v3'e `relay`, ekrana `peers add` satırı);
  `peers add "123456 <pin>" --relay …` (`$KULA_RELAY`), v3 QR + relay ayrıştırma; `peers probe` aktarıcıdan
  `api` dener, sertifikayı öğrenir ve pinler; `chat --mode apart` uzak eşi `RelayTunnel` ile cihaz yapar,
  `--mode split` uzak eşi probe etmeden atlar ve söyler. `handshake` artık her Duplex'te çalışır ve `fp`
  döndürür; `TlsClient.fp=''` = öğren (pin kanıtı iki parmak izini kapsadığı için araya giren aktarıcı
  `wrong pin` alır). `ws` kula-node bağımlılığı oldu.
- Uygulama: `Peer.relay`, `Settings.relayUrl`; `share.tsx` "uzaktan paylaş" + aktarıcı adresi, ekranda kod;
  `peers.tsx` "kod ile ekle" (`123456 0123…`), uzak eş satırı, kontrol uzak eşi `api`den; `cluster.ts`
  uzak eşi split'te `remote` ile atlar, NSD aramaz; mod sayfası "n uzaktaki dışarıda: bölünmüş aynı wi-fi
  ister"; ayarlar sayfasında aktarıcı alanı. `native.ts` imzaları: `probePeer(..., relay)` ("ok <fp>"
  döner), `apiTunnel(..., relay)`, `startWorker(..., relay)`.
- Kotlin: `Relay.kt` (OkHttp WebSocket; `Relay.Worker` dışarı bağlanır ve akışı `127.0.0.1:kapı`ya borular;
  `Relay.Master` + `RelaySocket` (Socket alt sınıfı, TLS üstüne biner)); `Gate.probe/Tunnel` relay alır,
  `PinnedTrust("")` öğrenir, `peerFp`; `WorkerService` `EXTRA_RELAY`, durum dosyasında `relay`/`relayError`;
  `build.gradle` okhttp 4.12. **Cihazda denenmedi, derlenmedi** (cloud'da Android SDK yok).
- Testler: node 54 → 61 (`relay.test.ts` 6: uçtan uca ayrı sohbet + aktarıcının gördüğü her çerçeve TLS
  kaydı, kod süresi, ikinci yönetici `busy`, hız sınırı, yalnız kodla eş pin kanıtıyla sertifika öğrenir /
  yanlış pin / pinsiz / başka parmak izi, `openApart`+`planWithProbe`; `peers.test.ts` +1). Jest 72 geçiyor
  (+3: v3+relay, elle kod, `probeAll` remote). `tsc` iki pakette yeşil. **Önceden var olan ve bu dalın
  dokunmadığı iki kırmızı:** `expo lint` `index.tsx:14` hatası (ILERLEME'de zaten not), jest
  `engine-local.test.ts` suite'i `expo-sqlite/WebStorage` yüzünden açılmıyor (gate-tls'te de aynı).
- Sabah için: Mac'te `cd node && npm test`; `cd node/relay && npm run dev` (8787) → bir uçbirimde
  `kula-node share --relay ws://127.0.0.1:8787`, öbüründe `peers add "<kod> <pin>" --relay ws://127.0.0.1:8787`
  → `peers probe` → `chat --mode apart --model-url …`. Sonra Fly'a `fly deploy`, telefonda apk.

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

## 5.11 cloud: bilgisayardan küme yönetimi (`claude/node-master`)

`origin/claude/loving-dijkstra-ku8d4t` + `release/local-2026-10-20` üstüne, yalnız `node/` içinde:

- `kula-node peers add|list|rm|probe|scan`: eşler `~/.kula-node/peers.json`'da (600). `add` QR json v2, base64url kod
  (`list --code`) veya `host:port:secret` alır. `probe` iki kanalda TCP+el sıkışma (2 sn), `scan` `_kula._tcp`
  (bonjour-service). Secret ekrana yazılmaz.
- `kula-node chat --model <gguf> --mode apart|split [--peer …] [--batch] [--prompt]`:
  - ayrı: yerel llama-server + her eşin `api` kanalına tünel → `/load`, `/chat` SSE; istem en hızlı boş cihaza
    (önce bant genişliği, sonra ölçülen tok/s). Eşler modeli bu bilgisayardan çeker (rastgele yollu HTTP, Range var;
    `--model-url` ile dış adres). `--batch` 8 istemi dağıtır, cihaz başına tok/s yazar.
  - bölünmüş: `src/planner.ts` = `app/src/llm/cluster.ts`'nin kopyası (çıktı katmanı yerelde, 0.7/0.75/1.1); eş başına
    `rpc` tüneli, `llama-server --rpc 127.0.0.1:p1,… --tensor-split yerel,p1,…`.
  - Yüklemeden önce 2 sn probe; cevap vermeyen eş sebebiyle düşer, `ggml_backend_rpc_add_server` abort etmez.
- İkili yoksa: split "run kula-node setup" der ve durur; apart yerel cihazı düşürüp eşlerle devam eder.
- Testler (42, hepsi geçti; llama ikilisi yok, sahte süreçler): planlayıcı birimleri, eş defteri + yanlış secret reddi,
  ayrı mod uçtan uca (iki sahte işçi gerçek kapı arkasında, 8 istem, tok/s), split planı + tüneller + sahte llama-server.
- Gerçek cihazla denenmedi (cloud'da telefon/ikili yok). Sabah: Mac'te `npm test`, sonra emülatör "telefonu paylaş" QR'ı ile
  `peers add` → `peers probe` → `chat --mode apart --batch`.

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

## 5.11 cloud: beyin denetimi arayüzü (`claude/audit-ui`)

- `origin/claude/quirky-einstein-hy2v69` (beyin/check v0) üstüne `release/local-2026-10-20` birleştirildi, üstüne:
- **Ayarlar → uygulama → beyin denetimi** (`app/src/app/audit.tsx`): defterin son 200 satırı (en yeni üstte), tipine göre
  süzme çipleri (eşleşme / bağlantı / ret / yükleme / iddia-ölçüm / sağlık / bitiş), üstte ret · uyarı · satır sayaçları,
  zincir doğrulaması (her satırın `prev`'i bir öncekinin sha256'sı mı; pencere ortadan başlıyorsa "bu pencerede sağlam",
  kırıksa kırmızı kutu ve satır numarası), "dışa aktar" (expo-sharing, `beyin-<tarih>.jsonl`), "defteri temizle" (onaylı).
- **Eşler**: her cihazın yanında rozet — doğrulandı (adaçayı) / uyarı (altın) / reddedildi (kiremit) / henüz yok (meta);
  defterdeki o adrese ait en yeni satırdan (`peerBadge`). Renkler `theme/tokens` → `theme/audit.ts`.
- `app/src/llm/audit.ts`: satır tipleri, `parseLedger`, `verifyChain`, `summarize`, `peerBadge`, `detailOf`, saf TS sha256.
  Test: `src/__tests__/audit.test.ts` (örnek defter, kırık zincir, eksik satır, boş defter, rozetler).
- Native: `auditLedger(limit)` (gateLedger ile aynı kuyruk), `clearAuditLedger()`; `Ledger.clear` döndürülmüş dosyaları da
  siler, temizlikten sonraki ilk `append` zinciri sıfırdan (genesis) başlatır — işçi süreci defteri açık tutsa bile.
  JVM testi `LedgerTest.clearRemovesEveryFileAndRestartsTheChain`. JVM testleri (`audit-jvm`, `gradle test`) 18/18 yeşil; Expo modülü (`KulaLlamaModule.kt`) Android SDK ister, cloud’da derlenmedi.
- i18n: `src/i18n/parts/audit.ts` (en/de/tr), `dict.ts`'e eklendi. `npx tsc --noEmit`, `npm test` (70 test) yeşil;
  lint'te yalnız dalın öncesinden gelen `index.tsx` hatası var, bu dalın dosyaları temiz.
- Apk derlenmedi (cloud); Android tarafı emülatörde denenmeli: paylaş → başka cihazdan bağlan → ayarlar → beyin denetimi.

## 5.11 cloud: kapı v2 — TLS, cihaz sertifikaları (`claude/gate-tls`)

`origin/claude/quirky-einstein-hy2v69` üstüne `release/local-2026-10-20` ve `loving-dijkstra`
(`node/`) birleştirildi; üstüne beyin protokol v2'nin kapı kısmı yazıldı. Tam tarif `docs/GATE.md`.

- **Aynı port, iki protokol:** sunucu ilk bayta bakar (`0x16` TLS ClientHello → v2, `K` → v1 düz).
  Eski telefon / `--tls`siz dev-gate / v2 QR aynen çalışır.
- **v2:** TLS 1.3, iki taraf da öz imzalı P-256 sertifika (elle DER, BouncyCastle yok; Ed25519 cihaz
  anahtarının yanına ayrı P-256 kapı anahtarı — Conscrypt gerekçesi GATE.md'de). Usta `fp`'yi
  QR'dan sabitler; işçi ustayı ilk bağlantıdaki tek kullanımlık `pin` kanıtıyla sabitler (`paired`
  dosyası, iki yönlü TOFU), kod harcanır ve yenisi üretilir. Hello `KULA2 <kanal> <nonce_c> <ts>`;
  tekrar nonce ve saat denetçi olmasa da reddedilir.
- **QR v3:** `{"k":"kula-peer","v":3,"id","name","host","port","fp","pin","passport",…}`;
  `app/src/llm/peers.ts` v2 ve v3 okur, `makePeerQr` fp varsa v3 üretir; `share.tsx` işçi
  çalışınca v3 gösterir (durum dosyasından `fp`/`pin`), parmak izi ve kodu yazar.
- **Kotlin:** `GateCert.kt` (DER + `GateIdentity` + `Paired`), `Gate.kt` (TLS sunucu/istemci,
  `TlsServer`/`TlsClient`, `PinnedTrust`, hostname doğrulaması yok), `WorkerService` kimlik +
  eşleşme listesi + kod döndürme, `KulaLlamaModule` `probePeer`/`apiTunnel`/`loadModel` `{fp,pin}`
  alır, `gateFingerprint()`.
- **TS:** `node/src/tls.ts` (aynı DER), `gate.ts` TLS dalı (Duplex ön-ek ile sniff; `unshift`
  TLSSocket'ta çalışmıyor), `share --tls`, `probe --fp --pin`; `dev-gate.mjs --tls` (sertifikayı
  `openssl` ile yapar, `.llama/dev-gate/`).
- **Vektörler:** `gate-vectors.json` → `v2` (pin kanıtları) ve `cert` (TBS sha256; Kotlin ve TS
  aynı baytı yazıyor).
- **Testler:** JVM `GateTlsTest` 7 test (sertifika, disk kimliği, eşleşme→yalnız sertifika,
  yanlış kod, yanlış parmak izi, yabancı sertifika, tekrar nonce, eski saat, kötü hello'lar,
  istemci sertifikasız, TLS'siz sunucu, 300 KB boru, aynı portta v1) → audit-jvm 24/24;
  node `gate-tls.test.ts` 8 test → 32/32; app jest 62/62, tsc temiz. dev-gate `--tls` kula-node
  istemcisiyle elle denendi (eşleşme, ret nedenleri, kod döndü).
- **Cihazda denenmedi.** Android derlenmedi (cloud'da SDK yok): `SSLSocketFactory.createSocket(
  Socket, InputStream, Boolean)` (API 24+), Conscrypt'te `wantClientAuth` + TLS 1.3 istemci
  sertifikası, Expo'nun `Map<String, Any?>?` argümanı emülatörde doğrulanmalı. `share.tsx`'teki
  `status.pin` yenilenmesi 2 s'lik durum döngüsüne bağlı. Sonraki: anahtarı Android KeyStore'a
  (`KeyStoreKey`), `peers.tsx`'te eşleşmiş/kod bekliyor göstergesi, kula-node `--tls`i varsayılan yapmak.

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

## 5.11 cloud: model kütüphanesi (`claude/models-library`, `release/local-2026-10-20` üstüne)

Yalnız JS; native dokunulmadı (indirici parça başına aynı `download(id,url,name,sha,size)` çağrısını alır).

- `hf.ts`: çok parçalı gguf (`-00001-of-0000n`) tek girdi (`parts[]`, toplam boyut, her parçanın sha256'sı; eksik parça seti atlanır);
  `hfFetch` 429/5xx/ağ kopmasında geri çekilme (retry-after, 1-2-4 sn, 3 deneme) ve `HfError` kodu
  (`ratelimit`/`offline`/`gated`/`notfound`/`http`); `cardData.license` öncelikli, `gated` "auto"/"manual" da kilitli sayılır;
  `licenseUrl`, `FILE_FILTERS` (Q4_K_M, Q8_0, ≤2 gb, ≤4 gb, tek dosya), `SUGGESTED_QUERIES`.
- `store.ts`: `LocalModel.parts[]`; indirme parça parça (`<id>#<n>` native kimliği), hepsi inince tek kayıt, `path` ilk parça
  (llama.cpp kalanını yanında bulur); `reconcileModels` her parçayı arar; `forgetModel` önce motoru boşaltır
  (`registerEngine` kancası, döngüsel import yok) ve bütün parçaları siler; `forgetUnused` seçili ve çalışanı korur;
  `readMeta` gguf başlığını bir kez okuyup katman/kv/ctx_max'ı kayda yazar; arama geçmişi son 5 (`llm.hfHistory`).
- `fit.ts`: `kvFromMeta` (katman × kv başı × (k+v) × 2 B), `factsFromMeta`, `fitInput` (başlık varsa katalog/tahmini ezer),
  `suggestCtx` (sığan en büyük 2ⁿ, model sınırı ve 8k ile; sığmazsa 1k).
- `disk.ts`: `Paths.availableDiskSpace` (expo-file-system 57, senkron getter, bayt); 200 MB pay.
- Modeller sekmesi: "modeller X gb · Y gb boş" + "kullanılmayanları sil (n)"; indirmeden önce boş alan kontrolü ve ne kadar
  eksik olduğu; HF satırında 🔒 + "lisansı oku"; kilitli depoda dosya listesi açılmaz, açıklama + tarayıcı; son aramalar ve
  öneri çipleri; dosya süzgeci çipleri; HF hatası okunur mesaj. Model sayfası: HF modelleri için de parametre/quant/katman/
  kv/lisans/kaynak satırları, "lisansı oku" + "hugging face" bağlantıları, ctx önerisi ("kullan").
- Testler: `hf.test.ts` (gruplama, quant/params, gated, sahte fetch ile 429/çevrimdışı geri çekilme), `fit.test.ts`,
  `store.test.ts` (sahte native ile parçalı indirme, reconcile, silme sırası, kullanılmayanlar, başlık, geçmiş). 90 test yeşil;
  tsc temiz; lint'te yalnız eski `index.tsx:14` hatası (benden önce de vardı).
- Kalan: gerçek telefonda parçalı bir modelle (ör. 70B Q4 iki parça) uçtan uca denenmedi; kilitli depo için token girişi yok.

## 5.11 cloud: `claude/night-2` (gece planlayıcısı, sabah raporu)

`origin/claude/vibrant-cori-y4ox9r` (gerçek `LlamaWorker`) üstüne `release/local-2026-10-20` birleştirildi
(çakışma yok; `engine.ts`'teki `chatRemote` düzeltmesiyle 66 eski test yeşil kaldı). Eklenenler, hepsi `app/src/night/`:

- `conditions.ts`: saf `evaluate(facts, rules)` → her koşul kendi bayrağıyla (off, noproject, nopassport, window,
  charge, battery, hot, wifi), tek bir "neden". Okuyucular `expo-battery` (`getBatteryStateAsync`,
  `getBatteryLevelAsync`, dinleyiciler) ve `expo-network` (`getNetworkStateAsync`, `NetworkStateType.WIFI`;
  SDK 57'nin `bundledNativeModules` sürümü `~57.0.2` kuruldu). Sıcaklık bayrağı passport'un son ölçümünden
  (`thermal.status ≥ 3` ya da pil ≥ 42 °C); canlı sensör yok. "Bu gece çalış" anahtarı `night.want`.
- `scheduler.ts`: durum makinesi waiting → running → paused → running → done; bağımlılıklar dışarıdan verilir
  (sahte saatle test). Koşul bozulunca işçi durur, yaptığı **parça** (`night.segments`) saklanır, yığın
  (`queue.ts`, `night.queue`) kaldığı yerden sürer; uçuştaki birimler başa döner. Pencere kapanınca ya da yığın
  bitince gece biter: rapor yazılır, `contribution_end` toplamlarla gider, pencere anahtarı `night.done`'a
  yazılır (aynı pencerede ikinci başlangıç yok). Uygulama yeniden açılınca açık gece `night.start`'tan bulunur.
- Arka plan: SDK 57 `expo-background-task` WorkManager/BGTask ile kısa, en erken 15 dk'da bir iş çalıştırır;
  saatlerce model döndüremez. **Sınır açıkça:** gece uygulama açıkken çalışır; gerçek işçi ekranı kendisi açık
  tutar (yalnız çalışırken, simülasyon dokunmaz), kilitlenirse duraklar, açılınca yığından sürer. Çalışırken
  yapışkan (sticky) yerel bildirim (`notify.ts`, kanal `night`).
- `report.ts` + `app/night/report.tsx`: birim, doğru kontrol oranı, cihaz başına tok/s, çalışılan süre
  (duraklar hariç, parça sayısı), Wh = saat × ölçülen W (passport'ta `watts` yoksa 3 W varsayımı), önceki
  gecelerin ortalamasına fark ve "en iyi gece". Passport kartında "dün gece: … birim · tok/s · wh" satırı ve
  "bu gece çalış: açık/kapalı". Kart kwh'si eskisi gibi 4 W + 2 W/cihaz.
- Sunucu: demo sunucuda `night_report` (client id ile tekrar güvenli) ve `night_reports`; outbox işi
  `nightReport` yalnız DEMO'da gönderilir, canlı Supabase'de rpc yok → rapor telefonda "yalnız telefonda" kalır.
- Ayarlar: "yalnız şarjda" ve "pil en az %20/30/50/80" (yalnız telefonda, `night.charge`, `night.minBattery`);
  pencere saatleri eskisi gibi profilde.
- Testler: `conditions.test.ts` (her bayrak tek tek, sıra, pencere anahtarı), `scheduler.test.ts` (sahte
  saat: aç/kapa, dur/devam, kuru yığın, yeniden başlatma, "şimdi bitir"), `report.test.ts` (toplamlar, kuyruk
  devamı), `demo.test.ts` güncellendi. tsc, lint (0 hata; `index.tsx`'teki eski effect hatası giderildi) ve
  99 test yeşil. `docs.expo.dev` bu konteynerden erişilemedi; API'ler kurulu paketlerin tip dosyalarından okundu.
- Eksik: ölçülen W passport'a girmedi (3 W varsayılıyor); canlı sunucuda `night_report` rpc'si; typed routes
  dosyası `expo start` ile yenilenmeli (`/night/report` yeni).
## 5.11 sabaha karşı: cloud 2. dalga (kullanıcı: "hepsini cloud ile kodla")

Opus oturumu durduruldu; `release/local-2026-10-20` origin'e itildi (`9a2f91f`). Altı cloud oturumu, her biri kendi dalı:

| dal | iş | üstüne kurulduğu dal |
|---|---|---|
| `claude/integrate-night` | üç gece dalını release üstüne birleştir, testler, inceleme | release |
| `claude/audit-ui` | ayarlar → beyin denetimi sayfası, eş rozetleri, `llm/audit.ts` | quirky-einstein |
| `claude/node-master` | kula-node yönetici modu: `peers`, `chat --mode apart\|split`, planlayıcı portu | loving-dijkstra |
| `claude/models-library` | çok parçalı gguf, HF lisans/gated, disk, gerçek kv ile fit | release |
| `claude/gate-tls` | kapı protokol v2: TLS 1.3 + parmak izi, QR v3, vektörler, `docs/GATE.md` | quirky-einstein |
| `claude/night-2` | gece işçisi koşulları, planlayıcı, sabah raporu, ayarlar | vibrant-cori |

Hiçbiri release'e dokunmaz, PR açmaz. Cloud oturumları bitince haber vermez: sabah `git fetch origin && git branch -r`.
