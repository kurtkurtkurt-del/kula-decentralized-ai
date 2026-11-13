# kula internette: sunum taslağı

13 Kasım 2026. Ayrıntılar ve kaynaklar: [CONNECTIVITY-RESEARCH.md](CONNECTIVITY-RESEARCH.md).
Hiçbir şey kurulmadı, kod değişmedi; bu bir araştırma ve bir öneri.

---

## 1. Hedef

- İki ay içinde, dünyanın farklı yerlerindeki arkadaşlar telefonlarını ve bilgisayarlarını internet üzerinden birleştirip büyük bir açık modeli birlikte çalıştırsın.
- Kula'nın kendi yazılımıyla, kendi güvenliğiyle. Yalnız arkadaşlar, yabancı yok.
- Altyapı tek bir modele göre kurulmayacak: o gün en iyi açık model hangisiyse onu taşıyabilmeli.

## 2. Bugün neredeyiz

- Cihazlar kabloyla ya da aynı Wi-Fi'da buluşuyor. Tek bir kapı var; arkasındaki her şey yalnız cihazın kendi içinde dinliyor.
- Her cihazın kendi anahtarı var ve karşı tarafı parmak izinden tanıyor. Bu kısım sağlam ve aynen kalıyor.
- İnternet yolunun ilk adımı kodda duruyor (IPv6 ve modemden kapı açma). Eksik olan: iki evin, ikisi de modem arkasındayken birbirine ulaşması.

## 3. En önemli bulgu: hızı internetteki "geçiş" sayısı belirler

- Model evlere bölünürse üretilen her kelime her evden bir kez geçer. Bayrak yarışı gibi: koşucu sayısı arttıkça tur uzar.
- On geçiş ve 100 milisaniyelik bir hat, hesap başlamadan saniyede bir kelimenin altı demek. Otuz ayrı yerdeki otuz telefon en yavaş düzen.
- Bu yüzden kural: az ve büyük parça. Modeli tek başına taşıyabilen bir ev varsa bütün iş orada yapılır; bölmek yedek yoldur ve bekleyebilen işler içindir.

## 4. Büyük modeller ne kadar büyük

- Bugünün en iyi açık modelleri 150 ile 500 GB arası; tek bir katmanı bile çoğu telefonun belleğinden büyük.
- İyi haber: bu modeller her kelimede ağırlıklarının yalnız yüzde 3 ile 5'ine dokunuyor. Kütüphane gibi: raflar dolu ama her soruda birkaç kitap açılıyor.
- Kula'nın bölme yöntemi modelin türüne bakmıyor, hesabın kendisini bölüyor. Bu yüzden yeni bir model geldiğinde altyapı değişmez; yalnız motorun (llama.cpp) o modeli tanıyan sürümü gerekir.

## 5. İki telefon internette birbirini nasıl bulur

- Cihaz bir adresi değil, bir anahtarı arar. Adres yalnız bir ipucudur; yanlış adres zaman kaybettirir, güveni bozmaz.
- Önce doğrudan yollar denenir: aynı ağ, IPv6, modemin açtığı kapı. Olmazsa "delik açma": iki taraf aynı anda birbirine paket yollar, iki modem de bunu kendi başlattığı konuşma sanıp içeri alır.
- Bunun için ikisini tanıştıran biri gerekir. Önerimiz: bu kişi çemberden bir cihaz olsun, dışarıdan bir şirket değil.
- Ölçümlere göre delik açma çoğu zaman tutuyor (yaklaşık yüzde 70 ile 90), ama her zaman değil.

## 6. Doğrudan olmazsa: yedek yol

- En güvenli yedek: çemberden, evde duran ve dışarıdan ulaşılabilen bir bilgisayar postacılık yapar. Zarf kapalıdır; postacı yalnız kimden kime ve ne kadar gittiğini görür.
- Çemberde böyle bir ev hiç yoksa geriye yabancıların makineleri kalır: Tor (en gizli, en yavaş) ya da iroh'u yazan şirketin aktarıcıları (kolay, ama kimin kiminle konuştuğunu görür).
- İkisi de içeriği okuyamaz, ikisi de dışarıya bağlanmak demektir. Varsayılan olarak kapalı; karar senin.

## 7. Kimlik ve anahtarlar

