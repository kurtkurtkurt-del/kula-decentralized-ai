# kullanıcı kılavuzu

kula decentralized ai telefonda nasıl kullanılır: kurulum, telefonu ölçme, model seçme,
sohbet, iki telefonu birleştirme, bilgisayar ekleme, gece işi ve bir şey bağlanmadığında ne
yapılır. English: [GUIDE.en.md](GUIDE.en.md). Nasıl yapıldığı: [ARCHITECTURE.md](ARCHITECTURE.md).

## 1. kurulum

kula bir Android uygulaması (arm64, Android 7 ve üstü). Henüz mağazada yok; apk elle kurulur.

1. `kula-decentralized-ai-<sürüm>.apk` dosyasını al (`app/` içinde `npm run apk` ile derlenir,
   bkz. [../CONTRIBUTING.md](../CONTRIBUTING.md); dört cpu çeşidi için llama.cpp taşıdığından
   85 MB kadar).
2. Telefona kopyala (USB, kendine mesaj, indirme) ve aç. Android o kaynaktan kuruluma bir kez
   izin ister.
3. kula'yı aç. İlk ekranda **demo olarak gir**'e bas: model çalıştırmak ve cihaz birleştirmek
   için hesap gerekmez. E-posta formu "hesabım var" bağlantısının arkasında.

Aynı apk tablette de çalışır. iOS derlemesi yok; iOS'ta, Expo Go'da ve tarayıcıda uygulama
açılır ama "modeller yalnızca android uygulamasında çalışır" der.

Her derleme ya telefondaki demo dünyasıyla ya da kula'nın kendi sunucusuyla konuşur;
ayarlar → uygulama → sunucu hangisi olduğunu söyler. Modeller ve cihazlar iki durumda da
aynı çalışır.

## 2. telefonu ölç

Passport sekmesi → **ölç**. Telefon birkaç saniyede kendi belleğini, bellek bant genişliğini,
cpu'sunu, hesap gücünü, diskini, pilini ve ısısını ölçer; sonucu kart olarak gösterir: sığan
en büyük model ve kabaca saniyede kaç token. Modelin sığıp sığmadığına dair her şey bu
karttan okunur, o yüzden önce bunu yap; yoksa modeller sekmesi ister.

Yeniden başlatmadan sonra ya da telefon sıcakken ölçtüysen tekrar ölç: kısılmış hâldeyken
alınan ölçüm telefonu sıcak sayar ve gece sıcak telefonda başlamaz.

## 3. model seç

Modeller sekmesi. Liste *bu* telefona göre sıralı: **sığar**, **sıkışık**, **sığmaz**; altında
"~N mb gerekir, bu telefon M mb verir". Üstteki satır boş diski söyler ve eski indirmeler
birikince **kullanılmayanları sil** önerir.

Hangi telefona hangi model:

| telefon | bununla başla | iyi gider |
|---|---|---|
| eski ya da küçük, 3–4 GB RAM | Qwen3 0.6B | Gemma 3 1B |
| 4 GB | Gemma 3 1B, Qwen2.5 1.5B | Llama 3.2 1B |
| 6 GB | Qwen2.5 1.5B, Qwen3 1.7B | Llama 3.2 3B |
| 8 GB ve üstü | Llama 3.2 3B, Qwen3 4B, Phi-4 mini | başka bir cihazla birlikte Qwen2.5 7B |
| iki üç telefon ya da telefon + bilgisayar | bölünmüş modda Qwen2.5 7B | ayrı modda yukarıdakilerden herhangi biri |

Katalogdaki her modelin ne için olduğu (aynı metin her modelin sayfasında, üç dilde):

