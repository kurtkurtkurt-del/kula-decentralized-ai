# beyin döngüsü: the brain'i saatlerce kuran oturumun talimatı

Bu dosya, yan sohbette **döngü hâlinde** çalışan oturumun talimatıdır. Her uyanışta baştan okunur.
Kullanıcı (Ahmet) bu talimatı kendisi yazdırdı; aşağıdaki izinler onun iznidir.

## nasıl başlatılır (kullanıcı için)

Yan sohbette, kula-decentralized-ai klasöründe, sırayla iki mesaj:

```
/deepseek
```

```
/loop docs/beyin/LOOP.md dosyasındaki talimatla bir tur çalış: durumu oku, sıradaki işleri dağıt, gelenleri denetle, haritayı işle, kaydet.
```

Durdurmak: `/loop` döngüsüne "dur" demek ya da oturumu durdurmak. Kod kendiliğinden hiçbir yere gönderilmez.

## amaç

The brain'i (beyin) ciddi biçimde kurmak. Beyin haritasındaki ve uygulamalardaki **her kategoriyi**
ayrı bir proje olarak ele al: derinleştir, güçlendir, sına, belgele. Harita ile kod birlikte büyüsün:
harita kodda olanı, kod haritadaki kararları göstersin.

## önce oku (ilk turda bir kez, sonra gerektikçe)

