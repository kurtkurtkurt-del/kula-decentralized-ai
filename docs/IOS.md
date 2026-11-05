# kula-llama iOS

`app/modules/kula-llama` artık iki platform: Android (Kotlin + JNI) ve iOS (Swift + ObjC++ köprü + Metal).
JS yüzeyi (`app/src/llm/native.ts`) aynı; `requireOptionalNativeModule('KulaLlama')` iki telefonda da aranır.
Bu belge 5.11.2026 gecesi Mac'siz bir cloud oturumunda yazıldı: **iOS kodu derlenmedi, cihazda denenmedi.**
Ortak C++ çekirdek ve JNI Linux'ta `clang++ -fsyntax-only` ile denetlendi; Swift/ObjC++ yalnızca elle okundu.

## durum

| parça | dosya | durum |
|---|---|---|
| ortak C++ çekirdek | `cpp/core/kula_core.{h,cpp}` | JNI'den çıkarıldı; Android (`KULA_BACKEND_DL`) ve iOS (`KULA_USE_GPU`) yapılandırmalarında sözdizimi geçti |
| Android JNI | `android/src/main/cpp/kula_llama.cpp` | çekirdeğe bağlandı; JNI imzaları, dönüşler ve istisnalar aynı (`Native.kt` değişmedi) |
| ObjC++ köprü | `ios/KulaLlamaBridge.{h,mm}` | çekirdek → NSString/NSArray/NSError; Swift bunu görür |
| Expo modülü | `ios/KulaLlamaModule.swift` | Kotlin modülüyle işlev işlev aynı ad ve argümanlar, aynı olaylar |
| kapı | `ios/Gate.swift` + `ios/Sockets.swift` | BSD soket, aynı v1/v1.1 protokolü, HMAC CryptoKit; `tools/gate-vectors.json` ile aynı hesap |
| indirici | `ios/ModelDownloader.swift` | URLSession data task + Range devam + `.part` + sha256; arka plan süresi `beginBackgroundTask` (~30 s) |
| keşif | `ios/Discovery.swift` | `NetServiceBrowser`, `_kula._tcp.`, tek tek çözümleme, TXT aynı anahtarlar |
| işçi | `ios/Worker.swift` | süreç içi; kapı + ApiServer + Bonjour ilanı + `serve` iş parçacığı; durum bellekte |
| api | `ios/ApiServer.swift` | `127.0.0.1`, aynı dört yol, aynı SSE satırları (`data: {...}\n\n`, Connection: close) |
| denetçi | `ios/Audit/*.swift` | Checks/ReplayRing/Ledger/SoftwareKey/Auditor; Ed25519 CryptoKit; aynı dosya biçimleri |
| derleme | `KulaLlama.podspec` (modül kökünde) + `tools/ios-llama.sh` | `prepare_command` llama.cpp b11157'yi Metal + RPC ile xcframework yapar |
| app.json | `ios.infoPlist` | `NSLocalNetworkUsageDescription`, `NSBonjourServices: [_kula._tcp]`, `NSCameraUsageDescription` |

## derleme adımları (Mac)

1. `brew install cmake` (≥ 3.22), Xcode 16+, Apple silicon.
2. `cd app && npx expo prebuild --platform ios --clean` → `pod install` sırasında `KulaLlama` pod'unun
   `prepare_command`'ı `tools/ios-llama.sh`'ı çalıştırır:
   - `node tools/llama-src.mjs` (b11157 + yamalar; Android ile aynı ağaç, `android/src/main/cpp/llama.cpp`)
   - `cmake -G Xcode` ile iki dilim: `iphoneos arm64`, `iphonesimulator arm64` (`KULA_IOS_SIM=0` ile yalnız cihaz)
   - bayraklar: `GGML_METAL=ON GGML_METAL_EMBED_LIBRARY=ON GGML_RPC=ON GGML_BLAS=OFF BUILD_SHARED_LIBS=OFF`, mtmd/test/tools/server kapalı, min iOS 16.4
   - statik kütüphaneler `libtool -static` ile tek `.a`, sonra `xcodebuild -create-xcframework` → `ios/llama/kula_llama_cpp.xcframework` (gitignored, damga `ios/llama/.kula-tag`)
   - ilk sefer ~10 dk; damga eşleşince atlanır. Elle: `cd app/modules/kula-llama && sh tools/ios-llama.sh`
