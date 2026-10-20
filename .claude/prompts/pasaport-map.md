# pasaport — repo haritası ve eşleme (20.10.2026, adım 1)

Kaynak: `../afterhours` (commit 2e1d9ff) → `pasaport/` (tam kopya, git geçmişiyle, remote kaldırıldı,
app/package/backend adları "pasaport", Android `app.pasaport.android`, iOS `app.pasaport.ios`, scheme `pasaport`).

## 1. Harita (olduğu gibi)

| Yer | Ne | Not |
|---|---|---|
| `/` kök | düz HTML site: landing, `explore/` (duvar), `explore/event/?slug=` (gece sayfası), `g/` (grup linki), `login/ register/ reset/ settings/ profile/ feedback/ help/ privacy/ impressum/ datenschutz/ agb/ admin/`, `posters/` (145 el yapımı SVG), `lang/` + `i18n.js` (en·de·tr), `tools-*.py` | build yok |
| `app/` | Expo SDK 57, expo-router, TS. `src/app/` rotalar, `src/components/` (70 bileşen), `src/data/` (tablo/RPC başına dosya, 34), `src/lib/` (offline.ts shelf+outbox, supabase.ts, push.ts, share.ts), `src/i18n/parts/` (common groups home pages posts server staff tabs tips), `src/theme/tokens.ts`, `src/content/` (statik içerik), `src/__tests__/` (jest-expo: offline, waves, when, sparkHints) | `modules/` yok, yerel modül hiç yazılmamış |
| `app/src/app/(tabs)/` | `flow` · `messages` · `people` (connect) · `map` · `account` + `yours` | sekme sırası `_layout.tsx`, adlar `i18n/parts/tabs.ts` |
| diğer rotalar | `night/[slug]` `room/[slug]` `rooms` `spark/[kind]` `list/[kind]` `groups/*` (index new join invite chat album memories [id]) `dm/[id]` `friend/[id]` `person/[handle]` `dj/[id]` `post/new` `make` `explore` `film` `credits` `profile` `settings` `signup` `welcome` `auth-callback` `panel/*` (15 staff ekranı) | |
| `backend/sql/` | **01…95** numaralı migration (brief "63" diyor, gerçek 95) + elle yapıştırılan yardımcılar (`paste-*`, `seed-test-*`, `about-*`, `previews-*`) | yeni dosyalar **96**'dan başlar |
| `backend/test/` | 80 PGlite testi, `supabase-shim.sql`; `package.json test` zinciri sıralı | her yeni migration'a bir test + zincire ekleme |
| `backend/tools/` | `gate.mjs` (stamp → backend test → tsc → lint → jest → site walk), `stamp-sql.mjs` (sql hash damgası), `build-setup.mjs`, `health.mjs`, `migrate.mjs`, `backup/restore`, **`sync-ticketmaster.mjs`** (kalkacak), `world-*`, `previews.mjs` (kalkacak) | |
| `.github/workflows/` | `test.yml`, `backup.yml`, `health.yml`, **`sync-events.yml`** (kalkacak) | secrets yeni repoda yok |
| `.githooks/pre-push` | gate proof olmadan main'e push yok | aynen |
| `prototypes/` | 17 HTML taslak (özellik başına 5 tasarım alışkanlığı) | `passport-*.html` buraya |
| `app/google-services.json`, Sentry plugin, `eas.json` (projectId afterhours) | afterhours'a bağlı | yeni Firebase/EAS/Sentry gerekir |

## 2. Eşleme

### Sekmeler (`app/src/app/(tabs)/`)
| afterhours | pasaport | dosya |
|---|---|---|
| flow (gece destesi) | **flow** (proje destesi) | `flow.tsx` kalır |
| messages | **messages** (proje sohbeti + DM) | `messages.tsx` kalır |
| people = connect | **connect** (kooperatifler, arkadaşların sakladıkları, desteler) | `people.tsx` kalır |
| map | **network** (düğüm kümeleri, projeler nerede çalışıyor) | `map.tsx` → `network.tsx` |
| account | **passport** (cihaz pasaportu + katkı kartları + ayarlar) | `account.tsx` → `passport.tsx` |
| yours (saklananlar) | yours (saklanan projeler) | kalır |

