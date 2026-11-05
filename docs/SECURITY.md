# güvenlik incelemesi — küme yüzeyi (5.11.2026)

`claude/security-review` dalı: `origin/claude/gate-tls` + `origin/claude/integrate-night` üstüne,
bütün küme yüzeyi saldırgan gözüyle. Protokol belgesi `GATE.md`; bu belge tehdit modelini, bulguları,
yapılan düzeltmeleri ve kalan riskleri tutar. Testler: JVM `GuardTest`, `GateSecurityTest`
(`audit-jvm/`'de `gradle test --max-workers=1`), node `test/security.test.ts`, jest
`app/src/__tests__/security.test.ts`.

## tehdit modeli

Varlıklar: işçinin belleği ve işlemcisi (ggml RPC uzaktan bellek yazdırır), işçinin diski,
sohbet içeriği (telefon–telefon arası geçen token'lar), cihaz kimliği (sertifika anahtarı,
`kula_device_key`), küme gizli anahtarı (v1) ve eşleşme kodu (v2).

| saldırgan | nerede | ne yapabilir |
|---|---|---|
| **A1 aynı Wi-Fi'de yabancı** | kafe, yurt, iş ağı | kapı portuna bağlanır, mDNS'i okur, trafiği dinler/değiştirir (ARP), QR'ı göremez |
| **A2 QR'ı görmüş yabancı** | ekran görüntüsü, omuz üstü, fotoğraf | A1 + o anki secret (v2 QR) ya da `fp`+`pin` (v3 QR) |
| **A3 ele geçmiş eş** | eşleşmiş usta telefonu çalınmış/kötücül | kapıdan geçer; işçiye model indirtir, RPC ile işçi belleğini yazar |
| **A4 aynı telefondaki başka uygulama** | 127.0.0.1 | tünel ve RPC sunucusu loopback'te; Android UID'ler arası loopback izolasyonu yok |
| **A5 model sunucusu** | HF ya da `url`'deki host | yönlendirme, uzun gövde, yanlış boyut |

Tasarım sınırı: **eşleşmiş bir usta işçinin işlemci ve belleğine güvenilir erişim alır** (ggml RPC
budur). Bu belge A3'ü "işçiyi yalnız modele kullanır, telefonun geri kalanına geçemez" sınırına
çeker; tamamen engellemez.

## bulgular

Ciddiyet: **Y** yüksek, **O** orta, **D** düşük. Durum: ✅ düzeltildi, ⚠️ açık (karar/cihaz işi), ℹ️ not.

| # | yer | bulgu | cid. | yeniden üretme | düzeltme + test | durum |
|---|---|---|---|---|---|---|
| 1 | `app/src/llm/peers.ts` | Telefonun işçi secret'ı `newId()` (Math.random, xorshift128+) karakter kodlarının son nibble'ından türetiliyordu: CSPRNG değil, bir kaç çıktıdan durum geri çıkarılabilir, dağılım eğik. v1'in tek anahtarı buydu. | **Y** | `randomHex` eski hâli: `newId()` → `charCodeAt().toString(16).slice(-1)` | `app/src/llm/random.ts`: `expo-crypto.getRandomBytes` (SecureRandom). jest `security.test.ts`: 64 hex, tekrarsız, her bayt korunur. | ✅ |
| 2 | `ApiServer.kt /load` | `name` doğrudan `File(modelsDir, name)`: `../../shared_prefs/x` ile uygulama dizininde keyfi dosyaya yazma; checksum uyuşmazsa `dest.delete()` → **keyfi dosya silme** (`kula_device_key`, `gate_key`, `paired`…). node tarafı zaten `safeName` yapıyordu. | **Y** | `POST /load {name:"../kula_device_key", sha256:"00..", url:…}` | `Guard.kt ModelName.safe`: son segment, `[A-Za-z0-9._-]`, `.part` yasak → `400 bad name`. `GuardTest.modelNamesStayInsideModels`. | ✅ |
| 3 | `ApiServer.kt`, `ModelDownloader.kt` | `url` sınırsız: işçi LAN içine istek atar (SSRF, `http://192.168.1.1/…`, `169.254.169.254`), `HttpURLConnection` yönlendirmeleri kendi başına izler (dış host → iç host 302). | **O** | `/load {url:"http://192.168.1.1/admin"}` | `UrlPolicy.problem`: yalnız http(s), kimlik bilgisi yok, loopback/link-local/özel/CGNAT/multicast literal ve `.local`/`localhost` yasak; indiricide her atlamada politika + **çözümlenen adres** kontrolü, en çok 5 yönlendirme (`open()`), politika hatası yeniden denenmez. node `policy.ts` + `download.ts` (`lookup` kancası). `GuardTest.urlPolicy…`, node `security.test.ts` (yönlendirme LAN'a, döngü). | ✅ |
| 4 | `ModelDownloader.kt`, node `download.ts` | Disk doldurma: `size` yalnız ilerleme içindi; sunucu daha büyük gövde ya da sonsuz chunked akış yollayabilir. Kotlin 64 MB pay bırakıyordu, node hiç bakmıyordu. | **O** | `/load {size:1000}` → sunucu 5 GB | Content-Length `size`'ı %2+1 KiB'den fazla aşarsa `size mismatch`; akışta `got > size` → kesilir; bilinmeyen uzunlukta her 32 MiB'de boş alan; diskte en az **512 MB** kalır. `.part` silinmez (devam edilebilir) ama hedef dosya hiç oluşmaz. node `security.test.ts` `/endless`, `/big`. | ✅ |
| 5 | `ApiServer.kt` | `Content-Length` sınırsız → `CharArray(length)` ile OOM; başlık sayısı/uzunluğu sınırsız (`BufferedReader.readLine`). node 1 MiB sınırı vardı. | **O** | `Content-Length: 2000000000` | `HttpLimits`: satır 8 KiB, 64 başlık, gövde 1 MiB → 413/431; bozuk JSON 400. `GuardTest.httpLimits…`. | ✅ |
| 6 | `Gate.kt admit` | "tek usta" kuralı check-then-set: `currentPeer` okunup sonra yazılıyordu; iki farklı IP aynı anda gelince ikisi de geçerdi (node'da yuva bağlantıdan önce alınıyordu). | **O** | iki IP'den eşzamanlı `rpc` el sıkışması | `RpcSlot` (`@Synchronized take/release`), yerel bağlantıdan **önce** alınır, `target down`'da bırakılır. `GuardTest.theRpcSlot…` (32 adres aynı anda → 1). | ✅ |
| 7 | `Gate.kt`, `gate.ts` | Yarım açık bağlantı seli: her bağlantı bir iş parçacığı/promise + 5 s; sınır yok → thread/bellek tükenmesi, meşru usta giremez. | **O** | 500 TCP bağlantısı aç, hello yollama | `MAX_HANDSHAKES = 32`: fazlası **hello beklenmeden** `NO overloaded` alır ve kapanır; yuva OK yazılınca ya da soket kapanınca geri verilir. `GateSecurityTest.pastMaxHandshakes…`, node `security.test.ts`. | ✅ |
| 8 | `share.ts`, `Gate.kt` | **Downgrade**: v2 (TLS) konuşan sunucu aynı portta v1'i de kabul ediyordu. PC'de `--tls` ile QR'da secret yok ama rastgele bir secret yine de v1'i canlı tutuyordu (gereksiz yüzey, HMAC tahmin denemeleri). Telefonda v3 QR öncesi v2 QR secret gösteriyor. | **O** | `--tls` sunucuya `KULA1 …` | `secret: null` → `NO no v1` (Kotlin ve node). `kula-node share --tls` artık `--secret` verilmedikçe v1 kapalı. Telefon işçisi eski ustalar için v1'i **açık tutuyor** (secret artık güçlü; bkz. kalan riskler). `GateSecurityTest.aServerWithoutASecret…`, node testi. | ✅ / ⚠️ telefon |
| 9 | `Gate.kt TlsServer`, `share.ts` | **TOFU zehirleme**: eşleşme kodu kullanılana dek süresiz geçerliydi. Paylaşım ekranı açık kaldığı sürece QR'ı fotoğraflayan herkes (A2) günler sonra bile eşleşir. | **O** | QR fotoğrafı, 1 gün sonra `probe --fp --pin` | `PIN_TTL_MS = 10 dk`: süresi geçen kod `NO pin expired` ve anında yenilenir; işçi durum döngüsü de süresi dolan kodu kimse denemese bile yeniler, QR 2 s'de tazelenir. Eşleşmiş ustayı etkilemez. `GateSecurityTest.aPairingCodePastItsTtl…`, node testi. | ✅ |
| 10 | `app/src/app/share.tsx` | QR (secret/pin) ekranda; ekran görüntüsü, ekran kaydı, "son uygulamalar" küçük resmi. | **D** | ekran görüntüsü al | `secureScreen(true)` = `FLAG_SECURE` paylaşım ekranında. Jest'te doğrulanamaz; cihazda bakılacak. | ✅ (cihazda doğrula) |
| 11 | `kula_llama.cpp` | JNI `endpoints` dizisi doğrulanmıyordu; Kotlin hep `127.0.0.1:port` veriyor ama JS/Kotlin hatasıyla LAN adresi gelirse RPC istemcisi kimliksiz dışarı bağlanırdı. `nServe` de verilen adrese bağlanıyordu. | **D** | `loadModel(endpoints=["192.168.1.5:50052"])` | `isLoopbackEndpoint`: her uç `127.0.0.1:<1-65535>` değilse `cluster: worker endpoint … is not on 127.0.0.1`; `nServe` loopback dışını reddeder. Kotlin ikizi `Endpoints.isLoopback` (`GuardTest`). | ✅ |
| 12 | `ApiServer.kt /load` | `sha256` isteğe bağlıydı: indirme doğrulanmadan yüklenebilirdi (node zorunlu tutuyordu). | **D** | `/load {url, name}` sha'sız | İndirme gerekiyorsa `400 sha256 is needed to download`; verilirse 64 hex olmalı; diskte olan dosya için hâlâ isteğe bağlı (yerel dosyaya güven). `ctx` 256..1M. | ✅ |
| 13 | `AuditorGateTest` / `Gate.refuse` | integrate-night'ın "önce cevap sonra kayıt" sırası ret kaydını istemcinin gördüğü sıranın dışına düşürebiliyordu (test de yakaladı). | **D** | ardışık ret + bağlantı | `audit{}` (runCatching) **NO'dan önce**; defter yazılamazsa NO yine gider. | ✅ |
| 14 | `Gate.kt`/`gate.ts` zamanlama | HMAC/pin/fp karşılaştırmaları sabit zamanlı (`constantEquals`, `timingSafeEqual`). Uzunluk farkı sızar ama hex uzunluğu sabit. `paired`/`pin` durumu açık metin ama gizli değil. Nonce 16 bayt `SecureRandom`/`randomBytes`. Tekrar: v1'de sunucu nonce'u taze olduğu için kanıt tekrarı zaten imkânsız; hello tekrarı denetçi halkasıyla ayrıca reddediliyor (telefon işçisi her zaman denetçili, node `admit` her zaman bağlı), v2 denetçisiz de kontrol ediyor. | ℹ️ | — | değişiklik yok | ℹ️ |
| 15 | NSD TXT | `id` (kalıcı UUID), `ram`, `bw`, `name` (Build.MODEL), `kind`, `v`. Gizli yok. Kalıcı `id` ağlar arası takip imkânı. | **D** | `dns-sd -B _kula._tcp` | değişiklik yok; `id` zaten QR'da; isteğe bağlı ağ başına türetilmiş id ileride. | ⚠️ |
| 16 | release `network-security-config` | Cleartext yalnız `127.0.0.1`/`localhost`; release manifest'te bağlı. Ham soketler (kapı v1) NSC'den etkilenmez — v1'in düz metin olması tasarım gereği (HMAC kimlik, şifreleme yok). | ℹ️ | — | değişiklik yok | ℹ️ |
| 17 | `WorkerService` | `exported=false`; secret Intent extra'sı aynı uygulamadan; durdurma eylemi `PendingIntent.getService` + `FLAG_IMMUTABLE`, kilit ekranından durdurulabilir (bilgi sızmaz). Durum dosyası (`pin`, `fp`) uygulama özel dizininde. | ℹ️ | — | değişiklik yok | ℹ️ |
| 18 | `.part` yarışları | Aynı dosya adına iki indirici (ApiServer `load` + uygulamanın kendi indirmesi) aynı `.part`'a yazabilir; `active` haritası id başına. Sonuç: bozuk dosya → sha uyuşmaz → silinir (veri kaybı yok, zaman kaybı). | **D** | aynı anda iki taraftan indir | değişiklik yok | ⚠️ |
| 19 | JNI `ggml_backend_rpc_add_server` | Uç cevap vermezse süreç **abort** olur (uygulama çöker). Kotlin kapı probe'u yapıyor ama probe ile add_server arasında işçi düşerse/`busy` derse abort. | **D** | probe sonrası işçiyi kapat | değişiklik yok; llama.cpp tarafında abort yerine hata dönüşü gerekir (upstream) | ⚠️ |
| 20 | kv-store | `llm.peers` (secret, fp, pin) ve `llm.share` (telefonun kendi secret'ı) expo-sqlite kv-store'da, şifresiz, uygulama özel dizininde. `allowBackup` varsayılanı → Android yedekleri bu veriyi taşıyabilir. Log'larda secret yok (`grep` ile doğrulandı: `console.*`, `Log.*` yalnız fp'nin ilk 16 hex'i). | **D** | yedek al | değişiklik yok; `secureStorage.ts` (Keystore) zaten var, `llm.share.secret` oraya taşınabilir; `android:allowBackup=false` ya da backup rules | ⚠️ |

## protokol değişiklikleri (uyum)

- Yeni ret nedenleri: `overloaded`, `no v1`, `pin expired` (`GATE.md` tablosu). İstemciler bilinmeyen
  nedeni zaten metin olarak gösterir; davranış değişmez.
- `Gate.Server(secret: String?)`, `startGateServer({ secret: string | null })`: `null` = v1 kapalı.
- `TlsServer.pinExpiresAt` (iki tarafta); `null` = süresiz (testler, dev-gate).
- `/load`: `name` dosya adına indirgenir, `url` politikası, `sha256` indirme için zorunlu, `size`
  üst sınır. Uygulama zaten `model.file`, `model.sha256`, `model.size` yolluyor; HF'den sha'sız
  bir model ayrı modda yüklenemez (node'da zaten öyleydi).
- `dev-gate.mjs` (Mac test kapısı) değişmedi: pin süresi yok, v1 her zaman açık; yalnız test içindir.

## kalan riskler

### telefon ↔ telefon

- **v1 açık (bulgu 8).** Telefon işçisi `secret` ile v1'i kabul etmeye devam ediyor ki eski
  ustaların v2 QR'ı çalışsın. v1 düz metindir: aynı Wi-Fi'deki A1 token akışını ve RPC
  tensörlerini **okuyabilir** (şifreleme yok), A2 (v2 QR'ı görmüş) usta olur. Karar: bir kez v3
  ile eşleşmiş işçi v1'i kapatsın mı? (`paired.size() > 0 → secret = null`). Eski usta kaybı
  pahasına kapatmak öneriliyor; tek satır (`WorkerService`), bu dalda yapılmadı.
- **A4 loopback.** Usta telefonda tünel `127.0.0.1:<port>`'ta, işçi telefonda ggml RPC
  `127.0.0.1:<rpcPort>`'ta: aynı telefondaki her uygulama bağlanabilir. Usta tarafında bu,
  işçinin RPC'sine (bellek yazma) açık kapı demektir. llama.cpp RPC'si Unix soketi bilmediği
  için ucuz çözüm yok; "sadece kök/debug'sız cihaz" varsayımıyla kalıyor.
- **A3 ele geçmiş usta.** Eşleşmiş usta işçiye istediği GGUF'u indirtir ve yükletir (gguf
  ayrıştırıcı güvenilmeyen girdiyle), RPC ile işçi sürecinin belleğini yazar. İşçi ayrı süreçte
  (`:worker`), uygulama verisine aynı UID'den erişebilir. Sınır: ayrı süreç + bu belgenin
  dosya/URL/disk kuralları. Daha ötesi: işçi için `isolatedProcess` (ggml'nin dosya/ağ ihtiyacı
  yüzünden zor) ya da `paired` listesinden **unutma** arayüzü (`Paired.forget` var, UI yok).
- **Eşleşme anı.** 10 dakikalık pencere içinde QR'ı gören (A2) hâlâ eşleşebilir; eşleşen `fp`
  deftere ve `paired` dosyasına yazılır, usta ekranı "eşleşti" demeden önce doğrulamaz. Pin 64 bit,
  kaba kuvvet yok.
- **Yedekler (20).** `allowBackup` ile secret ve `paired` bulut yedeğine gidebilir.

### telefon ↔ pc

- `kula-node share` **`--tls`siz** varsayılan hâlâ v1: QR'da secret, trafik düz metin. `--tls`
  varsayılan yapılmalı (bir bayrak), bu dalda değiştirilmedi.
- PC tarafı `paired` dosyası `~/.kula/` altında düz metin; PC'de başka kullanıcı/işlem okuyabilir.
  Sertifika anahtarı da öyle (`gate_key`); KeyStore karşılığı yok.
- `ggml-rpc-server` PC'de `127.0.0.1`'e bağlı ama PC'deki her süreç bağlanabilir (A4'ün PC hâli).
- `llama-server` çocuk süreci `--no-webui` ile 127.0.0.1'de; aynı A4.
- `/load` PC'yi kamu internetine HTTP istemcisi yapar (politikayla yalnız kamu adresleri);
  indirilen dosya sha ile doğrulanır, yine de usta PC'ye istediği GGUF'u yükletebilir (A3).

### ortak

- Sertifika 10 yıl, iptal yok; cihaz kaybında karşı taraf `paired`'den elle silinmeli (`forget`
  var, arayüz yok).
- Denetçi defteri (`ledger.jsonl`) yerel; sahte işçi kendi defterini yazar. Bu belge defteri
  kanıt olarak saymaz.