| model | boyut | neyi iyi yapar | ne için kullanılır |
|---|---|---|---|
| Qwen3 0.6B | 0,6 GB | kısa cevaplar, listeler, basit yeniden yazımlar; boyutuna göre akıcı ingilizce ve türkçe; matematikte ve uzun akıl yürütmede zayıf | uygulamayı denemek, eski ya da küçük telefonlar, ilk gece işi (kısa metin sınıflama, etiketleme); en hızlı indirme |
| Gemma 3 1B | 0,8 GB | temiz kısa düzyazı, bir paragrafın özeti, kısa metin üzerinden soru-cevap; 140 dil | 4 GB telefonda kısa metin özetleme ve çeviri; çok okuyup az yazan gece işi |
| Llama 3.2 1B | 0,8 GB | ingilizce yönergeler, basit çıkarım (ad, tarih, alan), rahat sohbet | küçük telefonlarda ingilizce yapılandırılmış çıkarım; bilgisayardaki büyük modelle iyi eşleşir |
| Qwen2.5 1.5B | 1,1 GB | dengeli: yazı, özet, hafif kod, türkçe ve almanca dahil 29 dil; biçimlere (json, liste) uyar | 4–6 GB telefonda günlük seçim; json çıktısı isteyen gece işleri |
| Qwen3 1.7B | 1,8 GB | cevaplamadan önce adım adım düşünür (`/no_think` kapatır); 1B sınıfından iyi matematik ve mantık; iyi türkçe | 6 GB telefonda biraz düşünme isteyen sorular; cevap başına yavaş, toplu etiketleme için değil |
| Llama 3.2 3B | 2,0 GB | ingilizcede sağlam genel asistan: uzun cevap, yeniden yazma, yönerge, biraz kod | ana cihaz olarak 6–8 GB telefon; gece ingilizce yazı işleri |
| Qwen3 4B | 2,5 GB | geçen yılın 7B'lerine yakın: akıl yürütme, kod, çok dilli yazı, uzun bağlam; düşünme modu açık | amiral gemisi telefonun tek başına çalıştırabileceği en iyisi; zor gece işleri (değerlendirme, damıtma); ısınır, yavaştır |
| Phi-4 mini | 2,5 GB | matematik, mantık, kod; kısa ve kesin; gündelik sohbette ve türkçede zayıf | 8 GB telefonda kod ve matematik; çözümü bilinen cevapları puanlama |
| Qwen2.5 7B | 4,7 GB | gerçek bir asistan: uzun belge, özenli yazı, kod, 29 dil; listedeki her şeyin bir üst basamağı | tek telefona büyük: iki üç telefonla bölünmüş mod ya da bilgisayarla ayrı mod |

**indir**'e bas. İndirme uygulama öldürülse ve bağlantı kopsa da kaldığı yerden sürer; yalnız
sağlama toplamı tutarsa saklanır. Her model lisansına bağlanır; bir kez oku.

Katalogun altındaki **hugging face'te ara** herhangi bir GGUF deposunu bulur. `Q4_K_M` (olağan
denge) ya da `Q8_0` (büyük, biraz daha iyi) adlı dosyaları seç; süzgeç çipleri bunu yapar.
Kilitli (gated) depo Hugging Face'te giriş ister, uygulamadan indirilemez; "lisansı oku"
sayfasını açar. Çok parçalı dosyalar (`-00001-of-0000n`) tek model olarak iner.

### model sayfası ve mod sorusu

Bir model aç → **başlat**. Uygulama *nasıl çalışsın?* diye sorar:

- **yalnız bu telefon**: en hızlısı; ağa hiçbir şey çıkmaz.
- **ayrı: her cihazda bir kopya**: her cihaz kendi kopyasını çalıştırır, iş paylaştırılır,
  hızlar toplanır. kula gece böyle çalışır; cihaz bağlıyken varsayılan budur. beyin'in
  kuralı: işler bölünür, modeller bölünmez.
- **bölünmüş: tek model, cihazlara yayılmış**: hiçbir cihazın tek başına tutamayacağı kadar
  büyük bir model; ama her token wi-fi'den geçer. Yalnız aynı odadaki cihazlar için.
  Bölünmüş'ü seçmek paylaşmak demektir, tahmin "buraya sığar" dese de.

Sayfada **bağlam** da ayarlanır (modelin konuşmadan ne kadarını hatırladığı, token olarak;
fazlası bellek ister; önerilen, sığan en büyüğü, en çok 4 096) ve beklenen hız görünür.
Yüklendikten sonra katmanların nerede durduğunu ve hangi cihazın neden dışarıda kaldığını
söyler.

## 4. sohbet

Sohbet model sayfasından ya da sekme çubuğundan açılır. Yaz, gönder, cevabı kesmek için
**durdur**, bağlamı temizlemek için **yeni sohbet**. Her cevabın altında: tok/s, ilk token'a
kadar geçen süre, token sayısı ve hangi cihazın cevapladığı. Yazı kutusu klavyenin üstünde
kalır.

**toplu test** sekiz kısa istemi bütün cihazlara aynı anda gönderir; kaç cevabın kaç saniyede
geldiğini ve toplam tok/s'yi yazar. İkinci cihazın gerçekten yardım edip etmediğini görmenin
en hızlı yolu.

