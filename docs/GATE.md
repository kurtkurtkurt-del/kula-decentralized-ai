# kapı (gate) — cihazlar arası tek açık port

Bir kula cihazı ağa tek port açar: kapı (varsayılan 50551). ggml'in RPC sunucusu kimlik
doğrulamasızdır ve istemcinin belleğe yazmasına izin verir; bu yüzden **her zaman 127.0.0.1'de**
dinler, işçi HTTP API'si de öyle. Kapı önlerinde durur, el sıkışmadan sonra bağlantıyı
düz boru olarak ilgili yerel porta aktarır. Kanallar: `rpc` (→ ggml-rpc-server), `api`
(→ işçi HTTP, `ApiServer.kt` / `node/src/api.ts`).

Kodlar: Kotlin `app/modules/kula-llama/android/src/main/java/expo/modules/kulallama/Gate.kt`
(+ `GateCert.kt`), TypeScript `node/src/gate.ts` (+ `node/src/tls.ts`), Mac test kapısı
`app/modules/kula-llama/tools/dev-gate.mjs`. Ortak vektörler
`app/modules/kula-llama/tools/gate-vectors.json` (`node/test/gate-vectors.json` birebir kopyası);
JVM testleri `GateTest.kt`, `GateTlsTest.kt`; node testleri `gate.test.ts`, `gate-tls.test.ts`.

İki protokol aynı portta yaşar. Sunucu **ilk bayta** bakar: TLS ClientHello kaydı `0x16` ile
başlar → v2; `K` (`KULA1`) → v1 düz metin. Böylece eski telefonlar ve `--tls`siz dev-gate
istemcileri hiçbir şey değişmeden çalışır; yeni bir usta, v2 QR'lı eski bir işçiye v1 ile bağlanır.

## protokol v1 — paylaşılan gizli anahtar (QR v2)

Satırlar `\n` ile biter, sonra düz boru. Gizli anahtar (`secret`) eşleşmede üretilir ve
yalnız QR'da taşınır.

```
C → S   KULA1 <kanal> <nonce_c> [<unix_ms>]   kanal: rpc | api; nonce: 16 rastgele bayt, 32 küçük harf hex
S → C   <nonce_s>                             aynı biçim
C → S   <hmac_c>                              HMAC-SHA256(secret utf8, "nonce_c|nonce_s|kanal") hex
S → C   OK <hmac_s>                           HMAC-SHA256(secret utf8, "nonce_s|nonce_c|kanal")
   ya da NO <neden>                           sonra kapanır
```

Dördüncü alan (istemci saati, v1.1) isteğe bağlıdır; denetçi (beyin/check) varsa tekrar nonce
ve ±2 dakikadan fazla sapan saat reddedilir. Üç alanlı hello hâlâ kabul edilir (dev-gate, eski apk).

QR v2: `{"k":"kula-peer","v":2,"id","name","host","port","secret","kind","ram","bw","passport"}`

**Zayıflığı:** istemler ve cevaplar (ayrı mod, `api` kanalı) ağda düz metin gider; secret'ı
QR'dan okuyan herkes kalıcı erişim kazanır; cihazın kimliği yoktur.

## protokol v2 — TLS 1.3, cihaz sertifikaları, tek kullanımlık eşleşme kodu (QR v3)

### kimlik

Her cihazın kalıcı bir anahtar çifti vardır (`audit/DeviceKey`: Ed25519, yoksa ECDSA P-256; kimlik =
açık anahtarın SHA-256'sının ilk 16 baytı, 32 hex). Kapı için **P-256 anahtar + öz imzalı X.509
sertifika**:

- Cihaz anahtarı P-256 ise TLS anahtarı odur. Ed25519 ise yanında ayrı bir P-256 "kapı anahtarı"
  üretilir (`gate_key`); çünkü Android'in TLS yığını (Conscrypt) her sürümde Ed25519 sertifikası
  konuşmaz, P-256 her yerde çalışır. Sertifikanın CN'i iki durumda da cihaz kimliğidir.
- Sertifika elle DER yazılır (`GateCert.kt`, `node/src/tls.ts`): v3, 16 baytlık rastgele seri,
  `ecdsa-with-SHA256`, issuer = subject = `CN=<cihaz kimliği>`, 10 yıl (UTCTime), SPKI,
  `basicConstraints CA:false`. Zincir yoktur, kimse doğrulamaz; karşı taraf **parmak izini**
  (`fp` = DER'in SHA-256'sı, 64 küçük harf hex) sabitler. BouncyCastle eklenmedi: JDK'da
  herkese açık sertifika üreteci yok, 60 satır DER 7 MB bağımlılıktan iyidir. İki taraf aynı
  baytları yazar; `gate-vectors.json` içindeki `cert` vektörü TBSCertificate'ın SHA-256'sını
  sabitler (imza rastgele olduğu için tüm sertifika vektör olamaz).
- Dosyalar: Android `files/gate/gate_key`, `files/gate/gate_cert.der`, `files/gate/paired`
  (uygulama ve `:worker` süreci aynı kimliği paylaşır); kula-node `~/.kula-node/gate_key.pem`,
  `gate_cert.der`, `paired`; dev-gate `.llama/dev-gate/` (sertifikayı `openssl` ile yapar).

### QR v3

```
{"k":"kula-peer","v":3,"id","name","host","port","fp","pin","kind","ram","bw","passport"}
```

`fp` işçinin sertifika parmak izi; `pin` tek kullanımlık eşleşme kodu (16 hex). `secret` yoktur.
Kod harcanınca işçi yeni kod üretir ve QR'ı yeniler (telefonda `share` ekranı durum dosyasından
okur, kula-node yeni QR basar, dev-gate yeni JSON yazar). `pin`siz v3 QR da okunur: zaten eşleşmiş
bir ustaya yeniden göstermek için.

