# ölçüm takımı (bench) — `kula-bench/1`

Planlayıcı (`app/src/llm/fit.ts`, `cluster.ts`; `node/src/planner.ts`) bugüne kadar passport
değerleri ve kaba katsayılarla tahmin yapıyordu: `tok/s ≈ bant_genişliği × 0.6 / model_gb`,
sıcak telefon ×0.5, atlama başına 0.1 s. Bu belge iki tarafın da ürettiği tek ölçüm biçimini
anlatır: **`tools/bench-schema.json`** (JSON Schema draft-07, `$id: kula-bench/1`). Telefon
(`ayarlar → ölçüm`, `app/src/app/bench.tsx`) ve bilgisayar (`kula-node bench`) aynı json'u yazar;
planlayıcı bu json'dan okuduğu tok/s'yi katsayı yerine kullanır (aşağıda "nasıl kullanılır").

Doğrulama: her iki tarafta bağımlılıksız küçük bir denetleyici var (`node/src/benchschema.ts`,
`app/src/llm/benchschema.ts`, aynı dosya); sonuç yazılmadan önce şemaya karşı denetlenir, testler de
şemayı kullanır (`node/test/bench.test.ts`, `app/src/__tests__/bench.test.ts`). Uygulamadaki
`app/src/llm/bench-schema.json` `tools/` altındakinin kopyasıdır (metro uygulama klasörünün
dışına çıkamıyor); testi ikisinin eşit olduğunu doğrular. Şemayı değiştirince iki dosyayı da
güncelle.

## nasıl çalıştırılır

```
# bilgisayar (node/): sonuç ~/.kula-node/bench/<tarih>.json, ekrana tablo
kula-node bench --model ~/models/qwen3-0.6b-q8.gguf            # yalnız bu bilgisayar
kula-node bench --model … --peer s25 --peer mac                 # eşlerle: kapı, tünel, ayrı, bölünmüş
kula-node bench --peer s25                                      # modelsiz: bellek + kapı + tünel
kula-node bench --model … --json > out.json                     # tabloyu değil json'u yaz
# --runs 3 --tokens 64 --ctx 2048 --mb 10 --bw <GB/s> --no-local --no-apart --no-split --model-url --out
```

Telefon: `ayarlar → ölçüm → şimdi ölç`. Hız ölçümleri için önce `modeller` sekmesinden bir model
yüklenmiş olmalı (hangi modda yüklüyse o mod ölçülür); yüklü model yoksa bellek ve eşler ölçülür,
hız kısımları `skipped` listesine düşer. Sonuç kartındaki **json paylaş** dosyayı dışa aktarır;
geçmiş 20 ölçüm telefonda kalır (kv-store `llm.bench`).

## alanlar

Birimler: süre **ms** (tam sayı), hız **tok/s**, bellek **MB** (1024²), bant genişliği **GB/s**
(bayt/ns), tünel **MB/s** (10⁶ bayt/s). Her istatistik (`stat`) `{ median, runs[] }`: tekrarların
hepsi ve medyanı; 3 tekrar varsayılan, ilk ısınma turu (8 token) sayılmaz.

