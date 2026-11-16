# anchor field test: what only real homes and a real phone can show

Written 17.11.2026 for kula 0.6.0. The anchor network (docs/ANCHOR.md) was built and tested on one
Mac: several kula copies, a delay proxy, fake routers, the phone's code on a computer's Java. These
steps are the ones no test on one Mac can do. Do them in order; write down what each screen says,
word for word, and take a screenshot when something looks wrong. A step that fails, written down
exactly, is as useful as one that works.

Bu adımlar Türkçe aşağıda da var.

## what you need

- kula 0.6.0 on every device (the download page: https://kurtkurtkurt-del.github.io/kula-decentralized-ai/).
- The anchor: a computer at home that stays on and plugged in (the Mac is fine).
- One Android phone with mobile data.
- For step 5: a friend's computer in another home (or a second home of yours).
- Open kula once on every computer at home first: the first start sets up llama.cpp.

## 1. make the home computer an anchor (10 min)

1. On the home computer: devices → share this computer → turn on "make this computer an anchor".
2. Read the router sentence and write it down. One of three:
   - "mapped": the router opened the door by itself. Note the outside address it shows.
   - "no answer from the router": open the port it names in the router's settings (often called
     "port forwarding" or "Portfreigabe"), for this computer's address. Then turn the switch off and on.
   - "your provider does not give this home a public address" (carrier NAT): this home cannot be
     an anchor from outside. Stop here and tell Claude; the plan needs another home as the anchor.
3. Keep the page open: it says "not confirmed from outside yet" until a device registers from outside.

## 2. join the phone from outside (15 min)

1. On the phone: wi-fi off, mobile data on.
2. On the home computer: "who is the invite for?" → "a computer of mine" → invite a computer.
3. On the phone: scan the invite's QR (or paste its text). Answer the question with "my computer".
4. Write down: did it join? Within how many seconds? What does the phone's device list say for
   the home computer (it should say "over the internet" or "through anchor …")?
5. On the home computer: does the page now say the anchor is reached from outside?
6. On the phone: share this phone (so the home computer can use it), wait one minute, then on the
   home computer pick a small model (Qwen3 0.6B) and "apart" with the phone. Ask one question.
   Write down the speed it shows.

## 3. the phone changes network (10 min)

1. With the phone joined and sharing: turn wi-fi on (home wi-fi), wait 30 s, turn it off again.
2. Write down: did the phone's row on the computer go from "over the internet" to "on this wi-fi"
   and back? How long did each change take? Did a question asked right after still get an answer?
3. Lock the phone's screen for 10 minutes, then ask a question from the computer. Did the phone
   answer? (Android may stop kula in the background: if it did not answer, open Android settings →
   apps → kula → battery → "unrestricted", and try again.)

## 4. a split over the internet (15 min)

1. Phone on mobile data, joined. On the home computer pick "split" with the phone and Qwen3 0.6B.
2. Write down the plan's estimate, the load time, and the speed of one answer of a few sentences.
3. Ask a second question: the estimate should now say "learned from this split". Write both speeds.
4. Note how much mobile data the phone used (Android settings → network → data usage).

## 5. a second home (30 min, with a friend)

1. On the friend's computer: kula 0.6.0, then turn on "make this computer an anchor" (step 1 there).
2. Each of you invites the other's computer once ("a friend's computer"): the two anchors must
   join each other so addresses travel between them.
3. Join your phone to the friend's anchor too.
4. Turn your home computer off. Does the phone still reach the friend's computer? Turn it back on:
   does everything find it again without a new invite?
5. Write down what each device list says at each step.

## what to send back

The notes from each step, the screenshots, and the kula version shown on each device. Paste them
to Claude in this project; it will turn them into fixes.

---

## Türkçe: aynı adımlar kısaca

Bu testleri ancak sen yapabilirsin; tek bir Mac'te denenemiyorlar. Her adımda ekranda yazanı aynen
not al, garip bir şey görürsen ekran görüntüsü al. Başarısız bir adım, tam olarak yazıldığında,
çalışan bir adım kadar değerlidir.

1. **Ev bilgisayarını çapa yap.** Cihazlar → bu bilgisayarı paylaş → "bu bilgisayar çapa olsun".
   Modem cümlesini not al: kapıyı kendisi açtıysa dış adresi yaz; "modem cevap vermedi" diyorsa
   modem ayarlarında söylediği portu bu bilgisayara yönlendir ("port forwarding"); "sağlayıcın
   gerçek adres vermiyor" diyorsa bu ev çapa olamaz, burada dur ve bana söyle.
2. **Telefonu dışarıdan kat.** Telefonda wi-fi kapalı, mobil veri açık. Bilgisayarda "bir
   bilgisayarım için" davet oluştur, telefonla tara, "benim bilgisayarım" de. Katıldı mı, kaç
   saniyede, cihaz listesinde ne yazıyor? Telefonu paylaşıma aç, bilgisayardan küçük modelle
   (Qwen3 0.6B) "apart" seç, bir soru sor, hızı yaz.
3. **Ağ değişimi.** Telefonda wi-fi'ı aç, 30 saniye bekle, kapat. Satır "internet üzerinden" ile
   "bu wi-fi'da" arasında gidip geldi mi, ne kadar sürdü, hemen sorulan soru cevap aldı mı?
   Ekranı 10 dakika kilitle, sonra bilgisayardan soru sor: telefon cevap verdi mi? Vermediyse
   Android ayarları → uygulamalar → kula → pil → "kısıtlamasız" yap ve tekrar dene.
4. **İnternet üzerinden split.** Telefon mobil veride. Bilgisayarda telefonla "split" seç. Tahmini,
   yükleme süresini ve bir cevabın hızını yaz. İkinci soruda tahmin "bu split'ten öğrenilen"
   demeli; iki hızı da yaz. Telefonun ne kadar mobil veri harcadığını not al.
5. **İkinci ev (bir arkadaşla).** Arkadaşının bilgisayarını da çapa yap. İkiniz birbirinizin
   bilgisayarını birer kez davet edin ("bir arkadaşımın bilgisayarı"). Telefonunu onun çapasına
   da kat. Kendi bilgisayarını kapat: telefon arkadaşının bilgisayarına hâlâ ulaşıyor mu? Geri aç:
   yeni davet gerekmeden her şey onu yeniden buluyor mu?

Notları, ekran görüntülerini ve her cihazda görünen kula sürümünü bu projede bana yapıştır.
