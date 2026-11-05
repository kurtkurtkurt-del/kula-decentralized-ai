# durum

Proje nerede duruyor, 5.11.2026 akşamı (`kula-main`: bütün cloud dalları, temizlik, the brain sekmesi, ölçüm, paketleme).
Günü gününe kayıt [ILERLEME.md](ILERLEME.md)'de; bu sayfa onun özeti ve her büyük birleştirmeden
sonra güncellenir. Mimari [ARCHITECTURE.md](ARCHITECTURE.md), geçmiş [HISTORY.md](HISTORY.md).

## kısaca

kula, telefonları ve bilgisayarları tek bir yerel yapay zekâ kümesinde birleştirir: telefonda
gerçek bir model (llama.cpp b11157), QR ile katılım, üç mod (tek başına / ayrı / bölünmüş),
bilgisayar için kula-node, uzaktaki eş için aktarıcı, RPC'yi 127.0.0.1'de tutan kapı, imzalı
zincirli defter (beyin v0), gece telefonun bir proje için çalışması ve sabah raporu. Kod yazıldı
ve testleri geçiyor; **birleştirilmiş hâli henüz bir telefonda denenmedi**.

## bitenler

| alan | ne var | nerede |
|---|---|---|
| modeller sekmesi | sığana göre katalog, model bilgi sayfaları, Hugging Face araması (çok parçalı gguf, lisans / kilitli depo, süzgeçler, son aramalar), boş alan kontrolü, "kullanılmayanları sil" | `app/src/app/(tabs)/models.tsx`, `src/llm/catalog.ts`, `hf.ts`, `store.ts` |
| indirme | sürdürülebilir (Range, `.part`), sha256 tutmazsa dosya tutulmaz, parça parça, duraklat / devam, hız ve kalan süre | `ModelDownloader.kt`, `src/llm/store.ts` |
| sohbet | yerel ya da kümede, "en alta", uzun bas → kopyala, yeniden üret, tok/s | `src/app/chat.tsx`, `src/llm/engine.ts` |
| üç mod | tek başına, ayrı (her cihaz kendi kopyası, iş dağıtımı beklenen bitiş süresine göre), bölünmüş (ggml RPC, `--tensor-split`); mod sayfasında simülatörden tahminler | `src/llm/cluster.ts`, `src/llm/sim/`, `model/[id].tsx` |
| cihaz paylaş / ekle | QR v2 (secret) ve v3 (parmak izi + tek kullanımlık kod), kodla ekleme, yakındakileri bul (mDNS), eş rozetleri | `share.tsx`, `peers.tsx`, `src/llm/peers.ts` |
| kula-node | işçi (`share`), yönetici (`peers`, `chat --mode apart\|split`), defter, yerel pano (127.0.0.1, rastgele yol), Mac / Linux / Windows kurulum | `node/`, [NODE.md](NODE.md) |
| aktarıcı | NAT arkasındaki iki cihaz arasında kör WebSocket borusu; kula-node ve telefon uçları; yalnız ayrı mod | `node/relay/`, `Relay.kt`, [RELAY.md](RELAY.md) |
| kapı | v1 (paylaşılan secret, HMAC) ve v2 (TLS 1.3, cihaz sertifikaları, pin) aynı portta; Kotlin ve TS aynı vektörlerle | `Gate.kt`, `GateCert.kt`, `node/src/gate.ts`, [GATE.md](GATE.md) |
| beyin v0 denetçi | imzalı, hash zincirli defter, kontroller (replay, saat, iddia, model, sınırlar, sağlık), ayarlarda denetim sayfası, dışa aktarma | `audit/`, `node/src/audit/`, `src/app/audit.tsx`, [AUDIT.md](AUDIT.md) |
| gece | gerçek `LlamaWorker`, koşullar (şarj, wi-fi, pil, ısı, pencere), zamanlayıcı (bekle / çalış / duraklat / bitti), yığın kaldığı yerden, yapışkan bildirim, sabah raporu | `src/night/`, [NIGHT.md](NIGHT.md) |
| sunucuda gece raporu | yalnız sayılar (`night_reports`), proje özeti, idempotent; iki kenar fonksiyonu | `backend/sql/18_night.sql`, `backend/functions/`, [BACKEND.md](BACKEND.md) |
| planlayıcı simülatörü | ölçülen Mac / emülatör / S25+ sayılarına kalibre saf TS çekirdek; telefon ve kula-node aynı vektörlerle | `src/llm/sim/`, `node/src/sim.ts`, `tools/planner-vectors.json`, [PLANNER.md](PLANNER.md) |
| ux turu | adım çubuğu (ölç → indir → çalıştır → birleştir), hata sözlüğü, boş durumlar, erişilebilirlik, haptik, QR'da parlaklık | ILERLEME "ux cilası" |
| ci | `check.yml` (app, node 20/22, audit-jvm, kapı), `apk.yml` (elle / `v*`), `node-release.yml`, dependabot | `.github/workflows/` |
| güvenlik incelemesi | tehdit modeli, 20 bulgu, yüksek ve ortaların hepsi düzeltildi | [SECURITY.md](SECURITY.md) |
| belgeler | kılavuz (en / tr), mimari, kapı, denetim, gece, node, aktarıcı, planlayıcı, sunucular, bu sayfa | [README.md](README.md) |
| temizlik | afterhours sitesi kökten gitti (son hâli `9d5919f`), `web/` ve `docs/HISTORY.md`, README yeniden | kök, `web/`, `docs/` |
| the brain sekmesi | alt çubukta ortada; beyin'in bu telefonda ne yaptığı: şu an (model, mod, paylar), küme ve rozetler, kararlar defteri (planlayıcı ne seçti, kimi neden dışarıda bıraktı, ayrı modda hangi cihaz), denetim defteri ve zincir, gece | `(tabs)/brain.tsx`, `src/llm/brainlog.ts` |
| demo / misafir | giriş yoksa misafir ya da demo hesapla kendiliğinden girer; mesajlar, bağlan, pasaport, coop, çağrı "kayıt ol" göstermez; hesap açmak yalnız ayarlarda | `src/auth/AuthContext.tsx` |
| gece görseli | ilk açılıştaki konser fotoğrafının yerine kodla çizilmiş gece: şarjdaki telefonlar, aralarında ışık çizgileri | `src/components/NightNetwork.tsx` |
| ölçüm | telefonda "hızı ölç" sayfası, `kula-node bench`; ölçülen tok/s planlayıcıya giriyor (Mac M1, Qwen3 0.6B: 59 tok/s) | `src/bench/`, `node/src/bench.ts`, [BENCH.md](BENCH.md) |
| kula-node paketleri | tek dosya ikililer (Node SEA, 5 hedef), install.sh / install.ps1, .deb, brew / winget taslakları, ilk açılış menüsü, `info` | `node/tools/pack.mjs`, `packaging/`, [NODE.md](NODE.md) |

