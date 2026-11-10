// Strings for photos and vision models (10.11.2026): vision.* · models.vision · err.novision ·
// err.nophotos · brain.vision.* · task.photos.*
export const vision = {
  'models.vision': { en: 'sees photos', de: 'sieht fotos', tr: 'fotoğraf görür' },

  'vision.attach': { en: 'add a photo', de: 'foto hinzufügen', tr: 'fotoğraf ekle' },
  'vision.camera': { en: 'camera', de: 'kamera', tr: 'kamera' },
  'vision.library': { en: 'photos', de: 'fotos', tr: 'fotoğraflar' },
  'vision.ask': { en: 'what is in this photo?', de: 'was ist auf diesem foto?', tr: 'bu fotoğrafta ne var?' },
  'vision.remove': { en: 'remove photo', de: 'foto entfernen', tr: 'fotoğrafı kaldır' },
  'vision.reading': { en: 'reading the photo with {model}…', de: '{model} liest das foto…', tr: 'fotoğraf {model} ile okunuyor…' },
  'vision.swapping': { en: '{model} reads the photo; the chat model steps aside to make room and comes back after.', de: '{model} liest das foto; das chatmodell macht platz und kommt danach zurück.', tr: 'fotoğrafı {model} okuyor; sohbet modeli yer açmak için çekiliyor, sonra geri gelecek.' },
  'vision.readBy': { en: 'photo read by {model}', de: 'foto gelesen von {model}', tr: 'fotoğrafı {model} okudu' },
  'vision.seenBy': { en: 'photo seen by {model}', de: 'foto gesehen von {model}', tr: 'fotoğrafı {model} gördü' },
  'vision.local': { en: 'photos are read on this phone; only text goes to the other devices.', de: 'fotos werden auf diesem telefon gelesen; zu den anderen geräten geht nur text.', tr: 'fotoğraflar bu telefonda okunur; diğer cihazlara yalnız yazı gider.' },

  'vision.setting': { en: 'vision model', de: 'bildmodell', tr: 'görüntü modeli' },
  'vision.setting.hint': { en: 'reads photos in the chat and in night projects. a chat model that sees photos itself answers them directly.', de: 'liest fotos im chat und in nachtprojekten. ein chatmodell, das selbst fotos sieht, beantwortet sie direkt.', tr: 'sohbette ve gece projelerinde fotoğrafları okur. kendisi fotoğraf gören bir sohbet modeli onları doğrudan cevaplar.' },
  'vision.setting.auto': { en: 'the smallest on this phone ({model})', de: 'das kleinste auf diesem telefon ({model})', tr: 'bu telefondaki en küçüğü ({model})' },
  'vision.setting.none': { en: 'none on this phone: download one in models (marked "sees photos").', de: 'keins auf diesem telefon: lade eins unter modelle (markiert mit "sieht fotos").', tr: 'bu telefonda yok: modeller’den bir tane indir ("fotoğraf görür" işaretli).' },

  'err.novision': { en: 'no model on this phone can see photos: download a vision model in models (marked "sees photos").', de: 'kein modell auf diesem telefon sieht fotos: lade unter modelle ein bildmodell (markiert mit "sieht fotos").', tr: 'bu telefondaki hiçbir model fotoğraf göremiyor: modeller’den bir görüntü modeli indir ("fotoğraf görür" işaretli).' },
  'err.nophotos': { en: 'the photo could not be read from the phone (deleted?).', de: 'das foto ließ sich nicht vom telefon lesen (gelöscht?).', tr: 'fotoğraf telefondan okunamadı (silinmiş mi?).' },

  'brain.vision.on': { en: '{model} sees photos now (its image encoder is loaded)', de: '{model} sieht jetzt fotos (sein bild-encoder ist geladen)', tr: '{model} artık fotoğraf görüyor (görüntü kodlayıcısı yüklendi)' },
  'brain.vision.failed': { en: '{model}: its image encoder did not load', de: '{model}: sein bild-encoder wurde nicht geladen', tr: '{model}: görüntü kodlayıcısı yüklenmedi' },
  'brain.vision.read': { en: '{model} reads photos ({n}) next to the chat model', de: '{model} liest fotos ({n}) neben dem chatmodell', tr: '{model} fotoğrafları ({n}) sohbet modelinin yanında okuyor' },
  'brain.vision.swap': { en: '{chat} steps aside so {model} can read photos ({n}): both do not fit at once', de: '{chat} macht platz, damit {model} fotos ({n}) lesen kann: beide passen nicht zugleich', tr: '{model} fotoğrafları ({n}) okuyabilsin diye {chat} çekiliyor: ikisi aynı anda sığmıyor' },
  'brain.vision.back': { en: '{model} did not come back after the photo', de: '{model} kam nach dem foto nicht zurück', tr: '{model} fotoğraftan sonra geri yüklenmedi' },
  'brain.vision.none': { en: '"{title}" has photos, and no vision model is on this phone: it runs on the text alone', de: '"{title}" hat fotos, und kein bildmodell ist auf diesem telefon: es läuft nur mit dem text', tr: '"{title}" fotoğraflı, ama bu telefonda görüntü modeli yok: yalnız metinle çalışıyor' },
  'brain.vision.taskFailed': { en: 'the photos of "{title}" could not be read; it runs on the text alone', de: 'die fotos von "{title}" ließen sich nicht lesen; es läuft nur mit dem text', tr: '"{title}" fotoğrafları okunamadı; yalnız metinle çalışıyor' },
  'brain.vision.task': { en: '{model} read the photos of "{title}"', de: '{model} hat die fotos von "{title}" gelesen', tr: '{model}, "{title}" fotoğraflarını okudu' },

  'task.photos.read': { en: 'the photos were read by {model}, a vision model; the answer used its description.', de: 'die fotos hat {model} gelesen, ein bildmodell; die antwort nutzt seine beschreibung.', tr: 'fotoğrafları bir görüntü modeli olan {model} okudu; cevap onun tarifini kullandı.' },
  'task.photos.unreadShort': { en: 'photos not read: no vision model', de: 'fotos nicht gelesen: kein bildmodell', tr: 'fotoğraflar okunmadı: görüntü modeli yok' },
  'task.photos.unread': { en: 'the photos were kept but not read: no vision model on this phone. download one in models and run it again.', de: 'die fotos wurden behalten, aber nicht gelesen: kein bildmodell auf diesem telefon. lade eins unter modelle und lass es noch einmal laufen.', tr: 'fotoğraflar saklandı ama okunmadı: bu telefonda görüntü modeli yok. modeller’den bir tane indirip yeniden çalıştır.' },
} as const;
