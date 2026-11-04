# ilerleme — gerçek modeller, telefon kümesi, bilgisayarlar, beyin v0

Plan: `~/.claude/plans/memoized-kindling-puddle.md` (4.11.2026). Bu dosya her adımda güncellenir:
ne yapıldı, ne doğrulandı, ne kaldı. Döndüğünde önce burayı oku.

## durum

| adım | durum | not |
|---|---|---|
| llama.cpp b11157 indir + yama | yapıldı | `.llama/b11157.tar.gz` sha doğrulandı; PrivateLM yaması `modules/kula-llama/tools/patches/` |
| Mac host derlemesi (rpc-server, llama-server) | sürüyor | `node tools/llama-src.mjs --host` → `.llama/host/` |
| Emülatör imajı | sürüyor | `sdkmanager emulator + android-35 arm64` arka planda |
| kula-llama modülü (gradle, CMake, JNI) | bekliyor | |
| Kotlin tarafı | bekliyor | |
| JS katmanı | bekliyor | |
| deste silindi, projects.ts | bekliyor | |
| ekranlar | bekliyor | |
| i18n / krediler / README / testler | bekliyor | |
| apk + emülatör uçtan uca | bekliyor | |
| küme testi | bekliyor | |
| Bölüm 2 kula-node | bekliyor | |
| Bölüm 3 beyin/check | bekliyor | |

## notlar

- Oturum modeli/eforu kendi oturumumdan değiştirilemiyor (araç reddediyor); Fable 5.1'deyim, eforu sen
  uygulamanın ayarından düşürebilirsin.
- Cloud kredisi: cloud oturumu GitHub'da bir repo ve push edilmiş dal ister. beyin'in reposu yok; kula'nın bu dalı
  push edilmemiş. Push istemedim. İstersen "push et ve kula-node'u cloud'da başlat" de.