Ayrı dallarda yazıldı, `kula-main`'e **henüz alınmadı**:

| dal | ne |
|---|---|
| `claude/fuzz` | qr, hf adları, sse okuyucu, defter zinciri, gguf başlığı için fuzz / özellik testleri; Kotlin hello satırları; libFuzzer hedefi |
| `claude/ios-module` | llama.cpp çekirdeği `cpp/core`'a taşındı; iOS için Swift modül, ObjC++ köprü, kapı, indirici, bonjour, işçi, api, defter: **yazıldı, hiç derlenmedi** (Mac + Xcode gerekir) |

### birleştirirken bulunan hatalar (5.11 öğleden sonra)

- `Gate.kt`, `Relay.kt` Android'de derlenmiyordu (cloud'da SDK yoktu): `SSLSocketFactory.createSocket(socket,
  consumed, autoClose)` Android'de yok → okunan ilk bayt bir sarmalayıcı soketle geri konuyor; iki küçük
  Kotlin hatası. JVM testleri 37/37.
- Kapı bir bağlantıyı reddederken okunmamış girdi varken kapatıyordu: istemci "NO <neden>" yerine
  "connection reset" görüyordu. Artık önce yazma yönü kapanıyor, kısa bir boşaltma, sonra kapanış.
- Aktarıcı: işçi yerel kapıya bağlanmadan WebSocket akışını bağlamıyordu, ustanın ilk TLS kaydı
  kayboluyordu ("no hello"); aynı kodla ikinci bağlantı "busy" alıyordu (oturum kapanış yarışı).
- node testleri, başarısız testlerin açık bıraktığı sunucular yüzünden asılı kalıyordu.
- Zamana bağlı iki test (gece döngüsü, `/stop`) yüklü makinede kalıyordu; koşul bekleyen hâle geldi.

## cihazda doğrulanmayanlar

