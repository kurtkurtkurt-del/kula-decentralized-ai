// god's eye on the phone (11.11.2026, src/eye/): the twelve branches on the brain tab, a branch's
// page and the cards. eye.* · the branches' names and map lines are eye.branch.<id> and
// eye.what.<id>; what a branch itself says (its stat, rows and lines) is the shared eye's own
// words, in english on both homes, as on the computer's panel.
export const eye = {
  'eye.title': { en: 'the twelve', de: 'die zwölf', tr: 'on iki dal' },
  'eye.lede': { en: 'the brain’s twelve branches, looking at this phone’s cluster every 5 seconds while it is open. they only watch and suggest.', de: 'die zwölf zweige des gehirns, alle 5 sekunden ein blick auf den cluster dieses handys, solange er offen ist. sie schauen nur zu und schlagen vor.', tr: 'beynin on iki dalı, açıkken her 5 saniyede bu telefonun kümesine bakar. yalnızca izler ve önerir.' },
  'eye.waiting': { en: 'the first look comes in a moment', de: 'der erste blick kommt gleich', tr: 'ilk bakış birazdan geliyor' },
  'eye.a11y.tile': { en: '{n}. {name}: {stat}', de: '{n}. {name}: {stat}', tr: '{n}. {name}: {stat}' },
  'eye.dark': { en: 'not built yet', de: 'noch nicht gebaut', tr: 'henüz kurulmadı' },
  'eye.broken': { en: 'stopped: {why}', de: 'angehalten: {why}', tr: 'durdu: {why}' },

  'eye.branch.senses': { en: 'senses', de: 'sinne', tr: 'duyular' },
  'eye.branch.memory': { en: 'memory', de: 'gedächtnis', tr: 'hafıza' },
  'eye.branch.forecast': { en: 'forecast', de: 'vorhersage', tr: 'tahmin' },
  'eye.branch.learning': { en: 'learning loop', de: 'lernschleife', tr: 'öğrenme döngüsü' },
  'eye.branch.connections': { en: 'connections', de: 'verbindungen', tr: 'bağlantılar' },
  'eye.branch.planner': { en: 'planner', de: 'planer', tr: 'planlayıcı' },
  'eye.branch.executor': { en: 'executor', de: 'ausführer', tr: 'yürütücü' },
  'eye.branch.trust': { en: 'trust and verification', de: 'vertrauen und prüfung', tr: 'güven ve doğrulama' },
  'eye.branch.limits': { en: 'limits', de: 'grenzen', tr: 'sınırlar' },
  'eye.branch.models': { en: 'models and device care', de: 'modelle und gerätepflege', tr: 'modeller ve cihaz bakımı' },
  'eye.branch.review': { en: 'request review', de: 'anfrageprüfung', tr: 'istek incelemesi' },
  'eye.branch.advisor': { en: 'advisor', de: 'berater', tr: 'danışman' },

  'eye.what.senses': { en: 'it sees every device: is it there, how much memory is free, how fast it answers.', de: 'es sieht jedes gerät: ist es da, wie viel speicher frei ist, wie schnell es antwortet.', tr: 'her cihazı görür: orada mı, ne kadar belleği boş, ne kadar hızlı yanıt veriyor.' },
  'eye.what.memory': { en: 'what happened and why: the decision log, kept on this phone.', de: 'was geschah und warum: das entscheidungsprotokoll, auf diesem handy.', tr: 'ne oldu ve neden: karar günlüğü, bu telefonda tutulur.' },
  'eye.what.forecast': { en: 'guesses when each device is free and how fast it will be, from what it saw before.', de: 'schätzt, wann jedes gerät frei ist und wie schnell es sein wird, aus dem, was es vorher sah.', tr: 'daha önce gördüklerinden her cihazın ne zaman boş olacağını ve ne kadar hızlı olacağını tahmin eder.' },
  'eye.what.learning': { en: 'compares each guess with what really happened and tunes itself.', de: 'vergleicht jede schätzung mit dem, was wirklich geschah, und stellt sich nach.', tr: 'her tahmini gerçekte olanla karşılaştırır ve kendini ayarlar.' },
  'eye.what.connections': { en: 'how each device is reached: the wi-fi or a relay. no server outside.', de: 'wie jedes gerät erreicht wird: das wlan oder ein relay. kein server draußen.', tr: 'her cihaza nasıl ulaşılır: wi-fi ya da bir aktarıcı. dışarıda sunucu yok.' },
  'eye.what.planner': { en: 'where the model sits: this phone, a copy on each (apart) or one model across them (split), and why.', de: 'wo das modell sitzt: dieses handy, eine kopie auf jedem (getrennt) oder ein modell über alle (geteilt), und warum.', tr: 'model nerede duruyor: bu telefonda, her birinde bir kopya (ayrı ayrı) ya da hepsine yayılmış tek model (bölünmüş), ve neden.' },
  'eye.what.executor': { en: 'who is answering now and how fast; apart, the fastest free device answers.', de: 'wer gerade antwortet und wie schnell; getrennt antwortet das schnellste freie gerät.', tr: 'şu an kim yanıtlıyor ve ne hızda; ayrı ayrı modda en hızlı boş cihaz yanıtlar.' },
  'eye.what.trust': { en: 'one answer for the whole cluster: pinned links, who each device is, what its gate refused, whether its signed ledger holds.', de: 'eine antwort für den ganzen cluster: gepinnte verbindungen, wer jedes gerät ist, was sein tor abwies, ob sein signiertes hauptbuch hält.', tr: 'tüm küme için tek yanıt: sabitlenmiş bağlantılar, her cihazın kim olduğu, kapısının neyi reddettiği, imzalı defterinin tutarlı olup olmadığı.' },
  'eye.what.limits': { en: 'keeps devices within their limits: memory, rest, the night window, this phone’s battery and heat.', de: 'hält die geräte in ihren grenzen: speicher, pausen, das nachtfenster, akku und wärme dieses handys.', tr: 'cihazları sınırları içinde tutar: bellek, dinlenme, gece aralığı, bu telefonun pili ve ısısı.' },
  'eye.what.models': { en: 'which model fits which device, files checked by sha256, what each device holds now.', de: 'welches modell auf welches gerät passt, dateien per sha256 geprüft, was jedes gerät gerade hält.', tr: 'hangi model hangi cihaza sığar, sha256 ile denetlenen dosyalar, her cihazın şu an ne tuttuğu.' },
  'eye.what.review': { en: 'looks at a job before it runs: is it allowed, is it safe to send to someone else’s phone.', de: 'sieht sich eine aufgabe an, bevor sie läuft: ist sie erlaubt, darf sie auf das handy eines anderen.', tr: 'bir iş çalışmadan önce ona bakar: izinli mi, başkasının telefonuna göndermek güvenli mi.' },
  'eye.what.advisor': { en: 'suggests which model, which devices, which night, before you ask.', de: 'schlägt vor, welches modell, welche geräte, welche nacht, bevor du fragst.', tr: 'sen sormadan hangi model, hangi cihazlar, hangi gece olacağını önerir.' },

  // the cards
  'eye.cards': { en: 'the brain suggests', de: 'das gehirn schlägt vor', tr: 'beyin öneriyor' },
  'eye.card.warn': { en: 'warning', de: 'warnung', tr: 'uyarı' },
  'eye.card.suggest': { en: 'suggestion', de: 'vorschlag', tr: 'öneri' },
  'eye.card.from': { en: 'from {branch}', de: 'von {branch}', tr: '{branch} dalından' },
  'eye.card.dismiss': { en: 'dismiss', de: 'ausblenden', tr: 'kapat' },
  'eye.card.notHere': { en: 'only the computer can do this one', de: 'das kann nur der computer', tr: 'bunu yalnızca bilgisayar yapabilir' },
  'eye.card.done': { en: 'done', de: 'erledigt', tr: 'tamam' },
  'eye.card.failed': { en: 'it did not work: {why}', de: 'das hat nicht geklappt: {why}', tr: 'olmadı: {why}' },
  'eye.apply.load': { en: 'load', de: 'laden', tr: 'yükle' },
  'eye.apply.unload': { en: 'unload', de: 'entladen', tr: 'boşalt' },
  'eye.apply.fetch': { en: 'fetch', de: 'holen', tr: 'indir' },
  'eye.apply.probe': { en: 'look again', de: 'nochmal schauen', tr: 'yeniden bak' },
  'eye.apply.open': { en: 'open', de: 'öffnen', tr: 'aç' },

  // a branch's page
  'eye.page.sees': { en: 'what it sees', de: 'was es sieht', tr: 'ne görüyor' },
  'eye.page.list': { en: 'its list', de: 'seine liste', tr: 'listesi' },
  'eye.page.words': { en: 'in the branch’s own words, the same on the computer', de: 'in den eigenen worten des zweigs, dieselben wie auf dem computer', tr: 'dalın kendi sözleriyle, bilgisayardakiyle aynı' },
  'eye.page.report': { en: 'the full report', de: 'der ganze bericht', tr: 'tam rapor' },
  'eye.page.gone': { en: 'no such branch', de: 'diesen zweig gibt es nicht', tr: 'böyle bir dal yok' },

  // branch 8 on the phone (src/eye/trustBranch.ts)
  'eye.trust.why': { en: 'the security report found something to look at on a device this phone works with.', de: 'der sicherheitsbericht hat bei einem gerät, mit dem dieses handy arbeitet, etwas gefunden.', tr: 'güvenlik raporu, bu telefonun birlikte çalıştığı bir cihazda bakılacak bir şey buldu.' },
  'eye.trust.note': { en: 'checked natively on this phone, once a minute while the report is open; the brain only reads it.', de: 'nativ auf diesem handy geprüft, einmal pro minute, solange der bericht offen ist; das gehirn liest ihn nur.', tr: 'bu telefonda yerel olarak, rapor açıkken dakikada bir denetlenir; beyin yalnızca okur.' },
} as const;