Qwen3 modelleri cevaplamadan önce düşünür; atlamak için mesajın başına `/no_think` yaz.

## 5. iki telefonu birleştirme, adım adım

İki telefon da **aynı wi-fi**'de, ikisinde de kula kurulu. Biri *usta* olacak (sohbet
ettiğin), öteki *işçi* (işlemcisini ödünç veren).

İşçide:

1. kula'yı aç → **bu telefonu paylaş**.
2. **paylaşmaya başla**'ya bas. Telefonun adı, boş belleği ve bant genişliğiyle bir QR çıkar.
   Paylaşırken ekran açık kalır; telefon yalnız o zaman tam hızda çalışır.
3. Kart "android bu telefonu yavaşlatıyor" diyorsa **pili sınırsız yap**'a bas ve onayla.

Ustada:

4. **bağlı cihazlar** → **kod okut** → kamerayı işçinin QR'ına tut. İşçi listede *ulaşılabilir*
   olarak belirir. **yakındakileri bul** bu wi-fi'de paylaşan telefonları listeler, ama kodu bir
   kez okutman yine gerekir; eşleşme onun içindedir.
5. Modeller sekmesi → bir model → **başlat** → **ayrı** (tek büyük model için **bölünmüş**).
   "cihazlara ulaşılıyor…", sonra "model yükleniyor…". Ayrı modda işçi aynı modeli ilk kez
   indirir; ustadaki indirme ne kadar sürdüyse o kadar sürer.
6. Sohbet. Cevabın altındaki cihaz satırı hangi telefonun ürettiğini söyler; **toplu test**
   ikisini birden çalışırken gösterir.

İşçinin ekranında "<ad> için çalışıyor" ile bağlantı ve ret sayıları görünür. **paylaşmayı
bitir** sonlandırır; usta cihazı ulaşılamıyor sayar ve tek başına devam eder.

Yeni derlemelerde (kapı v2) QR tek kullanımlık bir eşleşme kodu da taşır; ilk bağlantıda
harcanır ve iki telefon o andan sonra birbirinin sertifikasını hatırlar. Eski bir usta aynı
QR'daki ortak gizli anahtarla yine eşleşir.

## 6. bilgisayar ekleme

Bilgisayar bu depodaki küçük komut satırı programı **kula-node** ile katılır (Mac, Linux,
Windows). Tam başvuru: [NODE.md](NODE.md).

```bash
cd node
npm install
npm run build
node dist/bin/kula-node.js setup     # llama.cpp'yi bir kez indirir/derler
node dist/bin/kula-node.js share
```

`share` terminale bir QR basar. Telefonda: bağlı cihazlar → **kod okut**. Bilgisayar RAM'i ve
bant genişliğiyle *bilgisayar* olarak belirir. Bundan sonra ikinci telefon gibi davranır: ayrı
mod ona istem gönderir, bölünmüş mod katmanların çoğunu ona koyar. İlk seferinde bilgisayar
modeli `~/.kula-node/models` içine indirir.

Kapı portu (50551) için güvenlik duvarı sorusuna izin ver. Karşıda kamera yoksa
`share --no-qr` JSON basar; telefondaki **yapıştır** düğmesi onu alır.

Bilgisayar kümeyi kendisi de yönetebilir, telefonlar işçi olur: `kula-node peers add`,
`kula-node chat --mode apart --batch` ([NODE.md](NODE.md)).

## 7. gece

Projeler sekmesinde bir proje tut. Passport kartında **bu gece çalış** anahtarı ve durum var:
bekliyor ve neden, çalışıyor ve sayaçlar, ya da dün gecenin satırı.

Gece şunların hepsi tutunca başlar: anahtar açık, bir proje tutulmuş, telefon ölçülmüş, saat
gece pencerende (profil), telefon şarjda ("yalnız şarjda", ayarlarda, varsayılan açık), pil
eşiğin üstünde (%20, 30, 50 ya da 80; varsayılan 30), son ölçüm sıcak değil ve istediysen
wi-fi'desin. Biri bozulunca gece duraklar ve yaptığını saklar; yeniden tutunca aynı gece
kaldığı yerden sürer.

Ne yapar: seçtiğin modeli (ya da sığan en büyüğü) ayrı modda, bağladığın ve cevap veren her
cihazla yükler; kısa birimlerden oluşan bir yığını cihaz başına bir birim olacak şekilde
işler. Bazı birimlerin bilinen cevabı var; onlar cihazın dürüst cevap verip vermediğinin
kontrolü.

