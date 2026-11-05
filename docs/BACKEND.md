# kula — backend: the night on the server

Dal: `claude/backend-night` (5.11.2026). Kaynak: `backend/sql/18_night.sql`, `backend/functions/night-report`,
`backend/functions/project-summary`, `app/src/data/night.ts`. Testler: `backend/test/night.test.mjs` (61 kontrol,
PGlite), `backend/test/functions.test.mjs` (28), `app/src/__tests__/night-data.test.ts`, `demo.test.ts`.

## ilke: yalnız sayılar

Telefon gece bir projenin işini yapar; istemler (prompt), cevaplar, örnekler, model çıktıları **telefonda kalır**.
Sunucuya giden tek şey sabah raporunun sayıları: kaç birim, kaç kontrol, kaç yanlış, token, saniye, tok/s, Wh;
ayrıca modelin adı, uygulama sürümü, mod (real/sim) ve cihaz kimliği. Üç katman bunu korur:

1. `app/src/data/night.ts` `toPayload()`: `NightReport`'tan yalnız bu alanları kopyalar; cihaz adları bile gitmez
   (yalnız id + sayılar). Rapor nesnesinde başka ne varsa düşer (test: `prompt` alanı payload'da yok).
2. `backend/functions/_shared/night.ts` `checkReport()`: HTTP kapısı için aynı eleme + sınırlar; TypeScript, node'da test.
3. `18_night.sql` `night_report()`: json'dan yalnız sayıları okur, **json'un kendisini saklamaz**; tablo sütunları sabittir
   (test: satırda `prompt|text|answer|output` adlı sütun yok).

## şema

```
projects.owner_id          yeni, null olabilir: projenin sahibi (özetleri okur). Elle ya da panelden atanır.

night_reports              bir cihaz × proje × gece = bir satır
  id, user_id, device_id   device_id = passport'un cihaz kimliği (app/src/data/passport.ts deviceId(), kurulum başına bir)
  project_id, night        night = pencerenin açıldığı tarih (report.ts windowKey, "2026-11-05")
  client_id                outbox işinin id'si; (user_id, client_id) tekil
  units, checked, wrong    checked ≤ units, wrong ≤ checked, hepsi ≤ 1e6
  tokens ≤ 1e9, seconds ≤ 86400, segments 1..1000, devices 1..64
  tps ≤ 1e5, wh ≤ 1e4      numeric
  app_version ≤ 32, model ≤ 120, mode in (real, sim)
  unique (user_id, device_id, project_id, night)

night_units                isteğe bağlı ayrıntı: (report_id, idx) → tokens, ms, ok (bool|null). Metin yok, birim kimliği yok.

device_ledger_heads        (user_id, device_id) → seq, head_hash (sha256 hex), signature, alg (ed25519 | hmac-sha256), updated_at
                           defterin içeriği değil, yalnız son halkanın hash'i ve imzası.
```

Görünümler (kullanıcıya grant yok; fonksiyonlar okur):

- `night_project_months`: proje × ay → gece, telefon, kişi, birim, kontrol, yanlış, token, saniye, wh, real gece.
- `night_device_streaks`: cihaz başına son seri (ardışık geceler, proje fark etmez), ilk/son gece.
- `night_leaderboard_30d`: takma ad (handle) → son 30 gün gece/birim/token; yalnız `kept_visibility = friends` olanlar,
  banlılar hariç.

Fonksiyonlar (hepsi `security definer`, `assert_member()` ile başlar, yalnız `authenticated`):

| fonksiyon | ne yapar |
|---|---|
| `night_report(report jsonb, client_id)` | doğrular, satır yazar, id döner. Aynı client_id → aynı id. Aynı cihaz+proje+gece → ilk satırın id'si, değişiklik yok. |
| `night_units_add(report_id, units jsonb)` | kendi raporuna ayrıntı ekler; `on conflict do nothing`, en çok 2000. |
| `night_reports(limit)` | kendi raporların, yeniden eskiye. |
| `night_mine_summary(device_id?)` | proje başına: bu ay gece, toplam gece, bu ay birim/wh, son gece, bu cihazın serisi. Kartlar bunu gösterir. |
| `project_summary(slug)` | sahibi ya da admin: ay başına toplamlar. Başkası: `not the owner` (42501). |
| `night_leaderboard(limit)` | 30 gün, takma adla; `me` bayrağı. Giriş yapmış herkes. |
| `ledger_head_set(device, seq, hash, sig, alg)` | başlık; `seq` geri gidemez, aynı seq farklı hash reddedilir. |
| `ledger_head_mine()` | cihazlarının başlıkları (imza dönmez). |

Doğrulama sınırları (SQL ve TS aynı): gece bugünden en çok 7 gün geride, 1 gün ileride; `seconds = 0` iken token olamaz;
`tps ≤ tokens/seconds × 1.5 + 1`; 16 KB üstü json reddedilir; cihaz toplamı gece toplamını aşamaz (TS).

## RLS kararları

- Depo geleneği "tablolar kapalı, yalnız fonksiyonlar". Burada ek olarak **politika** da var: `authenticated`
  kendi satırını okur/yazar (`user_id = auth.uid()`), `night_units` rapor sahipliği üzerinden. Böylece bir gün
  istemci tabloyu doğrudan okusa bile başkasının satırını göremez (test: can berk'in satırını ne fonksiyonla ne tabloyla görür,
  berk adına satır yazamaz).
- `update` yok: rapor kesindir. `delete` yok (hesap silinince cascade).
- `device_ledger_heads` için `update` var (başlık ilerler) ama yalnız kendi satırı; `seq` kontrolü fonksiyonda.
- Proje sahibi **satırları değil toplamları** okur (`project_summary`): kimlik, cihaz id, handle dönmez.
- Liderlik takma adla ve yalnız görünürlüğü `friends` olanlarla; `private` görünmez.
- Görünümlere `anon/authenticated` grant yok; `security definer` fonksiyonlar okur.
- `anon` hiçbir şeye erişmez.

## uygulama tarafı

- Outbox işi `nightReport` (`data/night.ts`): online ise hemen, değilse kuyrukta; ağ hatası aynı id ile yeniden dener
  (2 s, 4 s, … 60 s, `lib/offline.ts`). Sunucu reddederse iş düşer, `sendNightReport` false döner, rapor telefonda kalır.
- Demo sunucu (`demo/server.ts`) aynı uçları aynı kurallarla taklit eder; `project_summary` demo'da hep `not the owner`.
- Passport kartı: `night_mine_summary` toplamı → "bu ay: n gece · seri s". Proje sayfası: "sen: bu projeye bu ay n gece".
- Kenar fonksiyonları uygulamanın yolu değil (uygulama rpc çağırır); uygulama dışı istemciler için HTTP kapısı.

## kenar fonksiyonları

- `POST night-report` `{ report, client_id, units? }` → `{ id }`; 400 şekil/sınır, 401 imzasız. Çağıranın JWT'si Postgres'e
  aktarılır; karar yine `assert_member` + RLS.
- `GET project-summary?slug=…` (sahip/admin) → `{ months }`; `?mine=1[&device_id]` → `{ projects }`.
- Dağıtım: `backend/functions/README.md`. `tools/supabase-reset.sh` CLI varsa `supabase/migrations` düzenini kurup
  `supabase db reset` çalıştırır; yoksa PGlite'ta tüm dosyaları sıfırdan iki kez uygular (`npm run reset:check`).

## canlıya alma

`SUPABASE_DB_URL=… node tools/migrate.mjs` (önce kuru), `--write` ile `18_night.sql` girer. Sonra isteğe bağlı iki kenar
fonksiyonu. Uygulama eski sunucuya karşı da çalışır: rpc yoksa gönderim reddedilir, rapor telefonda kalır (önceki davranış).

## beyin v1: defter toplama planı

Bugün: denetçi defteri (`audit/`) telefonda; sunucuda yalnız başlık (`device_ledger_heads`: seq, hash, imza). Her gece sonunda
telefon `ledger_head_set` gönderir (`data/night.ts sendLedgerHead`, outbox işi `ledgerHead`; şu an çağıran yok — v1'de
scheduler `finish()` içinde çağrılacak, denetçi başlığı verdiğinde).

v1 adımları:

1. **Anahtar**: kurulumda cihaz bir ed25519 çifti üretir (secure storage); açık anahtar passport'a (`passport/0.4`,
   device-passport tarafında) ya da `device_keys` tablosuna girer. Başlık imzası bu anahtarla.
