# aktarıcı (relay) — NAT arkasındaki iki cihazı birleştirmek

Kula kümesi bugüne kadar yalnız aynı yerel ağda çalıştı: işçi kapı portunu açar, QR yerel IP
taşır, yönetici bağlanır. "Berlin'deki biriyle telefonlarımı birleştirebilir miyim?" sorusunun
cevabı hayırdı: iki taraf da NAT arkasında, kimse kimseye gelemiyor. Aktarıcı bunu çözer:
**iki uç da dışarı doğru** bir sunucuya bağlanır, sunucu iki soketi birbirine boru yapar.
Aktarıcı **içeriği göremez**: kapı protokolü v2'nin TLS'i (docs/GATE.md) borunun içinde
uçtan uca kurulur; aktarıcının gördüğü yalnız TLS kayıtlarıdır. Bu, beyin'in ilerideki
aktarma hizmetinin ilk hâlidir (5.11.2026, dal `claude/relay`).

Kodlar: sunucu `node/relay/` (`src/server.ts` kütüphane, `src/main.ts` ikili, Dockerfile,
`fly.toml`, `render.yaml`); kula-node ucu `node/src/relay.ts`; telefon ucu
`app/modules/kula-llama/android/.../Relay.kt`; uygulama `app/src/llm/peers.ts`,
`share.tsx`, `peers.tsx`, `cluster.ts`. Testler `node/test/relay.test.ts` (uçtan uca),
`node/test/peers.test.ts` ve `app/src/__tests__/llm.test.ts` (ayrıştırma).

## neden WebSocket, neden ham TCP değil

Seçenek ham TCP + uzunluk öneki ile WebSocket arasındaydı. **WebSocket (`ws`)** seçildi:

- Her PaaS HTTP'yi ayrı port açmadan yönlendirir (Render ham TCP vermez; Fly verir ama
  ayrı ayar ister). `wss://` 443'ten geçer; telefon ağları ve ofis güvenlik duvarları bunu
  engellemez, ham bir porta çoğu zaman izin vermez.
- Tarayıcı ve React Native (OkHttp) WebSocket'i doğal konuşur; bir sonraki adım (telefonun
  kendi kodu yerine beyin'in web'i) ek protokol istemez.
- Çerçeveleme ve geri basınç (`bufferedAmount`) `ws`'ten hazır gelir; uzunluk önekli
  çerçeveyi, kısmi okumayı ve tamponu kendimiz yazmazdık.
- Çerçeve başına 2–8 baytlık ek yük bir token'ın yanında hiçtir.

Bedeli: `ws` bağımlılığı (kula-node'a da eklendi) ve aktarıcının kendi TLS'ini barındırıcının
bitirmesi (Fly/Render bunu yapar; kendi sunucunda Caddy/nginx önüne koy).

## protokol

Her bağlantının ilk çerçevesi bir JSON metin çerçevesidir; `ready`den sonra yalnız ikili
çerçeve geçer, metin çerçevesi akışı kapatır.

```
işçi denetim    → {"t":"register","id","name"?,"fp"?}
                ← {"t":"registered","code":"123456","ttl_s":600,"token"}
                ← {"t":"code","code","ttl_s"}         kod süresi dolunca yenisi
                ← {"t":"open","sid":n}                 bir yönetici akış istiyor: kabul et
                ← {"t":"master","state":"connected"|"gone"}
işçi akış       → {"t":"accept","sid","token"}         ← {"t":"ready"}, sonra ikili çift yönlü
yönetici denetim→ {"t":"connect","code":"123456"}
                ← {"t":"connected","session","worker":{"id","name","fp"}} | {"t":"error","reason"}
yönetici akış   → {"t":"stream","session"}              ← {"t":"ready"}, sonra ikili çift yönlü
```

Her **akış = bir kapı bağlantısı**. `api` kanalı her HTTP isteği için yeni kapı bağlantısı
açar (Tunnel böyle çalışır), yani her istek bir akıştır; aktarıcı akışı işçiye `open` ile
bildirir, işçi 10 sn içinde ikinci bir bağlantıyla `accept` eder, aktarıcı ikisini boru yapar.
İşçi tarafında akış `127.0.0.1:<kapı portu>`na bağlanır: kapı, aktarılan yöneticiyi yerel
ağdakiyle aynı biçimde servis eder. Bu yüzden kapı olayında `peer` 127.0.0.1 görünür
(defterde de öyle); `rpc` kanalındaki "tek yönetici IP'si" kuralı aktarılan bağlantıları ayırt
edemez, ama `rpc` zaten aktarılmaz (aşağıda).

Hata nedenleri: `unknown code` (süresi dolmuş da buna girer), `busy` (o işçide açık bir
yönetici oturumu var), `rate limited`, `full`, `no such session`, `too many streams`,
`worker did not accept`, `bad hello`.

## kurallar ve sınırlar

- **Kod 6 hane, 10 dakika** (`RELAY_CODE_TTL_S`). Dolunca aktarıcı işçiye yeni kod yollar;
  işçi QR'ını yeniler (kula-node yeniden basar, telefon `share` ekranı durum dosyasından
  okur). Açık bir yönetici oturumu kodun dolmasından etkilenmez; oturum, yöneticinin denetim
  bağlantısı kapanınca biter.