**Uygulama açık kalmalı.** Android bir uygulamanın arka planda saatlerce model çalıştırmasına
izin vermez. Gerçek işçi çalışırken ekranı (kısık) açık tutar; telefonu elle kilitlersen gece
duraklar, uygulamayı açınca sürer. Sessiz bir bildirim çalıştığını söyler. Telefonu şarja
tak, kula'yı passport sekmesinde aç, yüzüstü bırak.

Sabah rapor: birimler, doğru çıkan kontrol oranı, cihaz başına tok/s, çalışılan süre,
watt-saat ve önceki gecelerle karşılaştırma. Ayrıntı: [NIGHT.md](NIGHT.md).

## 8. sorun giderme

**Usta işçiyi görmüyor ya da ulaşamıyor.**
- Aynı wi-fi mi? Misafir ağındaki ya da mobil verideki telefonlar birbirini göremez. Paylaşma
  ekranı "wi-fi'de değil" diye uyarır.
- **İstemci yalıtımı** (AP isolation): birçok yönlendirici, neredeyse her otel, kafe ve kampüs
  ağı ve çoğu misafir ağı cihazların birbiriyle konuşmasını yasaklar. kula'da bunu aşacak bir
  şey yok. Kendi yönlendiricini kullan ya da **telefon hotspot'u** aç: telefonlardan birinde
  (işçi olabilir) hotspot aç, ötekileri ona bağla; hotspot sahibinin adresi 192.168.43.x ya da
  10.x gibidir ve ötekiler ona ulaşır.
- QR, gösterildiği andaki adresi taşır. İşçinin adresi değiştiyse (yeni ağ, ertesi gün) yeniden
  okut; aynı cihaz eski kaydının yerine geçer. Eşler ekranındaki **kontrol et** yeniden dener.
- Bilgisayar: güvenlik duvarı TCP 50551'e gelen bağlantıya izin vermeli.
- Ustada **yakındakileri bul**'a bas; orada görünen ama okuttuktan sonra ulaşılamayan işçi
  hemen her zaman istemci yalıtımıdır.

**"busy" (meşgul).** İşçinin rpc kanalı bir seferde bir usta alır. Başka bir telefon onunla
bölünmüş modda ya da eski bir bağlantı henüz düşmedi. Paylaşmayı durdurup yeniden başlat.

**"channel closed".** İşçi ayakta ama o kanalda henüz bir şey yok: ayrı modda model
yüklememiş, bölünmüş modda rpc sunucusu başlamamış. Ustada modeli yeniden başlat.

**"wrong secret" / "not paired" / "fingerprint mismatch".** Ustadaki kod önceki bir paylaşma
oturumundan. İşçinin şimdi gösterdiği QR'ı okut.

**"bu cihazların hepsine birlikte bile sığmaz".** Daha küçük model seç, bağlamı düşür ya da
cihaz ekle. Bölünmüş mod bu telefonun boş belleğinin %70'ini, her işçinin bildirdiğinin
%75'ini sayar.

**Yavaş.**
- Arka plandaki işçiye yalnız yavaş çekirdekler verilir. İşçide kula'yı ekranda tut, **pili
  sınırsız yap**.
- Bölünmüş mod her token'ı wi-fi'den geçirir; 2,4 GHz ağ ya da uzak yönlendirici modeli ayrı
  moda göre on kat yavaşlatabilir. Model sığmıyorsa dışında ayrı modu seç.
- Bölünmüş modda yükleme önce katmanları işçiye akıtır: iyi wi-fi'de bir gigabayt bir dakika,
  kötüsünde çok daha fazla.
- Sıcak telefon hızını yarıya indirir. Soğumasını bekle, kılıfı çıkar.

**Pil kısıtlaması işçiyi ya da geceyi öldürüyor.**
- Ayarlar → uygulamalar → kula → pil → **sınırsız**. Paylaşma ekranında bunun için düğme var.
- **Samsung:** Ayarlar → pil ve cihaz bakımı → pil → arka plan kullanım sınırları: kula'yı
  "uyuyan uygulamalar" ve "derin uyuyan uygulamalar"dan çıkar, "hiç uyumayan uygulamalar"a
  ekle; denerken "uyarlanabilir pil"i ve "kullanılmayan uygulamaları uyut"u kapat.
- **Xiaomi / Redmi / Poco:** otomatik başlatma açık, pil tasarrufu "kısıtlama yok", uygulamayı
  son uygulamalarda kilitle.
