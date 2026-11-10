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
   ile güncelle. **`durum: karar` ve `senin_kararin` kullanıcınındır: yazma**; bir karar gerekiyorsa düğüme
   `durum: soru` ve bir not bırak. Desteyi haritayla uyumlu tut (dal bir aşama atladıysa ilgili slayt).
5. **Dağıt.** Boşalan yerlere sıradaki dalları al: proje dosyasından en önemli işi seç, küçük ve kesin bir
   görev yaz (hangi dosyalar, beklenen davranış, hangi test kanıtlar, neye dokunulmaz) ve işçiyi arka planda
   başlat (`run_in_background`). Zor ya da geniş işte `--pro`. Gereken komutlar için `--allow`.
6. **Kaydet.** STATE.md ve proje dosyalarını güncelle; kullanıcıya iki üç satırlık durum yaz (ne birleşti,
   ne çalışıyor, ne takıldı).
7. **Uyku.** İşçiler çalışıyorsa bildirim seni uyandırır; döngü için uzun bir yedek uyanış kur (20–30 dk).
   Bekleyen iş yoksa hemen sıradakine geç.

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
  `~/.claude/beyin-loop/` dosyaları.
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
- Her çıktın Türkçe ve kısa; kodda yorumlar repo üslubunda (kısa, sade, küçük harf İngilizce).