Emülatörde ve kullanıcının telefonunda (Galaxy S25+) 5.11 gecesi denenenler: native modül
yükleniyor, Qwen3 0.6B indirmesi öldür-aç sonrası Range ile sürüyor, S25+'ta Gemma 3 1B
çalışıyor, emülatör + Mac ile bölünmüş (27/29 katman Mac'te) ve ayrı mod (toplu test) çalışıyor.
O günden sonra eklenen her şey yalnız testlerde ve JVM'de çalıştı; **birleştirilmiş `kula-main`
için hiç apk derlenmedi**. Telefonda bakılacaklar:

1. `npm run apk`: `KulaLlamaModule.kt`, `WorkerService.kt`, `Gate.kt`, `Relay.kt`, `ApiServer.kt`,
   `ModelDownloader.kt` birleşimi ilk kez Android'de derlenecek.
2. Kapı v2 / QR v3: Conscrypt'te TLS 1.3 istemci sertifikası, pin, kodun yenilenmesi, eski v2 QR
   ile aynı portta v1.
3. Aktarıcı: telefon uçları (OkHttp WebSocket), "uzaktan paylaş", "kod ile ekle".
4. Gece: gerçek işçi şarjda başlıyor mu, şarj çekilince duruyor mu, sabah raporu, sunucuya rapor.
5. Denetim sayfası, eş rozetleri, defterin Mac'te `kula-node ledger --verify` ile doğrulanması.
6. Güvenlik düzeltmeleri: `FLAG_SECURE`, `/load` ad ve URL politikası, disk sınırı.
7. Yeni native paketler (`expo-haptics`, `expo-brightness`, `expo-network`, `expo-battery`,
   `expo-notifications`) yeni bir derleme ister.
8. Çok parçalı bir gguf'un uçtan uca indirilmesi; gerçek wi-fi'de bölünmüş modun yükleme hızı
   ve tok/s'si (simülatörün kalibrasyonu için).
9. Android 7 (API 24) telefonda işçi süreci (`B64.kt`).
10. `apk.yml` CI'da hiç koşmadı (önce `min` profili).

## kalanlar

- fuzz ve ios-module dallarının alınması; iki telefonla bir küme turu.
- kula-node yönetici olunca ayrı modda modeli kendi LAN adresinden sunuyor; güvenlik incelemesinin
  URL kuralı işçilerin özel / LAN adreslerinden indirmesini reddediyor. Telefon ustası Hugging Face
  adresi verdiği için etkilenmiyor; **bilgisayar ustası + ayrı mod şimdilik çalışmaz** (bkz. kararlar 8).
- Defter: süreç satır ortasında ölürse yarım son satır; `DeviceKey` kısa dosyayı sessizce ezer;
  anahtar Android KeyStore'a taşınmalı.
- `claim` kuralı RSS ile ölçüyor; cihazın gerçek boş belleğiyle ölçülmeli.
- kula-node: `--secret` `ps`'te görünür; `share` varsayılanı hâlâ `--tls`siz.
- Gece: ölçülen watt passport'a girmedi (3 W varsayılıyor); gece yalnız uygulama açıkken çalışır.
- `sendLedgerHead` yazıldı, çağıran yok (beyin v1).
- Uygulamada kalan pasaport adları (paket adı, şema, yasal sayfa bağlantıları): karar 7.
  afterhours kalıntıları (kart destesi metinleri, AfterhoursCard, konser fotoğrafı, PWA adı) temizlendi.

## kullanıcının kararını bekleyenler

1. **v1 kapının emekliliği.** Telefon işçisi eski ustalar için v1'i (düz metin) hâlâ kabul ediyor.
   Öneri: bir cihaz v3 ile eşleşince ona v1'i kapat; `kula-node share` varsayılanı `--tls` olsun.
2. **Aktarıcı nerede barınacak.** `node/relay/` Fly, Render ya da Docker ile hazır; genel bir
   adres yok. Kim işletecek, hangi alan adı (beyin'in barındırılan aktarıcısı mı?).
3. **apk imza anahtarı.** `KULA_KEYSTORE_*` secret'ları yoksa apk debug imzalı çıkar. Keystore'u
   kim üretecek, nerede saklanacak (repoda asla).
4. **Canlı Supabase projesi.** kula'nın kendi projesi var (`web/config.js`); `18_night.sql` ve
   kenar fonksiyonları canlıya girmedi (`npm run migrate -- --write`). Hesap / e-posta / yönlendirme
   ayarları [SERVERS.md](SERVERS.md)'de.
5. **beyin v1.** Defter başlıklarının toplanması, tahmin, internet üzerinden zamanlama:
   ne zaman ve hangi sırayla. Sınır [BEYIN.md](BEYIN.md)'de; şimdilik her şey açık kaynak.
6. **Lisans dosyası.** Kökte LICENSE yok; `app/LICENSE` Expo şablonunun (650 Industries) MIT
   metni. kula için kimin adıyla bir MIT LICENSE konacak.
7. **Yasal sayfalar ve paket adı.** Uygulama şartları, gizliliği, e-posta onayını ve davetleri
   `kurtkurtkurt-del.github.io/pasaport/` üstünden açıyor (başka bir repo). kula'nın kendi
   sayfaları nerede olacak (`web/legacy/`'deki afterhours metinleri başlangıç olabilir);
   `app.pasaport.android` / `pasaport://` adları değişecek mi (değişirse kurulu uygulamalar ve
   giriş yönlendirmesi etkilenir).
8. **İşçinin indirme kuralı.** Öneri: işçi, ustanın kendi adresinden (kapıya bağlanan IP) gelen
   özel adresli bir URL'yi kabul etsin; başka özel adresleri reddetmeye devam etsin. Böylece
   bilgisayar ustası modelini LAN'dan dağıtabilir, SSRF koruması kalır.