- Her cihazın kendi anahtarı kalıyor. Üstüne bir "ev anahtarı" geliyor: evin cihaz listesini o imzalar. Eve yeni telefon eklemek ya da kayıp telefonu çıkarmak tek imza olur.
- Uzaktaki arkadaşla eşleşme: davet bir mesajla gider, sonra iki kişi telefonda aynı altı rakamı birbirine okur. Araya giren olursa rakamlar tutmaz.
- Ev anahtarı evdeki iki cihazda ve bir kâğıtta durur. İlk sürümde her şey kaybolursa arkadaşlarla yeniden eşleşilir; az kişiyle bu kabul edilebilir.

## 8. Bir arkadaşın cihazı ne görür

- Açık konuşalım: modelin bir dilimini hesaplayan cihaz, önünden geçen sayılardan konuşmayı geri çıkarabilir. Bunu gösteren yayınlar var; telefonlarda bunu engelleyecek kilitli bir oda da yok.
- O yüzden sınır teknik değil, bir kuraldır: iş ne kadar uzağa gidebilir, bunu kişi seçer; yazılım asla genişletmez. Hassas iş evden çıkmaz.
- Yine de zorlaştırıyoruz: metnin girdiği ve çıktığı uçlar evde kalır, arkadaşlar yalnız ara katmanları görür ve birbirlerini görmez; iş bitince cihazda hiçbir şey kalmaz.

## 9. Yanlış cevap veren cihaz nasıl yakalanır

- Engellemek mümkün değil, yakalamak ucuz.
- Araya cevabını önceden bildiğimiz gizli sorular karıştırılır; cihaz hangisinin sınav olduğunu bilemez. Tutmayan cevap kanıttır.
- Sonra: aynı dilimi ara sıra iki eve birden yaptırmak ve sonuçların "parmak izini" karşılaştırmak. Yakalanan cihaz, imzalı kanıtla arkadaşlara bildirilir. Bunların temeli kodda zaten var.

## 10. Telefonun kuralı: şarjda ve Wi-Fi'da

- Android, ekranı kapalı ve prizde olmayan telefonun ağını kısar; mobil veride telefona dışarıdan ulaşmak da zaten zordur.
- Çözüm basit: bir telefon başkaları için yalnız şarjdayken ve ev Wi-Fi'ındayken çalışır. O zaman uyku kısıtı yok, veri faturası yok, pil derdi yok.
- Bu zaten telefonun boş olduğu zaman: gece. Isı ve pil sağlığı konusunda son söz hep telefonun sahibindedir.

## 11. Senden beklenen kararlar

- Modelin arkadaş evleri arasında bölünmesine izin (şimdiye kadar "internette bölme yok" demiştik). Öneri: evet, yavaş yol olarak.
- iroh kütüphanesini kullanmak (başkasının yazdığı kod, başkasının sunucusu değil). Öneri: iki haftalık denemeyi geçerse evet.
- Çemberden bir ev bilgisayarının tanıştırıcı ve postacı olması. Öneri: evet, yalnız prizdeki bilgisayarlar, sınırlarla.
- Hiçbir ev ulaşılabilir değilse dış yardım (Tor ya da şirket aktarıcıları). Öneri: şimdi karar verme, saha testinin sayılarını bekle.

## 12. Karar: şimdilik bunu yapalım

- **Önce tek bir şeyi kuralım: "kula bağı".** Eşleşmiş iki cihaz arasında, anahtarla aranan, önce doğrudan giden, olmazsa çemberdeki bir bilgisayar üzerinden geçen şifreli hat. Mevcut kapı bunun içinde aynen çalışır; modelin iç bağlantısı ağa hiç açılmaz.
- **Üstüne evler arası bölmeyi açalım**, en az geçişle yerleştiren bir planlayıcıyla; ilk hafta eldeki kodla iki ev arasında gerçek hız ölçülür, sekiz dokuz hafta sonunda en az iki ülkede arkadaşlarla saha testi yapılır.
- **Erteleyelim:** yabancılar, herkese açık adres defterleri (DHT), Tor, şirket aktarıcıları, ödeme, kriptografik kanıtlar, Bluetooth.
- **Neden:** hız da güvenlik de bu hatta düğümleniyor. Hat model tanımaz; yarın hangi model gelirse gelsin aynı kalır. Dışarıdan hiçbir sunucu gerektirmez, yani "dışarıya bağlanmayan ağ" ilkesi bozulmaz. Ve beklentiyi dürüst kurar: çok büyük bir model evlere bölününce saniyede yaklaşık bir kelime verir; sohbet için modeli tek başına taşıyan ev, gece işleri için bütün çember.