2. **Zincir**: defterin her halkası `hash = sha256(prev_hash || entry)`; başlık = son hash + seq. Sunucu her başlıkta
   `seq` artmalı ve aynı `seq` için hash değişmemeli (bugün var). İleride: açık anahtarla imza doğrulaması Postgres'te
   (pgsodium/pgcrypto ed25519) ya da kenar fonksiyonunda.
3. **Toplama**: sunucu istediğinde (proje sahibinin denetim isteği, rastgele örnekleme) telefona push ile "seq a..b arası
   halkaları yükle" denir; telefon halkaları (yine yalnız sayılar + hash'ler, istem içeriği yok) `ledger_entries`'e yazar.
   Sunucu zinciri yeniden hash'leyip başlıkla karşılaştırır: tutmuyorsa cihaz "doğrulanamadı" işaretlenir, kartlar etkilenmez,
   liderlikten düşer.
4. **Çapraz kontrol**: bilinen-cevap birimlerinin (`night_units.ok`) oranı başlıktaki sayılarla ve `night_reports.checked/wrong`
   ile tutmalı; tutmazsa aynı işaret.
5. **Gizlilik sınırı değişmez**: toplanan halkalar da içerik taşımaz; içerik gerekiyorsa yalnız açık kaynak test setinin
   birim numarası.