### Tablolar (`backend/sql/`, hepsi RLS kapalı, security definer RPC)
| afterhours | pasaport | ne değişir |
|---|---|---|
| `events` (01) | `projects` | ad, 2 cümle, model ("3B Q4"), istenen gece, hedef telefon, tahmini kWh/€; tarih/mekân/bilet/sanatçı yok; Ticketmaster yok; elle + seed |
| `swipes` (01) | `joins` | keep / let go |
| `checkins` (19) | `contributions` | gece oturumu: start/end, token, saat, kWh, kredi; kart numarası aynen |
| `friendships` (07) | `friendships` | aynen |
| `groups` (44) + `group_legs` (61, travel) | `coops` + `coop_nights` | "bu gece beraber çalışıyoruz" |
| `sparks` + `spark_invites` (27, dalga 28/33) | `calls` | arkadaş proje gecesi başlatır, aynı dalga kuralı |
| `dm_threads` + `dm_messages` (59) | aynen | |
| `event_about` (40) | `project_about` | yürüten kurum/kişi |
| `event_previews` (63, 30 sn ses) | `project_samples` | 3 satır örnek çıktı |
| — | **`passports`** | cihaz ölçümü JSON (schema passport/0.1), kullanıcı başına son N |
| — | **`credits`** | defter: contribution başına kazanç, ağırlık = parametre/7 |
| `venues`, `event_types`, `tickets` (60), `djs` (20), `room_posts`, `previews` sesi | kalkar / dönüşür | aşağıdaki sorulara bağlı |

### Uygulama veri dosyaları (`app/src/data/`)
`deck.ts`→projeler · `checkin.ts`→`contribution.ts` · `sparks.ts`+`waves.ts`→`calls.ts` · `groups.ts`→`coops.ts` · `about.ts`→`projectAbout` · `previews.ts`→`samples.ts` · `tickets.ts`/`djs.ts`/`near.ts`(mekân) kalkar · yeni `passport.ts`, `credits.ts`, `src/night/NightWorker.ts` + `SimulatedWorker.ts`, `modules/passport-measure/` (Kotlin, expo-modules-core).

### Kalan iskelet (dokunulmaz)
offline shelf+outbox, `assert_member()`, numaralı migration + PGlite test, i18n en·de·tr, `npm run gate`, pre-push hook, prototip-önce, push kuralı (sabit cümle + isim).

## 3. Cihaz ölçümü: hazır Kotlin kaynağı (20.10.2026 akşamı)

Ölçüm kodu başka bir Code oturumunda ("Kapasite Pasaportu Android uygulaması") yazıldı ve
`native/passport-measure-android/` altına **olduğu gibi** alındı (saf Android, Compose, Gradle, JDK 17
`/opt/homebrew/opt/openjdk@17`). Yeniden yazılmaz:
- `app/src/main/java/com/pasaport/Measure.kt` — `measureAll()`: RAM (MemoryInfo, largeMemoryClass), SoC,
  cpufreq, 256 MB arraycopy bant genişliği (1 ısınma + 3), 512×512 çok çekirdek matris (3 tekrar), StatFs,
  BatteryManager, `estimateModel()` (min(free, cap)×0.8, 0.6 GB/1B, basamaklar 1/3/4/7/8/12/14).
- `Passport.kt` — veri sınıfı + `toJson()` (schema passport/0.1, brief'teki alanlar).
- `MainActivity.kt` — tek ekran Compose arayüzü (ölç → sonuç kartı → kopyala); Expo modülünde kullanılmaz.
Adım 4'te `modules/passport-measure/` (expo-modules-core) Measure.kt + Passport.kt'yi değiştirmeden sarar.