- `CLAUDE.md` (kural: vendor ve llama.cpp ağacına el sürülmez, RPC 127.0.0.1'de kalır, yalnız `npm run apk`)
- Hafıza notları: **beyin bağımsızdır** (kula onun ilk müşterisi; kula beyin olmadan tam çalışır, beyin tek
  bir isteğe bağlı arayüzle bağlanır), **dış ağ yok** (cihazlar doğrudan konuşur; barındırılan aktarıcı,
  bulut tüneli önerme), beyin = güvenlik hizmeti vizyonu (aylık $0.99; **ödeme kodu yazma**, sorulmadıkça).
- `docs/BEYIN.md`, `docs/AUDIT.md` (güvenlik raporu), `docs/GATE.md`, `docs/PLANNER.md`, `docs/NIGHT.md`,
  `docs/DURUM.md`, `~/Desktop/claudecode/beyin/README.md` ve `check/spec/PROTOCOL.md`.
- Kod: `node/src/godseye/` (Mac'teki 12 dal; `types.ts` tasarımın kendisi; god's eye **kula'dan hiçbir şey
  import etmez**, bunu bir test korur), `node/src/ui/godseye-feed.ts` (tek temas noktası),
  `node/test/godseye*.test.ts`; telefonda `app/src/app/(tabs)/brain.tsx`, `app/src/components/brain/`,
  `app/src/llm/brainlog.ts`, `app/src/llm/trust.ts`.
- **Beyin haritası** (artifact + veritabanı): https://claude.ai/artifact/XdUbnR74Y1gTzeBfcZCe7K
  ve 18 slaytlık deste: https://claude.ai/artifact/1xG19vLYVT9UmrH1atUxd1. `ArtifactData` ile oku:
  koleksiyonlar `dugumler` (düğümler: ust, baslik, aciklama, durum fikir|soru|karar|sonra, asama ""|v0|v1|v2,
  sira, yazan, guncel), `notlar` (dugum, metin, yazan, zaman), `detaylar` (doc id = düğüm id: ozet,
  onem {puan 1-3, neden}, yontem, insa, karar, kaynaklar [{t,u,n}], notlar, senin_kararin, karar_zamani),
  `ceviri/tr`, `ceviri/de`. Önce kullanıcının yeni not ve kararlarını topla (`yazan` sen değilsen).

## nerede ne yazılır

`/deepseek` açıkken bir kanca, senin (Opus) git repolarındaki dosyalara kendin yazmanı engeller (en çok 3
satırlık küçük düzeltmeler hariç); bunu dolanma. Bu yüzden:
- **Döngünün kendi defteri repo dışında:** `~/.claude/beyin-loop/` (STATE.md, README.md, `<n>-<id>.md`
  proje dosyaları). Bunları sen yazarsın.
- **Repodaki her şeyi (kod, test, `docs/`) DeepSeek işçisi yazar;** sen görevini verir, diff'ini okursun.
- Haritaya ve desteye `ArtifactData` ile sen yazarsın.

## düzen: 12 dal, 12 proje

Dallar (`node/src/godseye/types.ts` BRANCHES ile aynı sıra): 1 senses, 2 memory, 3 forecast,
4 learning, 5 connections, 6 planner, 7 executor, 8 trust, 9 limits, 10 models, 11 review, 12 advisor.
Telefonun brain sekmesindeki bölümler de bu dallara bağlanır (hangisinin hangi dala ait olduğunu ilk turda
çıkar ve `~/.claude/beyin-loop/README.md`'ye yaz).

Her dal **ayrı bir projedir**:
- Proje dosyası `~/.claude/beyin-loop/<n>-<id>.md`: amaç (haritadaki düğümleri ve `detaylar`ından), bugünkü
  durum (kodda ne var, ne yok), yöntem (matematik/algoritma, haritadaki `yontem`), sıradaki 3 iş, açık
  sorular, yapılanlar (tarih, commit), DeepSeek oturum kimliği.
- Kendi git worktree'si ve dalı: `.claude/worktrees/beyin-<id>`, dal `beyin/<id>`, `kula-main`'den.
- Kendi alt ajanı: o dalın kod işi için bir **DeepSeek işçisi** (`~/.claude/bin/deepseek-worker -C <worktree>`,
  oturumu `--resume` ile sürdür, kimliği proje dosyasında tut); araştırma ve inceleme için gerektiğinde
  bir Claude alt ajanı (Agent aracı: Explore ya da Plan, yalnız okur). Bir dala iki işçi aynı anda girmez.
- Aynı anda en çok **4 dal** çalışsın (denetimin kalitesi için). Dalları önem sırasıyla döndür:
  haritadaki `onem.puan` yüksek olan ve kullanıcının işaretlediği önce; hiçbir dal üç turdan uzun aç kalmasın.

## bir tur

1. **Durum.** `~/.claude/beyin-loop/STATE.md`'yi oku (yoksa oluştur): hangi dallar çalışıyor, hangi işçiler bekleniyor,
   son birleştirme, son gate. Haritada kullanıcının yeni notları/kararları var mı bak.
2. **Gelenleri denetle.** Biten her işçi için: raporu oku, sonra **gerçek `git diff`'i** oku (rapora güvenme),
   testleri çalıştır: `cd node && npx tsc --noEmit -p tsconfig.json && npm test` (godseye testleri dahil);
   telefona dokunduysa `cd app && npx tsc --noEmit && npx expo lint && npx jest`; Kotlin'e dokunduysa
   `cd app/android && ./gradlew :kula-llama:testReleaseUnitTest :kula-llama:compileReleaseKotlin`.
   Kapsam taşması, yasak yola dokunma, sahte test, sessizce atlanan hata ara. Yanlışsa aynı işçiye somut
   düzeltme gönder; üç turda düzelmezse o işi bırak, nedenini proje dosyasına ve STATE.md'ye yaz.
3. **Birleştir.** Temiz ve sınanmış dal işini dalın kendi worktree'sinde commit'le (mesaj sonu:
   `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`), sonra `kula-main`'e `--no-ff` ile birleştir,
   birleşik hâlde testleri yeniden çalıştır. Her 3 birleştirmede bir `cd backend && npm run gate`
   (temiz ağaçta). Gate kırılırsa önce onu düzelt, yeni iş dağıtma.
4. **Haritayı işle.** Her birleşen iş için haritada: ilgili düğümün `aciklama`sı ("Built · …" ile kodda
   olanı söyle), `asama` (v0/v1/v2), `detaylar` (`insa`: ne kuruldu, hangi dosyalar, hangi testler;
   `yontem`: gerçekten kullanılan formül, `$ ` satırlarıyla), kısa bir `notlar` kaydı (`yazan: "claude"`,
   tarih). Yeni düğüm eklersen `ceviri/tr` ve `ceviri/de` girdilerini de yaz. Var olan belgeyi `if_version`
   ile güncelle. **Yöntem kararını sen verirsin** (aşağıda "araştır ve karar ver"): `detaylar.karar`'a
   kararı, `kaynaklar`a dayanaklarını yaz, `durum: karar` yap ve bir not bırak ("claude'un kararı, tarih;
   değiştirebilirsin"). **`senin_kararin` ve `karar_zamani` kullanıcınındır:** onlara yazma; kullanıcı bir
   düğümde karar vermişse o geçerlidir, kendi kararınla ezme, gerekirse yalnız not düş. Tasarım sınırını
   aşan kararlar (aşağıda) yine soru olarak kalır. Desteyi haritayla uyumlu tut.
5. **Dağıt.** Boşalan yerlere sıradaki dalları al: proje dosyasından en önemli işi seç, küçük ve kesin bir
   görev yaz (hangi dosyalar, beklenen davranış, hangi test kanıtlar, neye dokunulmaz) ve işçiyi arka planda
   başlat (`run_in_background`). Zor ya da geniş işte `--pro`. Gereken komutlar için `--allow`.
6. **Kaydet.** STATE.md ve proje dosyalarını güncelle; kullanıcıya iki üç satırlık durum yaz (ne birleşti,
   ne çalışıyor, ne takıldı).
7. **Karar özeti (30 dakikada bir).** Son özetten bu yana 30 dakika geçtiyse (zamanı STATE.md'de tut),
   aşağıdaki "karar özeti"ni gönder.
8. **Uyku.** İşçiler çalışıyorsa bildirim seni uyandırır; döngü için yedek uyanışı **en çok 30 dakika**
   sonraya kur (`ScheduleWakeup`), ki özet aksamasın. Bekleyen iş yoksa hemen sıradakine geç.

## karar özeti: 30 dakikada bir kullanıcıya

Kullanıcı aldığın ana kararları 30 dakikada bir görmek istiyor. Her özet:
- **Başlık:** `beyin · karar özeti · <saat>` ve bir satırda o arada ne oldu (kaç dal çalıştı, kaç birleştirme,
  gate durumu).
- **Ana kararlar** (en önemlisi önce, en çok 8): hangi dal / düğüm, ne karar verildi, bir cümle neden,
  seçilmeyen ana seçenek, dayandığı kaynak (başlık + adres). Yalnız gerçek kararlar: yöntem seçimi, mimari,
  güvenlik ayarı, bir eşik ya da formül, bir şeyi yapmama kararı. Rutin ilerleme buraya girmez.
- **Senin kararını bekleyenler:** haritada `durum: soru` bıraktığın her şey, bir satırda, seçenekleriyle.
- **Değiştirmek istersen:** haritadaki ilgili düğümün adı (kullanıcı oraya `senin_kararin` yazar ya da not
  bırakır; bir sonraki turda sen okuyup uyarsın).
- Yeni karar yoksa tek satır: "bu yarım saatte yeni karar yok; şunlar sürüyor: …".

Gönderiş:
1. Özeti **sohbete doğrudan yaz** (asıl kanal; kullanıcı telefondan Remote Control ile bakabilir).
2. Aynı metni `~/.claude/beyin-loop/KARARLAR.md`'nin **en üstüne** ekle (birikimli, en yenisi üstte) ve o
   dosyayı `SendUserFile` ile `status: "proactive"` gönder.
3. `PushNotification` aracı varsa kısa bir bildirim: "beyin: N yeni karar, M soru seni bekliyor".

## bağlantı: bugün kablo ve wi-fi, yarın doğrudan internet

Bugün cihazlar **USB kablo** ve **aynı wi-fi / telefonun hotspot'u** üzerinden doğrudan konuşur (kapı, TLS 1.3,
pinli sertifikalar; `docs/GATE.md`). **Hedef: ileride cihazlar internet üzerinden de doğrudan bağlanacak**
(farklı evler, farklı ağlar). Her dalı buna göre tasarla:
- Bağlantı türü tek bir değer değil, bir boyut olsun (kablo / wi-fi / internet); gecikme, bant genişliği,
  kopma ve maliyet varsayımları türe göre değişsin (planner, forecast, connections, executor, trust).
- İnternet yolu için güvenlik baştan düşünülsün: NAT arkasındaki cihazların birbirini bulması, uçtan uca
  şifreleme, kimlik ve eşleşmenin internette nasıl korunacağı, kötü niyetli uzak cihaz. Bunları araştır,
  `connections` ve `trust` projelerinde bir tasarım ve karar olarak yaz.
- **Sınır:** kula'nın temeli "dışarıdaki bir sunucuya bağımlı olmamak". Birbirini bulma (rendezvous), STUN /
  TURN, aktarıcı gibi üçüncü bir makine gerektiren her seçenek **kullanıcının kararıdır**: seçenekleri ve
  bedelini haritada `durum: soru` olarak bırak, kendin kurma. Doğrudan yollar (IPv6, kullanıcının kendi
  makinesi, delik açma) önce gelsin. İnternet bağlantısının kodunu, kullanıcı karar verene kadar yazma; tasarımı,
  arayüzleri ve testlerini hazırla.

## araştır ve karar ver (her düğüm için)

Her dal projesine başlarken ve her düğümün yöntemini seçmeden önce **internette araştır**, en güncel
yöntemleri bul (2025–2026 öncelikli), karşılaştır, **karar ver**:
- Konular: güvenlik ayarları (kimlik, eşleşme, şifreleme, anahtar saklama, iptal, saldırı yüzeyi, uzaktaki
  kötü niyetli cihaz); LLM denetimi ve gözetimi (bir işin çalışmadan önce incelenmesi, istem enjeksiyonu,
  çıktının doğrulanması, başkasının cihazında çalışan işin güvenliği, gözetim/izleme, anormallik tespiti);
  learning loop (tahmin-gerçek karşılaştırması, kalibrasyon, çevrimiçi öğrenme, sapma tespiti, yerel ve
  gizliliği koruyan öğrenme); tahmin (cihaz müsaitliği, hız, enerji); yerleştirme ve zamanlama; model bakımı.
- Araçlar: `WebSearch` (yeni ya da niş konuda `extended`), sayfayı okumak için web-fetch alt ajanı. Aynı turda
  birden çok arama gönder. Sorgulara kullanıcının adını, e-postasını, projenin özel ayrıntılarını koyma.
- Kaynak kalitesi: makale, standart, büyük projelerin belgeleri, güncel güvenlik kılavuzları; tarihini yaz.
  Pazarlama yazısına dayanma. Kaynakları `detaylar.kaynaklar`a `{t: başlık, u: adres, n: neden önemli}` olarak koy.
- Karar kaydı (proje dosyasına ve haritaya): seçenekler, seçilen, neden, bedeli, ne zaman yeniden bakılacağı.
  Karar kod hâline gelince `insa` ve `asama` güncellenir.
- Kararın kula'ya uygun olsun: telefonda çalışabilecek kadar hafif, yerel, dışarıya bağımlı olmayan, açıklanabilir.

## her dal için "güçlendirme" ne demek

Her dalda sırayla:
- **Ölç ve yaz:** dalın bugün ne yaptığı, sınırları, hangi veriyi kullandığı (proje dosyasına).
- **Yöntemi ciddileştir:** haritadaki `yontem`i gerçek bir algoritmaya çevir (ör. forecast: cihaz başına
  saat-gün profili ve üstel düzeltme, belirsizlik aralığıyla; learning: tahmin-gerçek hatası, kalibrasyon;
  limits: sıcaklık/pil kuralları ve histerezis; planner: yerleştirmenin maliyet modeli; review: işi
  çalışmadan önce denetleme kuralları; trust: güven raporunun derinleşmesi, anormallik tespiti).
  Formülü kodda yorumla, haritada `$ ` satırıyla yaz.
- **Sına:** gerçekçi senaryolarla birim testleri (kenar durumları, bozuk veri, zaman atlaması).
- **Göster:** Mac sayfasındaki dal sayfası ve telefondaki karşılığı, dalın gerçekten ne bildiğini sade
  söylesin; uydurma sayı yok, "henüz bilmiyorum" dürüstçe görünsün.
- **Belgele:** proje dosyası, gerekiyorsa `docs/BEYIN.md`/`AUDIT.md`/`PLANNER.md`.

## değişmez kurallar

- **İzinli:** okumak, worktree ve `beyin/*` dalları açmak, DeepSeek işçisi çalıştırmak, testler, gate,
  yerel commit ve `kula-main`'e yerel birleştirme, beyin haritası ve destede yazmak (yukarıdaki sınırlarla),
  `~/.claude/beyin-loop/` dosyaları, kullanıcıya karar özeti ve bildirim göndermek.
- **Yasak:** `git push`, release yayınlamak, siteyi değiştirmek, apk derlemek, bir şey silmek (dal, dosya,
  harita düğümü; gereksiz görünen düğümü `durum: sonra` ve bir notla işaretle), `--no-verify`, guard
  hook'unun etrafından dolaşmak, vendor/llama.cpp ağacı, ödeme/abonelik kodu, internete çıkan bir servis.
- **Tasarım sınırları kullanıcınındır:** god's eye bugün "izler, hiç dokunmaz" (cihazlara bağlanmaz, model
  yüklemez). Bir dalın harekete geçmesi gerekiyorsa (executor, limits, planner) **önce öneri olarak**
  yaz: haritada `durum: soru` ve not, STATE.md'de "kullanıcının kararı bekleniyor". Kendin aşma.
- God's eye kula'dan import etmez; kula beyin olmadan çalışır. Bunları koruyan testleri kırma.
- Gizli bilgi yok: prompt, cevap, e-posta, anahtar, sertifika parmak izi hiçbir dalın notlarına, haritaya
  ya da loglara girmez.
- Bir şey üç turda düzelmezse, ya da test/gate sebebini bulamadığın biçimde kırılırsa: o dalı durdur,
  STATE.md'ye yaz, kullanıcıya kısa söyle, diğer dallarla devam et.
- **Kod tamamen İngilizce:** kod, adlar, yorumlar, testler, log ve hata satırları, arayüz metinleri (Mac sayfası,
  kula-node panosu), commit mesajları ve beyin haritası (veritabanı İngilizce; `ceviri/tr`, `ceviri/de` ayrı).
  `docs/` altında her belge kendi dilinde kalır (GATE, AUDIT, NODE... İngilizce; DURUM, ILERLEME Türkçe). Telefonda Türkçe ve Almanca yalnız çeviri dosyalarında (`i18n`)
  ve bilerek Türkçe olan verilerde (sesli komutlar, katalogdaki `tr` açıklamaları) bulunur. Yorumlar repo
  üslubunda: kısa, sade, küçük harf. İşçiye verdiğin her görevde bunu söyle; diff'te Türkçe görürsen geri gönder.
- **Kullanıcıya yazdıkların Türkçe ve kısa:** durum satırları ve 30 dakikalık karar özeti.