- **Aynı anda tek yönetici**: ikinci `connect` → `busy`. İlk gidince sıradaki girer.
- **Hız**: IP başına dakikada 120 yeni bağlantı, 10 yanlış kod (`RELAY_CONNECTS_PER_MIN`,
  `RELAY_BAD_CODES_PER_MIN`); 10⁶'lık kod uzayı bu sınırla yeter. Arkasında proxy varsa
  `x-forwarded-for`un ilk adresi sayılır.
- **Bayt**: oturum başına 1 GiB (`RELAY_MAX_MB`), çerçeve 1 MiB, oturum başına 16 açık akış,
  akışta 5 dk sessizlik → kapanır, kayıtlı işçi sayısı 1000 (`RELAY_MAX_WORKERS`).
- Aktarıcının bildiği: işçinin id'si, adı, sertifika parmak izi, IP'ler, bayt sayıları.
  Bilmediği: pin, içerik, hangi model. Diskte hiçbir şey tutmaz.

## güven: aktarıcı araya girebilir mi

İki uç TLS 1.3 ile **kendi sertifikalarıyla** konuşur; aktarıcı yalnız şifreli bayt taşır.
QR ile eklenen eş `fp`yi pinler: aktarıcı kendi sertifikasını sunsa `fingerprint mismatch`.
**Yalnız kodla** eklenen eş (`123456 <pin>`, telefonla söylenen) parmak izi bilmez; ilk
bağlantı gördüğü sertifikayı alır ve kapının pin kanıtı karar verir: kanıt
`HMAC(pin, nonce_c|nonce_s|kanal|fp_s|fp_c)` **iki parmak izini de** kapsar. Araya giren
aktarıcı iki tarafa ayrı sertifika sunmak zorundadır; istemci kanıtı aktarıcının `fp`siyle
hesaplar, işçi kendi `fp`siyle doğrular → `wrong pin`. Pin olmadan yalnız kod: `not paired`.
Başarılı ilk bağlantıdan sonra öğrenilen parmak izi pinlenir, pin harcanır (`afterPaired` /
`learnPeer`). Bu, `relay.test.ts`'de "a code-only peer learns the fingerprint…" ile sınanır.

Aktarıcıya v1 (paylaşılan gizli anahtar, düz metin) hiç verilmez: kula-node `--relay`
`--tls`i zorlar; `peers add` aktarıcılı v2 QR'ı reddeder; uygulama da öyle.

## hangi mod

**Ayrı mod** uzak için uygundur: her cihaz kendi kopyasını çalıştırır, aktarıcıdan yalnız
istemler ve token'lar geçer (`api` kanalı). **Bölünmüş mod uzaktan anlamsızdır**: her token'da
katmanlar arası veri ağdan geçer, internet gecikmesiyle saniyede bir token bile zor; ayrıca
`rpc` kanalı aktarılmaz. Bu yüzden yönetici tarafı uzak eşe yalnız `api` açar:

- kula-node: `planWithProbe` aktarıcılı eşi probe etmeden `remote peer: split mode needs the
  lan` ile atlar, `chat --mode split` bunu söyler; `--mode apart` eşi `RelayTunnel` ile alır.
- uygulama: `cluster.ts probeAll(…, 'rpc')` uzak eşleri `remote` nedeniyle atlar (NSD ile
  yeniden arama da yapılmaz); mod sayfasında "bölünmüş" satırı "{n} uzaktaki dışarıda: bölünmüş
  aynı wi-fi ister" der ve yalnız uzak eş varsa kapalıdır; "ayrı" satırı "{n} uzaktan,
  aktarıcı üstünden" der.