| alan | tip | anlamı |
|---|---|---|
| `schema` | `"kula-bench/1"` | sürüm |
| `measured_at` | ISO 8601 | ölçümün bittiği an |
| `tool` | string | `kula-node 0.1.0` / `kula-app 1.0.0` |
| `device.id` | string | **planlayıcının anahtarı**: telefonda passport `device_id`, bilgisayarda hostname |
| `device.name`, `kind`, `os`, `soc` | | `kind` ∈ phone, tablet, pc |
| `device.cores`, `threads` | int | çekirdek; telefonda `fastCores` (bant genişliği ve üretimde kullanılan iş parçacığı) |
| `device.ram_total_mb`, `ram_free_mb` | int | ölçüm anında |
| `device.passport_bw_gbs` | number | passport'un söylediği bant genişliği; `memory.bandwidth_gbs` ile karşılaştır |
| `model` | obj / null | `name` **dosya adı** (planlayıcının ikinci anahtarı), `size_bytes`, `ctx`, `sha256`, `params_b`, `quant` |
| `memory.bandwidth_gbs` | number | kopya ölçümü: telefonda native `memBandwidth(fastCores)`, bilgisayarda `sysinfo.measureBandwidth` (64 MB ×4, bir iş parçacığı) |
| `memory.method`, `threads` | | nasıl ölçüldüğü |
| `local.mode` | alone/apart/split | ölçüm sırasında modelin bu cihazda çalıştığı mod |
| `local.gen_tps` | stat | üretim hızı: bilgisayarda `llama-server /completion` `timings.predicted_n/predicted_ms`; telefonda `generate` `tps` |
| `local.first_token_ms` | stat | ilk token süresi: bilgisayarda `timings.prompt_ms` (istem değerlendirmesi), telefonda `firstMs` |
| `local.prompt_tps` | stat / null | istem değerlendirme hızı; **telefonda null** (native taraf ayrı bildirmiyor) |
| `local.prompt_tokens` | int / null | istemin token sayısı |
| `local.load_ms` | int / null | modelin yüklenme süresi (bilgisayarda `/health`'e kadar; telefonda `loadModel.loadMs`) |
| `local.runs`, `tokens_per_run` | int | 3 × 64 varsayılan |
| `peers[].id` | string | eşin kalıcı id'si (`peers.json` / kv-store) — **planlayıcının anahtarı** |
| `peers[].gate_rtt_ms` | stat / null | api kanalında TCP + el sıkışma gidiş-dönüşü. Telefonda JS'ten ölçülür (köprü gecikmesi dahil, birkaç ms fazla) |
| `peers[].tunnel` | obj / null | `GET /blob?mb=N` tünelden: `bytes`, `ms`, `mb_per_s`. Null: eş `/blob` bilmiyor (eski sürüm) |
| `peers[].apart` | obj / null | eşin **kendi başına** hızı: `/chat` 3 × 64 token, `gen_tps`, `first_token_ms` eşin bildirdiği; `load_ms` `/load` süresi (telefonda null: model ölçümden önce yüklü) |
| `peers[].error` | string / null | kapı cevap vermediyse sebebi; o eş için başka alan dolmaz |
| `split` | obj / null | bölünmüş mod: `peers` kullanılan eş id'leri, `local_mb` yerel pay, `load_ms` rpc üzerinden yükleme, `gen_tps`, `first_token_ms`, `token_ms` = 1000 / medyan tok/s |
| `skipped[]` | `{what, who, why}` | çalıştırılamayan adımlar: `what` ∈ memory, local, peer, tunnel, apart, split |
| `notes[]` | string | ölçümle ilgili uyarılar (ör. telefonda prompt_tps yok) |

## nasıl yorumlanır

- **`memory.bandwidth_gbs` vs `passport_bw_gbs`**: ikisi yakınsa passport güvenilir. Telefonda ısınma
  ve thermal kısma ile ikinci ölçüm düşebilir; farklı günlerin medyanına bak.
- **Katsayı kontrolü**: `gen_tps × model_gb / bandwidth_gbs` ≈ verimlilik. Bizim varsayım 0.6
  (`COMBINE.efficiency`). 0.3–0.5 çıkıyorsa telefon bant genişliğini kullanamıyor (CPU sınırlı, küçük
  model, az iş parçacığı); 0.7+ ise önbellekte kalan küçük model. Birkaç cihaz + model çiftinden
  sonra katsayıyı değil, ölçümü kullanıyoruz zaten (aşağıda).
- **`first_token_ms`** istem uzunluğuyla büyür; aynı istem her yerde kullanıldığı için cihazlar arası
  karşılaştırılabilir. Bilgisayarda bu doğrudan istem değerlendirme süresidir.
- **`gate_rtt_ms`**: aynı wi-fi'da 2–20 ms normal; 100+ ms ise eş uzakta (tünel/VPN) ya da uyuyor.
  Bölünmüş modda her token için en az bir gidiş-dönüş ödenir: `token_ms ≥ gate_rtt_ms` beklenir.
- **`tunnel.mb_per_s`**: modelin eşe kopyalanma süresini ve bölünmüş modda ağırlık aktarımını belirler.
  Emülatör ↔ Mac'te 1.3 MB/s ölçülmüştü (335 s yükleme); gerçek wi-fi'da 5–30 MB/s beklenir.
  `model.size_bytes / (mb_per_s × 10⁶)` ≈ ayrı modda ilk yükleme süresi.
- **`split.token_ms`** ile `local.gen_tps` karşılaştırması bölünmenin bedelini gösterir: model yerelde
  sığıyorsa ve `1000/local.gen_tps < split.token_ms` ise bölme yavaşlatıyor (planlayıcı "burada tut"
  seçeneğini bunun için sorar).
- **`peers[].apart.gen_tps`** eşin tek başına hızıdır; ayrı modda küme hızı yaklaşık bu değerlerin
  toplamıdır (istemler paralel dağıtılır).

## planlayıcı nasıl kullanır

`app/src/llm/bench.ts`:

- `measuredTps(deviceId, modelFile)`: geçmişteki **en yeni** kayıtta, bu cihaz (`device.id` =
  passport `device_id`, ya da `peers[].id`) bu modeli (`model.name` = gguf dosya adı) **kendi başına**
  çalıştırmışsa (`local.mode` ≠ split, ya da `peers[].apart`) medyan `gen_tps`'yi döndürür.
- `fitOn` bu değer varsa `tps = { low: tps × 0.5, high: tps }` ve `measured: true` verir; yoksa eski
  bant genişliği formülü. Model ekranında etiket "beklenen hız" yerine "ölçülen hız", listede ✓.
- `effectiveBw(deviceId, modelFile, size, fallback)`: ölçülen tok/s'yi açıklayan bant genişliği
  (`tps × gb / 0.6`). `fitTogether` ve `planSplit` cihazları bununla sıralar ve payları buna göre böler;
  ölçüm yoksa passport / eşin ilan ettiği `bw`. Böylece bir kez ölçülen cihaz, ne söylediğiyle değil
  ne yaptığıyla planlanır.
- Önbellek cihaz+model başına; yeni ölçüm eskisini geçersiz kılar (en yeni kayıt kazanır).
  `node/src/planner.ts` bu dala eklenmedi: bilgisayar tarafı hâlâ `bw` ile planlar (sonraki adım:
  `~/.kula-node/bench/*.json`'dan aynı aramayı yapmak).

## bilinen sınırlar

- Telefonda `prompt_tps` yok; `first_token_ms` istemi de kapsar.
- Telefonda `apart` yalnız o anda ayrı modda yüklü kümenin eşleri için ölçülür (model orada hazır).
- `/blob` olmayan eski bir işçi için tünel hızı atlanır; ikisinin de güncel olması gerekir
  (`ApiServer.kt` ve `node/src/api.ts`, uyum testi `node/test/conformance.test.ts`).
- Kotlin `ApiServer.kt` değişikliği bu cloud oturumunda derlenmedi (Android SDK yok); `npm run apk`
  ile ilk derlemede görülür.
