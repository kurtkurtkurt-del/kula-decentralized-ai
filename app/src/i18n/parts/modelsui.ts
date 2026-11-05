// modelsui strings (6.11.2026). Keys use the prefix 'modelsui.'.
// The model tags as icons (the word and one line in a bubble), the fit marks, removing a
// download, the main device, and the "run this together" flow (app/run-together.tsx).
export const modelsui = {
  // what a model is good at (components/models/Tags.tsx)
  'modelsui.tag.chat': { en: 'chat', de: 'chat', tr: 'sohbet' },
  'modelsui.tag.chat.why': { en: 'friendly back-and-forth and short answers.', de: 'lockeres hin und her und kurze antworten.', tr: 'rahat karşılıklı konuşma ve kısa cevaplar.' },
  'modelsui.tag.fast': { en: 'small and quick', de: 'klein und schnell', tr: 'küçük ve hızlı' },
  'modelsui.tag.fast.why': { en: 'a fast download that runs on almost any phone.', de: 'ein schneller download, der auf fast jedem telefon läuft.', tr: 'hızlı iner, neredeyse her telefonda çalışır.' },
  'modelsui.tag.summary': { en: 'summarizer', de: 'zusammenfassen', tr: 'özetleyici' },
  'modelsui.tag.summary.why': { en: 'turns a long text into a few lines.', de: 'macht aus einem langen text ein paar zeilen.', tr: 'uzun bir metni birkaç satıra indirir.' },
  'modelsui.tag.translate': { en: 'many languages', de: 'viele sprachen', tr: 'çok dilli' },
  'modelsui.tag.translate.why': { en: 'reads and writes turkish, german and more; good for translating.', de: 'liest und schreibt türkisch, deutsch und mehr; gut zum übersetzen.', tr: 'türkçe, almanca ve daha fazlasını okur, yazar; çeviri için iyi.' },
  'modelsui.tag.extract': { en: 'extractor', de: 'herausziehen', tr: 'ayıklayıcı' },
  'modelsui.tag.extract.why': { en: 'pulls names, dates and fields out of a text, as json or a list.', de: 'zieht namen, daten und felder aus einem text, als json oder liste.', tr: 'bir metinden ad, tarih ve alanları json ya da liste olarak çıkarır.' },
  'modelsui.tag.write': { en: 'writer', de: 'schreiben', tr: 'yazar' },
  'modelsui.tag.write.why': { en: 'longer answers, rewriting and careful prose.', de: 'längere antworten, umformulieren und sorgfältige texte.', tr: 'uzun cevaplar, yeniden yazma ve özenli metin.' },
  'modelsui.tag.reason': { en: 'thinker', de: 'denker', tr: 'düşünür' },
  'modelsui.tag.reason.why': { en: 'thinks step by step: maths and logic, slower per answer.', de: 'denkt schritt für schritt: mathe und logik, pro antwort langsamer.', tr: 'adım adım düşünür: matematik ve mantık, cevap başına daha yavaş.' },
  'modelsui.tag.code': { en: 'code', de: 'code', tr: 'kod' },
  'modelsui.tag.code.why': { en: 'reads and writes code.', de: 'liest und schreibt code.', tr: 'kod okur ve yazar.' },
  'modelsui.tag.quality': { en: 'best quality', de: 'beste qualität', tr: 'en iyi kalite' },
  'modelsui.tag.quality.why': { en: 'quality over speed; usually needs two or three devices together.', de: 'qualität vor tempo; braucht meist zwei oder drei geräte zusammen.', tr: 'hızdan önce kalite; genelde iki üç cihazın birlikte çalışması gerekir.' },
  'modelsui.tags': { en: 'good at', de: 'gut bei', tr: 'iyi olduğu' },

  // the fit marks
  'modelsui.fit.fits': { en: 'this phone holds it with room to spare.', de: 'dieses telefon hält es mit platz übrig.', tr: 'bu telefon rahatça taşır.' },
  'modelsui.fit.tight': { en: 'it fits, just: close other apps, keep the context small.', de: 'es passt knapp: andere apps schließen, kontext klein halten.', tr: 'ucu ucuna sığar: diğer uygulamaları kapat, bağlamı küçük tut.' },
  'modelsui.fit.together': { en: 'too big alone, but it fits across your connected devices (split mode).', de: 'allein zu groß, aber über deine verbundenen geräte passt es (geteilt).', tr: 'tek başına büyük, ama bağlı cihazlarına bölününce sığar (bölünmüş).' },
  'modelsui.fit.no': { en: 'too big for this phone, even with the devices connected now.', de: 'zu groß für dieses telefon, auch mit den jetzt verbundenen geräten.', tr: 'bu telefon için büyük, şu an bağlı cihazlarla bile.' },

  // a download
  'modelsui.dl.remove': { en: 'remove this download', de: 'diesen download entfernen', tr: 'bu indirmeyi kaldır' },

  // the main device
  'modelsui.main.this': { en: 'this phone is the main device', de: 'dieses telefon ist das hauptgerät', tr: 'ana cihaz bu telefon' },
  'modelsui.main.is': { en: 'main device: {name}', de: 'hauptgerät: {name}', tr: 'ana cihaz: {name}' },
  'modelsui.main.why': { en: 'the main device loads the model and hands work to the others. the phones that share only lend their memory and processor.', de: 'das hauptgerät lädt das modell und gibt den anderen arbeit. die teilenden telefone leihen nur speicher und prozessor.', tr: 'ana cihaz modeli yükler ve diğerlerine iş verir. paylaşan telefonlar yalnızca belleklerini ve işlemcilerini ödünç verir.' },
  'modelsui.main.waiting': { en: 'the device that connects to this one becomes the main device.', de: 'das gerät, das sich mit diesem verbindet, wird das hauptgerät.', tr: 'buna bağlanan cihaz ana cihaz olur.' },
  'modelsui.main.helper': { en: 'this phone helps', de: 'dieses telefon hilft', tr: 'bu telefon yardım ediyor' },

  // run this together (app/run-together.tsx)
  'modelsui.rt.link': { en: 'connect to a phone to run this together', de: 'mit einem telefon verbinden und zusammen ausführen', tr: 'birlikte çalıştırmak için bir telefona bağlan' },
  'modelsui.rt.title': { en: 'run together', de: 'zusammen ausführen', tr: 'birlikte çalıştır' },
  'modelsui.rt.lede': { en: 'this phone is the main device: it loads {model} and uses the others.', de: 'dieses telefon ist das hauptgerät: es lädt {model} und nutzt die anderen.', tr: 'ana cihaz bu telefon: {model} modelini yükler ve diğerlerini kullanır.' },
  'modelsui.rt.step': { en: 'step {n} of {m}', de: 'schritt {n} von {m}', tr: 'adım {n} / {m}' },
  'modelsui.rt.how': { en: 'how do you connect?', de: 'wie verbindest du?', tr: 'nasıl bağlanacaksın?' },
  'modelsui.rt.scan': { en: 'scan the other phone’s code', de: 'den code des anderen telefons scannen', tr: 'diğer telefonun kodunu okut' },
  'modelsui.rt.scan.hint': { en: 'on the other phone: models → a model → share this phone', de: 'am anderen telefon: modelle → ein modell → dieses telefon teilen', tr: 'diğer telefonda: modeller → bir model → bu telefonu paylaş' },
  'modelsui.rt.added': { en: 'pick from added devices', de: 'aus verbundenen geräten wählen', tr: 'eklenmiş cihazlardan seç' },
  'modelsui.rt.added.hint': { en: '{n} added', de: '{n} verbunden', tr: '{n} eklendi' },
  'modelsui.rt.added.none': { en: 'none yet: scan a code first', de: 'noch keins: erst einen code scannen', tr: 'henüz yok: önce bir kod okut' },
  'modelsui.rt.nearby': { en: 'find phones on this wi-fi', de: 'telefone in diesem wlan finden', tr: 'bu wi-fi’deki telefonları bul' },
  'modelsui.rt.nearby.hint': { en: 'shows who is sharing; then scan their code', de: 'zeigt, wer teilt; dann ihren code scannen', tr: 'kimin paylaştığını gösterir; sonra kodunu okut' },
  'modelsui.rt.nearby.none': { en: 'nobody sharing found on this wi-fi', de: 'niemand teilt in diesem wlan', tr: 'bu wi-fi’de paylaşan bulunamadı' },
  'modelsui.rt.who': { en: 'which devices join?', de: 'welche geräte machen mit?', tr: 'hangi cihazlar katılsın?' },
  'modelsui.rt.who.none': { en: 'pick at least one device', de: 'wähl mindestens ein gerät', tr: 'en az bir cihaz seç' },
  'modelsui.rt.mode': { en: 'apart or split?', de: 'getrennt oder geteilt?', tr: 'ayrı mı, bölünmüş mü?' },
  'modelsui.rt.ready': { en: 'ready to start', de: 'bereit zum start', tr: 'başlamaya hazır' },
  'modelsui.rt.devices': { en: 'devices', de: 'geräte', tr: 'cihazlar' },
  'modelsui.rt.model': { en: 'model', de: 'modell', tr: 'model' },
  'modelsui.rt.how.mode': { en: 'how', de: 'wie', tr: 'nasıl' },
  'modelsui.rt.notOnPhone': { en: 'download the model on this phone first: the main device holds the file.', de: 'lade das modell zuerst auf dieses telefon: das hauptgerät hält die datei.', tr: 'önce modeli bu telefona indir: dosyayı ana cihaz tutar.' },
  'modelsui.rt.next': { en: 'next', de: 'weiter', tr: 'ileri' },
  'modelsui.rt.add': { en: 'add another device', de: 'weiteres gerät hinzufügen', tr: 'başka cihaz ekle' },
} as const;
