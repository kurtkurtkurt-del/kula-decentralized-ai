# gece testi: 8–9 kasım 2026, mac + tab s10 fe (kablo)

Kurulum: MacBook Air prizde, yurt Wi-Fi'ında (yalnız benim internetim için). Tab S10 FE (SM-X520)
Mac'e USB kabloyla bağlı ve kablodan şarj oluyor, USB hata ayıklama açık. S25+ bu gece yok.
Bütün cihazlar arası trafik kablo üzerinden (adb forward) gidiyor; mobil veri harcanmıyor.

Kurallar: kullanıcının sayfası (port 50590) ve ~/.kula-node'u ellenmez, testler ayrı bir HOME'da koşar.
Yeni APK derlenmez (bugünkü 20:20 APK'sı). Bulunan hatalar raporlanır; düzeltme `main`'e değil,
ayrı bir dala gider. Tablet 42 °C'yi geçerse ağır iş durur, soğuyunca devam eder.
Her ölçüm `scratchpad/gece/` altına JSON satırı olarak yazılır; sabah raporu bunlardan çıkar.

## A. kurulum ve açılış (~15 dk)

1. Tabletteki eski kula üstüne bugünkü APK'yı kurmak (güncelleme), açılış, çökme var mı (logcat).
2. Misafir girişi, pasaport ölçümü ("hızı ölç" sayfası), cihaz adı.
3. Uygulamayı öldürüp açmak, arka plana atıp geri getirmek.

## B. tablette modeller tek başına (~1,5 saat)

Her model için: indirme süresi, sha256, yükleme süresi, ilk kelimeye kadar geçen süre, tok/s (64 ve
512 token), bellek (`dumpsys meminfo`), pil sıcaklığı (`dumpsys battery`), ısıl durum
(`dumpsys thermalservice`).

| model | neden |
|---|---|
| Qwen3 0.6B | en küçük, referans |
| Gemma 3 1B, Llama 3.2 1B | aynı boyda farklı aileler |
| Qwen3 1.7B | orta |
| Llama 3.2 3B, Phi-4 mini, Qwen3 4B | tabletin sınırı |
| Qwen2.5 7B | sığmaması beklenir: uyarı ve hata mesajı doğru mu |

Ayrıca: indirme ortasında uygulamayı öldürüp devam ettirmek (Range ile sürmeli), "kullanılmayanları sil".

## C. ölçüm ve planlayıcı (~30 dk)

1. Uygulamanın "hızı ölç" sayfası ve `kula-node bench` (Mac).
2. Ölçülen tok/s ile planlayıcı simülatörünün tahmini (`node/src/sim.ts`) yan yana: sapma yüzde kaç.

## D. mac + tablet küme (kablo, ~2 saat)

1. **phone modu:** Mac sayfası, tablette çalışan modelle sohbet; cevap akışı, durdurma, yeniden üretme.
2. **apart:** Mac + tablet, aynı model. Tek cihaz ile ikisi birlikte: 8 ve 40 soruluk toplu testte
   toplam süre ve cihaz başına tok/s. Hız gerçekten toplanıyor mu.
3. **split:** tablete tek başına sığmayan bir model (Qwen3 8B / Qwen2.5 7B) Mac + tablette; katman
   paylaşımı, yükleme süresi, tok/s. Sığan bir modeli (Qwen3 4B) bölünce tek cihaza göre fark.
4. **start a chat cihaz seçimi** (yeni dal, `claude/wifi-chat-picker-038fda`): ayrı bir test dalında,
   gerçek tabletle seçim, hazır olanın seçili gelmesi, sığmayan uyarısı.
5. Aynı anda 3 sohbet; `/v1` (OpenAI uyumlu uç) ile bir betikten 20 istek.

## E. uzun gece projesi (~3–4 saat, gecenin ortası)

1. Mac sayfasından planlanmış bir gece projesi: apart, Mac + tablet, 20+ parça.
2. Her 2 dakikada: tablet sıcaklığı, pil, ısıl durum, uygulamanın ve llama-server'ın belleği, tok/s.
   Isınınca hız düşüyor mu, bellek sızıntısı var mı.
3. Sabah raporu sohbete doğru yazıldı mı, kullanım istatistikleri (ayarlar → usage) gerçek token
   sayılarıyla tutuyor mu.

## F. dayanıklılık (~1 saat)

1. Cevap yazılırken tablette uygulamayı öldürmek (`am force-stop`): Mac ne diyor, sonraki soru çalışıyor mu.
2. adb bağlantısını düşürüp geri getirmek (`adb kill-server`): kablo yolu kendini toparlıyor mu.
3. Uzun bağlam: ~3.000 token'lık bir soru.

**Bu gece yapılmayanlar** (geri dönüşü olmayan ya da tableti kilitleyebilecek adımlar):
- **Yeniden başlatma yok.** Android yeniden başlayınca ilk açılışta şifre ister; şifre girilene kadar
  uygulamalar çalışmaz, gecenin geri kalanı orada kalır. Yeniden başlatma testi, kullanıcı yanındayken
  ya da ikinci gece S25+ ile yapılır.
- **Uçak modu yok.** Kabloyu etkilemez ama Wi-Fi'ı kapatıp ayarlara dokunur; sabah unutulmuş bir ayar
  bırakabilir.
- **Depolamayı doldurma yok.** Tablette kullanıcının dosyaları var.
- Tabletin kendi ayarlarına dokunulmaz (ekran, kilit, pil); yalnız kula uygulaması kurulur ve açılır.

Sıra: en riskliler en sona. adb bağlantısı bir kez düşüp geri gelmezse testler durur, o ana kadar
ölçülenler rapora yazılır.

## G. güvenlik ve the brain (~30 dk)

1. Tablette RPC ve api yalnız 127.0.0.1'de mi (`ss -ltn`); dışarıya açık tek port kapı mı.
2. Sertifikası tanınmayan bir istemciyi kapının reddetmesi.
3. Defter: `kula-node ledger --verify`, tabletin defterinin zinciri.
4. God's eye: 12 kutucuk gerçeği söylüyor mu (senses, limits uyarıları, forecast'in saatler içinde
   öğrenmesi, advisor'ın önerisi mantıklı mı); gece projesi başlığında kişisel veri maskeleniyor mu.

## H. paketlenmiş kula-node (~30 dk)

Arkadaşların indireceği tek dosyalık `kula-node-mac-arm64` ile (geliştirme sürümü yerine) D'nin
kısa bir tekrarı: sayfa, ayarlar, learn sekmesi, tabletle bir sohbet.

## I. boş zamanda: test projeleri ve kalite (sabah 08:00'e kadar)

A–H bitince ya da aralarında bekleme olduğunda, Mac sayfasından **gece projeleri** planlanır ve
koşturulur. Her proje **en fazla 30 dakika** (başlangıç–bitiş penceresi 30 dk), Mac + tablet, apart
ya da tek cihaz. Saat 08:00'de yeni proje başlamaz; o an koşan biter, rapor yazılır.

Projeler cevabı **kontrol edilebilen** işlerden seçilir, böylece kalite sayıyla ölçülür:

| tür | örnek | nasıl puanlanır |
|---|---|---|
| hesap | 20 kısa matematik / mantık sorusu | doğru cevap listesiyle karşılaştırma |
| çıkarım | bir metinden 15 alan (ad, tarih, tutar) json olarak | alan alan doğru mu, json geçerli mi |
| sınıflama | 40 kısa yorum: olumlu / olumsuz / nötr | etiket listesiyle karşılaştırma |
| çeviri | 15 cümle tr → en ve en → tr | anlam korunmuş mu (Claude okur, 0–2 puan) |
| özet | 3 paragraflık metin, 5 anahtar bilgi | özette kaç anahtar bilgi var |
| kod | 10 küçük fonksiyon (python) | Mac'te testleriyle çalıştırılır, geçen sayısı |
| plan / yazı | açık uçlu bir istek (ör. bir haftalık çalışma planı) | Claude okur: tutarlılık, işe yararlık (0–5) |

Her proje farklı bir **model × mod** ile koşar, böylece karşılaştırma çıkar: Qwen3 0.6B / 1.7B / 4B,
Gemma 3 1B, Llama 3.2 3B, Phi-4 mini; tek cihaz / apart. Kaydedilenler: puan, süre, parça sayısı,
token, tok/s, ısı. Aynı işi iki kez koşturup tutarlılık da ölçülür. Puanlama Mac'te betikle (hesap,
json, etiket, kod) ve okuyarak (çeviri, özet, plan) yapılır; projenin metni ve cevapları yalnız bu
Mac'te kalır.

Sabah raporunda: hangi model hangi işte ne kadar iyi, apart kaliteyi bozuyor mu, hız ile kalite
arasındaki takas, "bu iş için en iyi seçim" tablosu.

## sabah

Bir rapor: ne çalıştı, ne kırıldı (adımlarıyla), ölçülen sayılar (tablolar), planlayıcının sapması,
ısınma eğrisi, bulunan hatalar ve hangi dalda düzeltildikleri, S25+ ile ikinci gecede ne denenmeli.