### el sıkışma (TLS içinde)

Önce TLS 1.3, **iki taraf da sertifika sunar** (sunucu `wantClientAuth`, node `requestCert`).
İstemci sunucu sertifikasını yalnız parmak iziyle doğrular (`PinnedTrust`); **hostname
doğrulaması kapalı**, çünkü eşler IP adresidir. Sunucu TLS katmanında her istemci sertifikasını
kabul eder, kararı el sıkışmada verir. Sonra satırlar:

```
C → S   KULA2 <kanal> <nonce_c> <unix_ms>      dört alan zorunlu
S → C   <nonce_s> paired  |  <nonce_s> pin  |  NO <neden>
C → S   <proof_c>        pin:    HMAC-SHA256(pin, "nonce_c|nonce_s|kanal|fp_s|fp_c")
                         paired: "-"
S → C   OK <proof_s>     pin:    HMAC-SHA256(pin, "nonce_s|nonce_c|kanal|fp_s|fp_c")
                         paired: "OK -"
   ya da NO <neden>
```

- `fp_s` işçinin, `fp_c` ustanın sertifika parmak izi; HMAC'e ikisini de katmak kodu
  başka bir sertifika için kullanılamaz yapar.
- **İlk bağlantı (eşleşme):** sunucu istemci parmak izini tanımıyorsa ve açık bir kod varsa
  `pin` der. Doğru kanıtla istemcinin parmak izi `paired` dosyasına yazılır (iki yönlü TOFU:
  usta işçiyi QR'dan, işçi ustayı bu ilk bağlantıdan sabitler), kod harcanır, deftere `pair`
  olayı düşer.
- **Sonraki bağlantılar:** yalnız TLS; istemci `-` yollar, sunucu `OK -` der. Gizli anahtar yoktur.
- Tekrar nonce ve saat (±2 dk) **denetçi olmasa da** her v2 hello'da kontrol edilir.
- Sunucu el sıkışmada satır başına 5 s verir, sonrasında zaman aşımı yoktur. Kanıtlar sabit sürede
  karşılaştırılır. Kanıt satırından hemen sonra gelen baytlar yutulmaz, boruya aktarılır.
- TLS soket yarı kapanamaz: bir yön bitince TLS taraf `close_notify` ile tümden kapatılır
  (düz tarafta `shutdownOutput`). Ayrı modun kapanışla sınırlanan HTTP cevapları böyle biter.

### ret nedenleri

| neden | ne zaman |
|---|---|
| `no hello` | 5 s içinde satır gelmedi |
| `bad hello` | `KULA1`/`KULA2` değil, alan sayısı yanlış, saat sayı değil (v2'de saat zorunlu) |
| `bad channel` | `rpc` ya da `api` değil |
| `bad nonce` | 32 hex değil |
| `replay` | bu eşten aynı nonce daha önce geldi |
| `clock` | istemci saati bizden 2 dakikadan fazla sapıyor |
| `no tls` | TLS istemcisi, sunucu yalnız v1 (ham sokete yazılır; istemci TLS hatası görür) |
| `tls` | TLS el sıkışması bitmedi (olay olarak deftere; istemciye satır gidemez) |
| `no client cert` | v2 istemci sertifika sunmadı |
| `not paired` | istemci sertifikası tanınmıyor ve açık kod yok (ya da istemcide kod yok) |
| `wrong pin` | eşleşme kanıtı tutmadı |
| `bad proof` | eşleşmiş istemci `-` yerine başka şey yolladı |
| `no proof` | kanıt satırı gelmedi |
| `wrong secret` | v1 HMAC tutmadı |
| `channel closed` | kanalın yerel hedefi yok (model yüklü değil vb.) |
| `busy` | `rpc` kanalında başka bir eş bağlı |
| `target down` | 127.0.0.1'deki hedef bağlantıyı almadı |

İstemci tarafı hataları: `fingerprint mismatch` (sunucu sertifikası QR'dakinden farklı; hello'ya
hiç gidilmez), `tls …` (el sıkışma hatası), `server proof wrong`.

### v1 ile birlikte yaşama

- Sunucu her zaman iki protokolü de dinler (`--tls`/TLS kimliği varsa). İlk bayt `0x16` → TLS,
  değilse v1. v1 hello'nun ilk baytı `K` (0x4b) olduğundan karışma olmaz.
- Telefon işçisi her zaman kimlik üretir; QR'ı çalışırken v3'tür. Eski bir ustanın elindeki v2 QR
  (`secret`) aynı işçide v1 ile çalışmaya devam eder (secret hâlâ `share` kaydında).
- Yeni usta: v3 QR → `fp` + `pin` ile v2; v2 QR → `secret` ile v1. `Peer` kaydında `fp` varsa
  TLS, yoksa v1 (`peerTls()` `app/src/llm/cluster.ts`).
- Vektörler: v1 `vectors`, v2 `v2`, sertifika `cert`; iki taraf da üçünü de test eder.

### durum

Kotlin ve TS tarafı JVM/node testlerinden geçti (loopback'te TLS 1.3, eşleşme, tüm retler,
aynı portta v1). **Cihazda denenmedi**: Android'de `SSLSocketFactory.createSocket(Socket,
InputStream consumed, Boolean)` (API 24+) ve Conscrypt'in `wantClientAuth` ile TLS 1.3 istemci
sertifikası davranışı emülatörde doğrulanmalı; KeyStore'a taşınacak anahtar (`KeyStoreKey`) hâlâ
yapılacak.