- **Huawei / Honor:** uygulama başlatma → elle yönet, üçü de açık.
- **OnePlus / Oppo / Realme:** pil iyileştirme → iyileştirme, "akıllı denetim" kapalı.
- Gece için telefon **şarjda** olmalı (varsayılan); modele yetişemeyen yavaş bir şarj cihazı
  şarjda sayılır ama pil düşer; telefonun kendi şarj cihazını kullan.

**İndirme başarısız ya da duruyor.**
- "bağlantı koptu, yeniden deneniyor" olağan; kaldığı yerden sürer, öldürülse de.
- Sağlama toplamıyla "olmadı": sunucudaki dosya değişti ya da indirme bozuldu; sil ve yeniden
  indir.
- "yeterli boş alan yok": liste ne kadar eksik olduğunu söyler; **kullanılmayanları sil** eski
  modelleri temizler.
- "kilitli" diyen bir Hugging Face deposu kendi sitesinde giriş ister, uygulamadan inmez.

**Bildirimler.** Gecenin yapışkan bildirimi bildirim izni ister; gece onsuz da çalışır.

**Ekran "modeller yalnızca android uygulamasında çalışır" diyor.** Expo Go'da, iOS'ta ya da
tarayıcıdasın. apk'yı kur.

## 9. sss

**Ben Münih'teyken Berlin'deki biriyle olur mu?** Kutudan çıktığı gibi olmaz. kula v0 yerel bir
küme: cihazlar birbirini tek wi-fi'de bulur ve ulaşır. Henüz kula relay'i yok. İkiniz de aynı
özel ağa girerseniz (Tailscale, ZeroTier, WireGuard VPN) kapı portuna ulaşılır ve bilgisayar
adresiyle eklenir (`kula-node peers add <ip>:50551:<secret>` ya da QR'ı `host` değiştirilmiş
olarak yapıştır); sonra yalnız **ayrı** modu kullan, bölünmüşü asla, ve istemler yolda düz
metin gitmesin diye TLS kapısını (v2) tercih et. İki telefon arasında kapı bağlantılarını
ileten bir relay planlanan sonraki adım; protokolde değişiklik gerektirmez. Bkz. [NODE.md](NODE.md),
"beyond the local network".

**Telefonumdan bir şey çıkıyor mu?** Modeller Hugging Face'ten gelir. İstem ve cevaplar yalnız
eşleştirdiğin cihazlara gider. Gecenin sonuçları v0'da telefonda kalır; rapor yalnız demo
derlemesinde sunucuya gider. Passport ve gecenin toplamları eskisi gibi hesabına gider.
Defter (ayarlar → uygulama → beyin denetimi) dışa aktarana kadar cihazda kalır.

**Öteki telefon sohbetlerimi okuyabilir mi?** Ayrı modda istemini işçi çalıştırır, yani evet,
o cihaz görür. Yalnız güvendiğin cihazları eşleştir. Kapı v1'de istem ikisi arasında wi-fi'de
düz metin; kapı v2 şifreler.

**Neden varsayılan ayrı mod, bölünmüş değil?** Çünkü işler iyi bölünür, modeller bölünmez:
ayrı modda yavaş cihaz hızlıyı geriye çekmez, düşen cihaz bir birime mal olur ve ağdan yalnız
istemler geçer. Bölünmüş, iyi olduğu tek durum için: hiçbir yere tek başına sığmayan model;
ve aynı oda gerekir.

**Hangi telefon usta olmalı?** Elinde tuttuğun. Ayrı modda hız toplamdır; bölünmüş modda usta
çıkış katmanını tutar ve modelin çoğunu en hızlı cihaz tutmalı, bunu planlayıcı kendi yapar.

**Bir gece ne kadar güç harcar?** Rapor söyler: saat × telefonun ölçülen watt'ı (ölçülene kadar
3 W varsayılır). 3–4 W'lık bir telefon altı saatte 20 Wh kadar, bir kWh'nin ellide biri.

**Kendi GGUF dosyamı kullanabilir miyim?** Modeller sekmesinden Hugging Face'te ara ya da bir
deponun dosyasını aramaya yaz. Telefona elle kopyalanan dosyalar henüz tanınmıyor.

**beyin nedir?** Bağımsız denetçi. v0 yalnız kaydeder: her bağlantı, ret, model yüklemesi ve
sağlık satırı işçideki imzalı, zincirli deftere düşer; eşler ekranı her cihazın yanında ondan
bir rozet gösterir. [AUDIT.md](AUDIT.md).
