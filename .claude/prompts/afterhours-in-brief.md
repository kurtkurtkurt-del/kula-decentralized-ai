# afterhours, kısa anlatım (20.10.2026)

Yeni bir projeye başlangıç notu olarak; ayrıntı için README.

**afterhours nedir.** Bir şehrin gecelerini (konser, kulüp, szene) kart kart önüne koyan ve
arkadaşlarınla birlikte gece bulduran mobil uygulama. Ana fiil "keep": sağa kaydırırsan geceyi
saklarsın, arkadaşların görür; gece gelince check-in yaparsın ve o gecenin kartını kazanırsın.
Her şey geceye bağlı; kişiye bağlı "post" yok.

**Üç parça, tek repo.**
- `app/` — Expo (React Native), expo-router ile dosya tabanlı sayfalar. Beş sekme: flow (deste),
  messages, connect (gruplar, arkadaşların sakladıkları, desteler), map, account. Ekranlar
  `src/app/`, bileşenler `src/components/`, veri katmanı `src/data/` (her tablo/RPC için bir
  dosya), kelimeler `src/i18n/parts/` (en · de · tr, kod İngilizce).
- `backend/sql/` — Supabase Postgres. Numaralı, yalnızca eklenen migration dosyaları (01…63);
  her tablo RLS ile kapalı, uygulama tabloya değil `security definer` fonksiyonlara (RPC)
  konuşur. Tek kapı: `assert_member()` her okumada "üye misin, yasaklı mısın" sorar. Her
  migration için PGlite üstünde çalışan bir test var (`backend/test/*.test.mjs`); setup dosyası
  bu migrationlardan derlenir.
- Site (repo kökü) — düz HTML; gece sayfaları, paylaşım linkleri, yasal sayfalar.

**Veri mantığı.** `events` (Ticketmaster senkronu + elle girilen), `swipes` (keep / let go),
`checkins` → kart numarası, `friendships`, `groups` + `group_legs` (travel), `sparks`
(arkadaşların başlattığı planlar, dalga dalga yayılır: arkadaşlar → arkadaşların arkadaşları →
bir adım öte), `dm_threads` (direkt mesaj), `event_about` ve `event_previews` (gecenin sanatçısı
hakkında metin ve 30 saniyelik önizleme, önceden eşleştirilmiş). Push bildirimi yalnızca sabit
cümle + isim taşır, asla mesaj metni.

**Uygulama tarafı alışkanlıkları.** Her okuma önce telefondaki kopyayı gösterir, arkadan tazeler
(`lib/offline.ts`, "shelf" mantığı); her yazma tek bir outbox'tan geçer, çevrimdışıyken bekler.
Tasarım dili: mürekkep zemin, kâğıt yazı, kırmızı vurgu, Archivo başlık; kartlar poster +
mürekkep blok. Yeni bir özellik önce `prototypes/*.html` içinde 5 tasarım olarak çizilir, biri
seçilir, sonra yazılır.

**Kalite kapısı.** `npm run gate` (backend testleri, tsc, lint, jest, site kontrolü) geçmeden push
yok; pre-push hook bunu zorlar. README her değişiklikle güncellenen tek referans; migration'lar
canlıya Supabase SQL editöründen yapıştırılır, `npm run health` kaç dosyanın uygulandığını söyler.

**Yeni projeye taşınacak ilkeler:** veri tabloya değil fonksiyona açılır; içerik yere/zamana
bağlanır, kişiye değil; önce saklı kopya, sonra ağ; her migration'a test; tasarım seçimleri
prototipte, kodda değil.