3. `npx expo run:ios --device` (geliştirme derlemesi; Expo Go'da modül yok, ekranlar "development build kur" der).
4. EAS: `eas build --profile development --platform ios`. EAS imajında cmake yoksa `eas.json`'a
   `"build": {"development": {"ios": {"image": "latest"}}}` + bir `eas-build-pre-install` hook'u ile `brew install cmake`.
   Alternatif: xcframework'ü bir kez Mac'te üretip EAS'a göndermeden önce `ios/llama/`'yı gitignore'dan çıkarıp commit'lemek (≈60–80 MB).

Podspec notları: podspec modül kökünde çünkü CocoaPods `..` ile `cpp/core`'a çıkamaz. `KULA_USE_GPU=1` ile
çekirdek Metal cihazını kullanır (küme dışı: bütün katmanlar Metal; kümede: Metal, bölüştürmede yerel pay olarak
bir cihaz daha; `output/token_embd` yerelde kalır). İşçi RPC üzerinden **CPU** aygıtını sunar (Android'le aynı,
ustanın bölüşümü işçinin GPU bellek raporuna bağlı kalmasın diye).

## Android'den farklar (bilerek)

- **İşçi ön planda.** iOS'ta foreground service yok. `startWorker` ekranı açık tutar (`isIdleTimerDisabled`),
  uygulama arka plana geçince birkaç saniyede askıya alınır; usta bağlantısı kopar. Paylaşım ekranı bunu yazar
  (`share.iosForeground`). Audio/location arka plan modları hile sayılır; kullanılmadı.
- **İşçi süreç içi.** `ggml_backend_rpc_start_server` durdurulamaz; `stopWorker` kapıyı, api'yi ve Bonjour ilanını
  kapatır, RPC iş parçacığı uygulama ölene kadar `127.0.0.1`'de kalır (dışarıdan erişilemez). Sonraki `startWorker`
  aynı portu yeniden kullanır. Ayrı modda ustanın yüklediği model, telefonun kendi yüklü modelinin yerine geçer
  (tek llama.cpp durumu). Kotlin'deki `kula_worker_status.json` yok; durum `Worker.shared`'de.
- **İndirme arka planı.** Data task + Range, `.part` boyutundan devam. Arka planda ~30 s sonra durur, sonraki
  açılışta `download` yeniden çağrılınca kaldığı yerden sürer. Gerçek arka plan indirme için `URLSessionConfiguration.background`
  + download task + `resumeData` + AppDelegate `handleEventsForBackgroundURLSession` gerekir; sha256/`.part` sözleşmesi
  bozulacağı için bu turda yapılmadı.
- **Pil.** `requestBatteryUnrestricted` iOS'ta `true` döner; `batteryUnrestricted: true`. `throttled` = termal durum
  `serious/critical`. Pil sıcaklığı yok (`batteryC: 0`); yüzde `UIDevice`'tan.
- **Çekirdek sayısı.** `hw.perflevel0.logicalcpu` (performans çekirdekleri), 2…6 arası.
- **Defter imzası.** CryptoKit Ed25519 imzaları rastgeleleştirilmiş: aynı satır için Kotlin/Node'dan farklı bayt,
  ama her yerde doğrulanır. iOS'ta vektör testi `verify` ile yapılmalı, bayt karşılaştırmasıyla değil.
- **Dosya yerleri.** `Application Support/kula-llama/{models,beyin/ledger.jsonl,kula_device_key,kula_worker_id,rpc_cache}`;
  modeller ve anahtar iCloud yedeğinden dışlandı.
- **Yerel ağ izni.** İlk `discover`/`startWorker`/tünelde iOS "yerel ağ" izni sorar; reddedilirse Bonjour ve LAN
  bağlantıları sessizce başarısız olur. Ayarlar > kula > Yerel Ağ.

## bilinen riskler

- **Bellek (jetsam).** iOS uygulama başına ~RAM'in %50–60'ını verir (`os_proc_available_memory`); 8 GB iPhone'da
  ~3.5–4 GB. Q4 3B model + 4k bağlam sınırda; 7B sığmaz. `info.ramFreeMb` bunu döndürür, fit hesabı ona göre.
  `com.apple.developer.kernel.increased-memory-limit` yetkisi (iPhone 15 Pro+) sınırı yükseltir; app.json'a
  `ios.entitlements` ile eklenebilir, App Store incelemesi gerekçe ister.
- **TestFlight/App Store indirme boyutu.** Modeller uygulama içinde değil, çalışırken iniyor (Android'le aynı);
  xcframework ~40 MB cihaz dilimi ekler. 200 MB hücresel sınırı uygulamaya değil modele uygulanmaz ama
  `allowsCellularAccess` varsayılan açık: büyük modeller hücreselde iner. Bir ayar düşünülebilir.
- **Metal gömülü kütüphane.** `GGML_METAL_EMBED_LIBRARY` `.metal` kaynağını derleme anında gömer; App Store
  ikilisinde çalışma zamanı derlemesi yapılır (ilk yüklemede +1–2 s). Sorun çıkarsa `default.metallib` yolu
  (`GGML_METAL_EMBED_LIBRARY=OFF` + resource bundle) denenir.
- **Simülatör.** Yalnız arm64 (Apple silicon Mac). Metal simülatörde çalışır ama yavaştır; RPC kümesi simülatörden
  Mac'teki `dev-gate`'e bağlanabilir.
- **Derlenmemiş Swift.** Tipik hata adayları: Expo DSL kapanışlarının tür çıkarımı (`[String: Any?]` dönüşleri),
  `NetService` kullanımdan kaldırma uyarıları (iOS 16.4'te hâlâ var), `withUnsafePointer` sockaddr dönüşümleri,
  ObjC köprünün `NSError**` → `throws` içe aktarımı (`generate` NSInteger döner; hata yalnız `error` doluysa).
- **Uyuyan telefon.** Ekran kapanırsa işçi durur; Android'deki gece modu iOS'ta ancak şarjda + ekran açıkken.

## sonraki Mac oturumu: kontrol listesi

1. `cd app && npm ci && npx expo prebuild -p ios --clean` → `pod install` çıktısında `KulaLlama` prepare_command'ının
   xcframework'ü ürettiğini gör (`app/modules/kula-llama/ios/llama/kula_llama_cpp.xcframework`).
2. Xcode'da `KulaLlama` hedefini derle; Swift hatalarını dosya dosya kapat (yukarıdaki adaylar). `kula_core.cpp`
   `KULA_USE_GPU=1` ile derlenmeli; `llama.h` yolu `HEADER_SEARCH_PATHS`'ten gelir.
3. Cihazda: modeller sekmesi → katalogdan küçük model (Qwen 0.5B/1.5B Q4) indir → `sha256` → yükle → sohbet;
   `onToken`/`onDone` akıyor mu, `tps` makul mu (Metal: 1.5B Q4 ~30 tok/s beklenir).
4. Kapı: Mac'te `node tools/dev-gate.mjs --secret <hex>`; telefonda eşleri sayfasından QR ile ekle, `probePeer`
   `null` dönmeli; bölüştürmeli yüklemede `split` listesinde `RPC0[127.0.0.1:…]` görünmeli.
5. İşçi: paylaşım ekranı → başlat → Mac'te `dns-sd -B _kula._tcp` ilanı görsün; ikinci telefon/Mac usta olarak
   bağlansın; `workerStatus.peer` dolsun; `gateLedger(20)` satırları gelsin; `node/`'daki doğrulayıcı ile
   defteri doğrula (imza baytları farklı ama geçerli).
6. Ayrı mod: usta `apiTunnel` → `GET /status`, `POST /load`, `POST /chat` SSE şekilleri Kotlin ile aynı mı
   (`node/` uyum testleri).
7. Arka plan: ekranı kapat, ustanın bağlantısının koptuğunu ve ekran açılınca `startWorker`'ın temiz başladığını gör.
8. Bellek: Xcode memory gauge ile 3B Q4 yüklemesi; jetsam olursa `ramFreeMb` eşiğini `fit.ts`'de düşür.
9. Android regresyon: `./gradlew :kula-llama:test` (audit-jvm) + bir apk; JNI çekirdek taşındı, davranış aynı
   olmalı; küme turu (split + apart) bir kez daha.
10. Her şey geçince `docs/ILERLEME.md`'ye iOS bölümünü güncelle ve bu dosyadaki "derlenmedi" uyarısını kaldır.
