# planlayıcı ve küme simülatörü

Tek kaynak: `app/src/llm/sim/model.ts` (saf TS, import'suz). Aynı dosya `node/src/sim.ts` olarak
bilgisayar tarafında durur; `node/test/planner.test.ts` iki dosyanın bayt bayt aynı olduğunu ve
ikisinin de `tools/planner-vectors.json`'daki planları ürettiğini kontrol eder. Profiller
(cihaz, ağ, model şekilleri) `app/src/llm/sim/profiles.ts`'de.

## model

Birimler: MB = 1024² bayt, bellek bant genişliği GB/s, ağ MB/s, süre ms.

**Bellek ihtiyacı** (fit.ts ile aynı sayı):
`need = dosya × 1.05 + kv_mb_per_1k × ctx / 1024 + 300`.
Eskiden `dosya × 1.1` idi ve ctx'i bilmiyordu; 7B'de ctx 2048 → 8192 arası 336 MB fark eder.

**Cihazlara dağılan baytlar**: `spread = dosya × 1.05 − embed + kv(ctx)`. `embed = vocab × hidden ×
bayt/param` (Qwen3 0.6B Q8'de ~148 MB, Gemma 1B'de ~160 MB): giriş gömmesi ve çıktı katmanı her
zaman yöneticide kalır (`kula_llama.cpp` zaten `output|token_embd` tensörlerini CPU'ya sabitler;
plan artık bunu bellek olarak da sayar). Yönetici en az `embed + 300` tutmalı; tutamıyorsa `local`
hatası.

**Tek başına hız**: `tok/s = bw × eff / model_gb`. `eff` varsayılan 0.6 (passport COMBINE.efficiency);
Mac M1 için ölçülen 0.3.

**Bölünmüş modda token süresi**: bir token cihazlarda *sırayla* hesaplanır, bu yüzden
`perTokenMs = Σ_i (cihazdaki_gb_i / (bw_i × eff_i)) + işçi_sayısı × (3 × rtt + 2 × hidden × 4 B / ağ)`.
Üç gidiş-dönüş: girdiyi yaz, hesapla, çıktıyı oku (llama.cpp RPC). Aktivasyon f32 ve iki yönlü
(yöneticiden işçiye, işçiden yöneticiye; işçiler arası aktarım da yönetici üstünden geçer).
Sonuç: eşit hızlı cihazlar arasında paylaşmak zaman kazandırmaz (toplam akan bayt aynı), yalnızca
*daha hızlı* cihaza taşınan bayt kazandırır ve her işçi bir "hop" bedeli ekler.

**Yükleme süresi**: `5 s + işçi_baytları / ağ + yerel_baytlar / 300 MB/s`.

**Uzmanlar karışımı (MoE, 10.11.2026)**: `SimModel.activeShare` = bir token'ın okuduğu ağırlık payı
(katalogda `active_b / params_b`, ör. Qwen3 30B-A3B için 3.3 / 30.5; kula-node'da gguf'un tensör
tablosundan: `*_exps` tensörlerinin `expert_used_count / expert_count`'u, gerisi tam). Hız bu payla
hesaplanır (`readMb = dosya × 1.05 × pay`; bölünmüşte blokların payı `blockShareOf`), bellek ve
yükleme her zaman tüm dosyayla: her uzman bellekte olmalı. Bölünmüş modda token başına ağ bedeli
(aktivasyon + 3 gidiş-dönüş) MoE'de küçülmez; hesap küçüldüğü için hop'lar token'ın daha büyük kısmı
olur, yani MoE'yi bölmek aynı boyuttaki yoğun modeli bölmekten daha az kazandırır. `fit.ts`
(`activeShare`, `FitInput.active`) aynı kuralı izler.

**Ayrı mod**: cihaz başına `tok/s`, istem işleme `8 × tok/s`; istek süresi
`prompt/promptTps + maxTokens/tps`; dağıtıcı her isteği *beklenen bitiş* en erken olan cihaza verir
(`busyUntil + istek süresi`). Kısa istek meşgul hızlı cihazı beklemek yerine boş yavaş cihaza gider;
uzun istek (prompt + çıktı > 512 token) hızlıyı bekler. İlk token gelmeden düşen eş 5 dk dışarı
alınır, istek bir kez başka cihaza verilir; ölçülen her cevap cihazın tok/s'sini günceller.

## planlayıcı kuralları (planShares)

1. İşçiler hıza göre (`bw × eff`) sıralanır; her k için "en hızlı k işçi" adayı denenir.
2. Sığmıyorsa: `spread` en hızlı cihazdan başlayarak kapasiteye kadar doldurulur (PrivateLM kuralı),
   yönetici payına `embed + 300` eklenir.
3. Sığıyor ama kullanıcı paylaşmak istiyorsa: baytlar hız oranında dağıtılır (su doldurma:
   dolan cihazın fazlası diğerlerine aynı oranda) — telefonun RAM'i boşalsın diye paylaşılır.
4. Adaylardan token süresi en kısa olan kazanır → yavaş ağda daha az cihaz.
5. `aloneFaster`: bölünmüş plan tek başınadan 1.15× hızlı değilse doğru söz "tek başına daha hızlı".
   Kullanıcının "yine de paylaş" seçimi yine uygulanır; ekran sayıyı gösterir.
6. Kapasiteler değişmedi: yerel boş RAM × 0.7, işçi × 0.75; bilinmeyen eş 2000 MB, 4 GB/s.

## kalibrasyon (ölçülen gerçekler → test)

| ölçüm | simülatör | test |
|---|---|---|
| Mac M1 8 GB, llama-server, Qwen3 0.6B Q8: 34 tok/s | 32.6 tok/s (eff 0.3) | `sim.test.ts` ±8 % |
| emülatör ↔ Mac, 27/29 katman Mac'te, 415 MB tünelden ~1.3 MB/s, yükleme 335 s | 445 MB · 347 s | ±10 % / ±8 % |
| Galaxy S25+: 65.9 GB/s, bütçe 1.82 GB, Gemma 3 1B çalıştı | need 1.15 GB < 1.82 GB, ~50 tok/s | sığar |
| emülatör: 2.4 GB RAM, bütçe 0.54 GB | en küçük model bile tek başına sığmaz | sığmaz |
| ayrı mod toplu test: 8 istem iki cihaza dağıldı | simulateApart 8 istek → ikisi de pay alır | dağılır |

## önce / sonra

Aynı maliyet modeliyle puanlanmış; "önce" eski `planSplit` (dosya × 1.1, en hızlıdan doldur,
paylaşırken hız oranı). Üretir: `node --import tsx ../tools/planner-eval.ts` (node/ içinden).

| case | model | before: shares (mb) | before tok/s · load | after: shares (mb) | after tok/s · load | note |
|---|---|---|---|---|---|---|
| emulator + mac, nat | qwen3 0.6b | emulator 101 · mac m1 570 | 16.5 · 307.4 s | emulator 448 · mac m1 604 | 18.3 · 360.5 s | before: no room for the output layer here |
| s25+ alone fits, share with 3 phones | qwen2.5 1.5b | s25+ 666 · pixel 8 283 · mid 6gb 142 · old 4gb 81 | 11.9 · 20.8 s | s25+ 1161 · pixel 8 314 | 22.2 · 17 s | alone 36.2 tok/s is faster; fewer devices |
| s25+ + mac, wi-fi 5 | llama 3.2 3b | s25+ 1042 · mac m1 1076 | 12.9 · 37.6 s | s25+ 1852 · mac m1 694 | 14.1 · 29 s | alone 20 tok/s is faster |
| s25+ + mac, wi-fi 2.4 | llama 3.2 3b | s25+ 1042 · mac m1 1076 | 10.3 · 183.1 s | s25+ 1852 · mac m1 694 | 11.1 · 126.5 s | alone 20 tok/s is faster |
| mid 6gb + 3 phones, 7b, wi-fi 5 | qwen2.5 7b | s25+ 4875 · pixel 8 38 | 6.4 · 145.3 s | mid 6gb 586 · s25+ 4516 | 6.8 · 145.3 s | before: no room for the output layer here |
| mid 6gb + 3 phones, 7b, hotspot | qwen2.5 7b | s25+ 4875 · pixel 8 38 | 4.6 · 528.5 s | mid 6gb 586 · s25+ 4516 | 5.7 · 528.5 s | before: no room for the output layer here |
| mid 6gb + 4090, 7b, wi-fi 5 | qwen2.5 7b | 4090 4913 | 20 · 145.3 s | mid 6gb 586 · 4090 4516 | 20 · 145.3 s | before: no room for the output layer here |
| mid 6gb + 4090, 7b, ctx 8192 | qwen2.5 7b ctx 8192 | 4090 4913 | 20 · 145.3 s | mid 6gb 586 · 4090 4852 | 20 · 145.3 s | before: no room for the output layer here |
| old 4gb + pixel, 3b, wi-fi 2.4 | llama 3.2 3b | pixel 8 2118 | 5.9 · 349.5 s | old 4gb 507 · pixel 8 2039 | 5.9 · 349.5 s | before: no room for the output layer here |

Okuma: eski planlayıcı yöneticiyi yavaş cihaz gördüğünde ona 0 MB verebiliyordu (çıktı katmanı
oraya sığmaz, yükleme çöker); yeni plan her zaman `embed + 300` ayırır. Paylaşırken eski kural 4
cihaza dağıtıyordu, yeni kural hop bedelini sayıp 1–2 cihazda kalıyor ve "tek başına daha hızlı"
diyor. 2.4 GHz'de aynı plan 5 GHz'e göre daha az işçi seçer (vektör 6–7).

## varsayımlar

- `eff = 0.6` telefonlar için **ölçülmedi**; passport'un COMBINE sabiti.
- Ağ profilleri (`NETWORKS`): wi-fi 5 GHz 30 MB/s · 3 ms, 2.4 GHz 5 MB/s · 8 ms, hotspot 8 MB/s ·
  12 ms, emülatör NAT 1.3 MB/s · 2 ms (yalnız sonuncusu ölçüldü). Uygulama şimdilik 5 GHz varsayar.
- Token başına 3 RPC gidiş-dönüşü ve f32 aktivasyon: llama.cpp'nin RPC arka ucundan okundu, telefonda
  sayılmadı.
- İstem işleme decode'un 8 katı; CPU'da 5–20 arası değişir.
- Disk okuma 300 MB/s, sabit 5 s açılış.
- Ayrı modda istem uzunluğu karakter/4 ile kestirilir.

## telefonda ölçülecekler (ölçülen her satır modeli düzeltir)

1. **S25+ tok/s** (Gemma 3 1B ve Qwen3 0.6B, sohbet ekranı zaten tps verir) → telefon `eff`'i.
2. **Gerçek wi-fi'de yükleme süresi** (iki telefon, 5 GHz; `model.loaded` satırı loadMs verir) →
   ağ MB/s.
3. **Bölünmüş modda tok/s** aynı kurulumda → hop bedeli (rtt × 3 doğru mu?).
4. **Prompt işleme hızı** (firstMs / istem token sayısı) → PROMPT_FACTOR.
5. **İşçinin gerçek bellek kullanımı** (`split[].mb`) → FILE_FACTOR 1.05 ve embed hesabı.
6. 2.4 GHz ve hotspot'ta aynı üç ölçüm.
7. Pixel 8 / orta segment passport'ları (bw, bütçe) → `DEVICES` tablosu tahmin yerine ölçüm.

Ölçümler `docs/ILERLEME.md`'ye yazılınca `profiles.ts` ve `sim.test.ts`'deki kalibrasyon satırları
güncellenir; vektörler `tools/planner-vectors.gen.ts` ile yeniden üretilir.