Ayrı modda model: uzak işçi modeli **yönetici bilgisayardan çekemez** (yerel ağ adresi),
kula-node bunu söyler; `--model-url https://…` ver ya da işçi daha önce indirdiği modeli kullansın
(işçi api'si indirdiklerini tutar; telefonda katalogdan indirilmiş model yeter).

## nasıl çalıştırılır

Aktarıcı:

```
cd node/relay && npm install && npm run build && PORT=8787 npm start      # ya da: npm run dev
docker build -t kula-relay . && docker run -p 8787:8787 kula-relay
fly launch --no-deploy --copy-config && fly deploy                         # fly.toml hazır
# render: repo'yu bağla, blueprint render.yaml'ı okur
curl https://<aktarıcı>/health   → {"ok":true,"service":"kula-relay","workers":0,"sessions":0,"streams":0}
```

İşçi (bilgisayar): `kula-node share --relay wss://<aktarıcı>`; çıktıda QR'ın yanında
`far away: kula-node peers add "123456 <pin>" --relay wss://…` satırı. İşçi (telefon):
"bu telefonu paylaş" › "uzaktan paylaş" işaretle, aktarıcı adresini yaz (ayarlarda da aynı
alan), başlat; QR v3 `relay` alanı taşır, ekranda 6 haneli kod ve eşleşme kodu görünür.

Yönetici (bilgisayar): QR JSON'unu `peers add` ile yapıştır, ya da telefonla okunan kodu
`kula-node peers add "123456 0123456789abcdef" --relay wss://…` (`$KULA_RELAY` varsayılan);
`peers probe` aktarıcıdan `api` kanalını dener ve sertifikayı öğrenir;
`chat --model x.gguf --mode apart --model-url https://…`. Yönetici (telefon): "bağlı
cihazlar" › "kod ile ekle" alanına `123456 0123…` yaz (aktarıcı ayarlardan) ya da QR'ı okut;
"kontrol et" uzak eşi `api`den dener; model sayfasında "ayrı" seç.

QR v3 + aktarıcı:

```
{"k":"kula-peer","v":3,"id","name","host","port","fp","pin","relay":{"url":"wss://…","code":"123456"},…}
```

`host`/`port` yerel ağ için kalır (aynı ağdaysan kapıya doğrudan gidilebilir); uzak yönetici
`relay`i kullanır. `host`suz v3 de okunur.

## sınanan ve sınanmayan

`node/test/relay.test.ts` (6 test, gerçek kapı v2 + gerçek işçi api + sahte llama-server):
ayrı mod sohbeti aktarıcıdan geçer ve aktarıcının gördüğü her çerçeve TLS kaydıdır (0x14/0x16/
0x17; istem, cevap, `KULA2`, `HTTP/1.1`, parmak izleri hiçbirinde yok); kod süresi dolar, yenisi
gelir, eskisi `unknown code`; ikinci yönetici `busy`; yanlış kod hız sınırı; yalnız kodla eklenen
eş pin kanıtıyla parmak izi öğrenir, yanlış pin `wrong pin`, pinsiz `not paired`, başka parmak izi
`fingerprint mismatch`; `openApart` uzak eşi cihaz yapar ve `planWithProbe` onu atlar.
Jest: v3+relay ayrıştırma, elle kod, `probeAll` uzak eşi `remote` ile atlar.

**Denenmedi:** gerçek internet üstünden (iki NAT), telefon Kotlin ucu (`Relay.kt`,
cihazda ve derleyicide denenmedi: bu oturumda Android SDK yok), Fly/Render dağıtımı. Kotlin
tarafında `RelaySocket` bir `Socket` alt sınıfıdır ve TLS katmanı `createSocket(socket, host,
port, autoClose)` ile üstüne biner; Conscrypt'in katmanlı soketi yalnız akışları kullanır, ama
bu cihazda doğrulanmalı. OkHttp sürümü (4.12) React Native'inkiyle çakışırsa `build.gradle`'daki
satırı RN'in sürümüne çek.

## sonrası

- Oturum belirteciyle yeniden bağlanma (yöneticinin bağlantısı koptuğunda yeni kod istemeden).
- Aktarıcıda işçi başına kalıcı, QR'dan bağımsız kısa ad; beyin hesabına bağlama.
- Model dağıtımı: işçinin modeli yöneticiden değil beyin'den ya da HF'den alması (uzakta tek yol).
- `rpc`nin asla aktarılmaması kuralını aktarıcıda da zorlamak mümkün değil (içerik görünmez);
  yönetici tarafında zorlanıyor, işçi tarafında kapı `127.0.0.1`den geleni ayırt edemiyor.
