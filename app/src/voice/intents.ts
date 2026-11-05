// The secretary's ears (pure, no React Native): what was heard → what to do. Rules, not a
// model: fast, the same every time, and they work with the smallest model loaded (or none).
// Anything the rules do not recognise goes to the model as free conversation.
//
// Turkish, English and German are understood whatever the app's language is (the rules do
// not clash); `now` is passed in so dates are testable. Times: "18:00", "18.30", "6 pm",
// "saat 6'da", "akşam 7", "um 18 uhr", "halb 7", "6 buçuk", "noon". Days: today/tomorrow/
// the day after, weekdays ("next friday", "cuma günü", "am freitag").
//
// For a calendar entry an hour from 1 to 7 with no morning/evening word is taken as the
// evening ("yarın 6'da spor" → 18:00); the secretary always reads the time back before it
// writes, so a wrong guess is caught by a "no".

export type VLang = 'en' | 'de' | 'tr';

export type Intent =
  | { kind: 'calendar.add'; title: string; start: Date; end: Date; allDay: boolean }
  | { kind: 'calendar.read'; from: Date; to: Date }
  | { kind: 'messages.read'; from: string | null }
  | { kind: 'message.draft'; to: string | null; text: string }
  | { kind: 'alarm.set'; hour: number; minute: number; label: string | null }
  | { kind: 'timer.set'; seconds: number; label: string | null }
  | { kind: 'time' }
  | { kind: 'date' }
  | { kind: 'note.add'; text: string }
  | { kind: 'notes.read' }
  | { kind: 'notes.clear' }
  | { kind: 'end' };

// ---- the text -----------------------------------------------------------------------------

/** Lower case (Turkish İ/I done right), punctuation out but 18:30, 18.30 and 6'da kept, padded with spaces. */
export function norm(text: string, lang: VLang): string {
  let s = text.replace(/[’`´]/g, "'");
  if (lang === 'tr') s = s.replace(/İ/g, 'i').replace(/I/g, 'ı');
  s = s.toLowerCase();
  s = s.replace(/(\d)[.:](\d\d)(?!\d)/g, '$1:$2'); // 18.30 → 18:30
  s = s.replace(/\b([ap])\.m\.?/g, '$1m');
  s = s.replace(/[^\p{L}\p{N}:' ]+/gu, ' ').replace(/:(?!\d\d)/g, ' ');
  s = s.replace(/(^|\s)'+|'+(\s|$)/g, '$1$2'); // quotes, not suffix apostrophes
  return ` ${s.replace(/\s+/g, ' ').trim()} `;
}

const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();
const re = (src: string) => new RegExp(` (?:${src}) `);
/** Whether one of the phrases appears as whole words. */
const has = (s: string, src: string) => re(src).test(s);
/** The text with every whole-word match of src replaced by a space. */
function cut(s: string, src: string): string {
  const r = new RegExp(` (?:${src})(?= )`, 'g');
  return ` ${tidy(s.replace(r, ' '))} `;
}

// a Turkish case ending after a number or a name: 6'da, 18:00'e, anna'ya, cumaya
const SUF = "(?:'?(?:da|de|ta|te|ya|ye|a|e|dan|den|tan|ten|ı|i|u|ü|yı|yi|nın|nin|ın|in|un|ün))?";

// ---- days ---------------------------------------------------------------------------------

const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const plusDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

const WEEKDAYS: [number, string][] = [
  [1, 'monday|pazartesi|montag'],
  [2, 'tuesday|salı|sali|dienstag'],
  [3, 'wednesday|çarşamba|carsamba|mittwoch'],
  [4, 'thursday|perşembe|persembe|donnerstag'],
  [5, 'friday|cuma|freitag'],
  [6, 'saturday|cumartesi|samstag|sonnabend'],
  [0, 'sunday|pazar|sonntag'],
];

export type Day = { date: Date; src: string };

/** The day named in s (today when none), and the words that named it. */
export function findDay(s: string, now: Date): Day | null {
  const today = midnight(now);
  const simple: [string, number][] = [
    ['day after tomorrow|öbür gün|obur gun|yarından sonra|yarindan sonra|übermorgen|uebermorgen', 2],
    ["tomorrow|yarın|yarin|yarına|yarina|morgen(?! früh)(?! frueh)|morgen früh|morgen frueh", 1],
    ['today|tonight|this evening|bugün|bugun|bu akşam|bu aksam|bu gece|heute|heute abend', 0],
  ];
  for (const [src, n] of simple) {
    // "morgen" after am/jeden is "the morning", not tomorrow
    if (n === 1 && has(s, 'am morgen|jeden morgen|guten morgen') && !has(s, 'tomorrow|yarın|yarin|morgen früh')) continue;
    const m = re(`(?:${src})${SUF}`).exec(s);
    if (m) return { date: plusDays(today, n), src: m[0].trim() };
  }
  for (const [wd, names] of WEEKDAYS) {
    const m = re(`(?:(?:next|this|on|gelecek|haftaya|bu|nächsten|naechsten|diesen|am|kommenden) )?(?:${names})(?:'?(?:ya|ye|a|e|da|de|ta|te|ı|i))?(?: günü| gunu)?`).exec(s);
    if (!m) continue;
    // "pazar" inside "pazartesi" cannot match: the pattern needs a space after the name
    let diff = (wd - today.getDay() + 7) % 7;
    if (diff === 0 && /next|gelecek|haftaya|nächsten|naechsten|kommenden/.test(m[0])) diff = 7;
    return { date: plusDays(today, diff), src: m[0].trim() };
  }
  return null;
}

// ---- times --------------------------------------------------------------------------------

export type Time = { h: number; m: number; src: string[]; qualified: boolean };

const PM = "pm|in the evening|evening|tonight|in the afternoon|afternoon|akşam|aksam|akşamüstü|öğleden sonra|ogleden sonra|öğlenden sonra|abends|am abend|nachmittags|am nachmittag|heute abend";
const AM = "in the morning|morning|sabah|sabahleyin|morgens|am morgen|früh|frueh|vormittags|am vormittag";
const NIGHT = 'gece|at night|nachts|in der nacht';

/** The clock time in s, if any. mode 'event' guesses the evening for a bare 1–7. */
export function findTime(s: string, mode: 'event' | 'alarm'): Time | null {
  let h = -1;
  let m = 0;
  const src: string[] = [];
  let x: RegExpExecArray | null;
  const at = mode === 'alarm' ? 'at|um|saat|for|auf|on' : 'at|um|saat';
  if ((x = re(`(?:(?:${at}) )?(\\d{1,2}):(\\d{2})(?: ?(am|pm)|'?[a-zçğıöşü]{1,3})?(?: uhr)?`).exec(s))) {
    h = +x[1];
    m = +x[2];
    src.push(x[0].trim());
  } else if ((x = re(`(?:half past|halb|yarım) (\\d{1,2})${SUF}`).exec(s))) {
    // "halb sieben" is 6:30; "half past six" is 6:30
    h = /halb/.test(x[0]) ? +x[1] - 1 : +x[1];
    m = 30;
    src.push(x[0].trim());
  } else if ((x = re(`(?:saat )?(\\d{1,2}) ?buçuk${SUF}|(?:saat )?(\\d{1,2}) ?bucuk${SUF}`).exec(s))) {
    h = +(x[1] ?? x[2]);
    m = 30;
    src.push(x[0].trim());
  } else if ((x = re(`(?:(?:${at}) )?(\\d{1,2}) ?(am|pm|uhr|o'clock|oclock)`).exec(s))) {
    h = +x[1];
    src.push(x[0].trim());
  } else if ((x = re(`(?:${at}) (\\d{1,2})${SUF}`).exec(s))) {
    h = +x[1];
    src.push(x[0].trim());
  } else if ((x = re(`(\\d{1,2})'?(?:da|de|ta|te|ya|ye)`).exec(s))) {
    h = +x[1];
    src.push(x[0].trim());
  } else if ((x = re(`(?:at )?noon|öğlen|öglen|oglen|öğle|ogle|(?:um )?mittag|(?:um )?zwölf uhr mittags`).exec(s))) {
    h = 12;
    src.push(x[0].trim());
    return { h, m, src, qualified: true };
  } else if ((x = re(`(?:at )?midnight|gece yarısı|gece yarisi|mitternacht`).exec(s))) {
    h = 0;
    src.push(x[0].trim());
    return { h, m, src, qualified: true };
  }
  if (h < 0 || h > 24 || m > 59) return null;
  if (h === 24) h = 0;
  const pm = new RegExp(` (?:${PM})(?: |'|$)`).exec(s);
  const am = new RegExp(` (?:${AM})(?: |$)`).exec(s);
  const night = new RegExp(` (?:${NIGHT})(?: |$)`).exec(s);
  let qualified = false;
  if (pm || (src.some((w) => / ?pm$/.test(w)))) {
    if (h < 12) h += 12;
    qualified = true;
    if (pm) src.push(pm[0].trim());
  } else if (am || src.some((w) => / ?am$/.test(w))) {
    if (h === 12) h = 0;
    qualified = true;
    if (am) src.push(am[0].trim());
  } else if (night) {
    if (h >= 6 && h < 12) h += 12; // "gece 11" is 23:00, "gece 2" stays 2:00
    qualified = true;
    src.push(night[0].trim());
  }
  if (!qualified && mode === 'event' && h >= 1 && h <= 7) h += 12;
  return { h, m, src, qualified };
}

// ---- durations ----------------------------------------------------------------------------

const UNITS: [string, number][] = [
  ['seconds?|secs?|saniye|sekunden?', 1],
  ['minutes?|mins?|dakika|dakikalık|dk|minuten?', 60],
  ['hours?|hrs?|saat|saatlik|stunden?', 3600],
];

/** A length of time ("10 minutes", "yarım saat", "eine stunde") in seconds, and its words. */
export function findDuration(s: string): { seconds: number; src: string } | null {
  const half = re(`half an hour|yarım saat|yarim saat|(?:eine )?halbe stunde`).exec(s);
  if (half) return { seconds: 1800, src: half[0].trim() };
  for (const [units, k] of UNITS) {
    const x = re(`(?:in |for )?(\\d+|an?|one|bir|eine?n?) (?:${units})${SUF}(?: sonra| içinde| lang)?`).exec(s);
    if (x) {
      const n = /^\d+$/.test(x[1]) ? +x[1] : 1;
      return { seconds: n * k, src: x[0].trim() };
    }
  }
  return null;
}

// ---- yes / no -----------------------------------------------------------------------------

const NO = "no|nope|nah|cancel|don't|dont|do not|stop|wait|never mind|nevermind|hayır|hayir|yok|iptal|vazgeç|vazgec|istemiyorum|dur|olmaz|yapma|nein|nee|nö|abbrechen|stopp|lass es|lieber nicht|nicht|falsch|wrong|yanlış|yanlis";
const YES = "yes|yeah|yep|yup|sure|ok|okay|correct|right|do it|go ahead|please|confirm|evet|tamam|olur|peki|aynen|doğru|dogru|ekle|kur|onayla|tabii|tabi|ja|jawohl|genau|klar|mach das|mach|richtig|gerne|bitte|passt";

/** A confirmation answer: 'yes', 'no', or null when the words are neither. */
export function answer(text: string, lang: VLang): 'yes' | 'no' | null {
  const words = norm(text, lang).trim().split(' ').slice(0, 4);
  const head = ` ${words.join(' ')} `;
  if (has(head, NO)) return 'no';
  if (has(head, YES)) return 'yes';
  return null;
}

// ---- the intents --------------------------------------------------------------------------

const END = "bye|goodbye|bye bye|that's all|thats all|stop talking|görüşürüz|gorusuruz|hoşça kal|hosca kal|bu kadar|şimdilik bu kadar|tschüss|tschüs|tschuess|auf wiedersehen|das war's|das wars|das ist alles";

const NOTES_CLEAR = '(?:delete|clear|erase|remove) (?:all )?(?:my |the )?notes|notlarımı (?:sil|temizle)|notları (?:sil|temizle)|tüm notları sil|(?:lösch|lösche|loesche) (?:meine |alle |die )?notizen';
const NOTES_READ = "(?:read|show|tell me)(?: me)? (?:my |the )?notes|what are my notes|what's in my notes|my notes|notlarımı oku|notları oku|notlarım(?:da)? ne var|notlarım|(?:lies|lese|zeig)(?: mir)? (?:meine |die )?notizen|meine notizen|was steht in meinen notizen";
const NOTE_ADD = "take a note|make a note|note that|note down|write down|add a note|not al|not et|not düş|notu al|bir not al|notiere|notier|notiz|schreib auf|merk dir|merke dir";

const TIME = "what time is it|what's the time|whats the time|what is the time|time is it|current time|saat kaç|saat kac|saat kaçı|wie spät|wie spaet|wieviel uhr|wie viel uhr|uhrzeit";
const DATE = "what's the date|whats the date|what is the date|what date is it|today's date|todays date|what day is it|what day is today|bugün ayın kaçı|bugün ayın kaçıncı günü|bugün günlerden ne|tarih ne|bugünün tarihi|hangi gündeyiz|bugün ne günü|welches datum|der wievielte|welcher tag ist heute|welchen tag haben wir";

const TIMER = 'timer|zamanlayıcı|zamanlayici|sayaç|sayac|geri sayım|kurzzeitwecker';
const ALARM = 'alarm|alarmı|wake me|wake me up|uyandır|uyandir|wecker|weck mich|wecke mich';
const REMIND = 'remind me|hatırlat|hatirlat|erinnere mich|erinner mich';

const READ_MSG = "(?:read|check)(?: me)? (?:my |the )?(?:new |latest |recent |last )?(?:messages|texts|notifications)|any (?:new )?messages|do i have (?:any )?(?:new )?messages|new messages|mesajlarımı oku|mesajları oku|mesajlarım|yeni mesaj(?:ım|lar)?(?: var mı)?|mesaj var mı|(?:lies|lese)(?: mir)? (?:meine |die )?(?:neuen )?nachrichten|neue nachrichten|habe ich (?:neue )?nachrichten|meine nachrichten";

const CAL_READ = "what's on my (?:calendar|schedule|agenda)|whats on my (?:calendar|schedule|agenda)|what is on my (?:calendar|schedule|agenda)|what do i have|my (?:schedule|calendar|agenda|appointments|events|meetings)|any (?:appointments|meetings|events)|ne var|programım|programımda|programim|takvimimde|takvimde|takvimim|randevularım|bugünkü program|yarınki program|was steht (?:heute |morgen |übermorgen )?an|was habe ich|was hab ich|meine termine|termine|was steht im kalender|was steht in meinem kalender";
const CAL_ADD = 'add|put|schedule|create|book|plan|set up|ekle|koy|planla|kaydet|oluştur|olustur|takvime|takvimime|füge|füg|fuege|hinzu|hinzufügen|trag|trage|eintragen|plane|erstelle|setz|setze|termin';
const CAL_FILLER = "to my calendar|in my calendar|on my calendar|to the calendar|to calendar|my calendar|calendar|an event|event|called|named|a|an|the|at|on|for|to|takvime|takvimime|etkinlik|olarak|için|saat|in den kalender|in meinen kalender|zum kalender|kalender|um|am|uhr|für|ein|einen|eine|hinzu|ein";

/** What the words ask for, or null for free conversation with the model. */
export function parse(text: string, lang: VLang, now: Date): Intent | null {
  const s = norm(text, lang);
  const words = s.trim().split(' ').filter(Boolean);
  if (!words.length) return null;

  if (words.length <= 5 && has(s, END)) return { kind: 'end' };

  // notes before anything with a time in it: "not al: yarın 6'da spor" is a note
  if (has(s, NOTES_CLEAR)) return { kind: 'notes.clear' };
  if (has(s, NOTES_READ)) return { kind: 'notes.read' };
  const noteAt = re(NOTE_ADD).exec(s);
  if (noteAt && noteAt.index <= 12) {
    const rest = s.slice(noteAt.index + noteAt[0].length - 1);
    return { kind: 'note.add', text: tidy(rest.replace(/^ (?:that|ki|dass|daß|:)(?= )/, ' ')) };
  }

  if (has(s, TIME)) return { kind: 'time' };
  if (has(s, DATE)) return { kind: 'date' };

  // a timer: "a timer for 10 minutes", "10 dakikalık zamanlayıcı", "remind me in 20 minutes to …"
  const dur = findDuration(s);
  if (dur && (has(s, TIMER) || (has(s, REMIND) && /(?:^| )(?:in|sonra|içinde)(?: |$)/.test(s)))) {
    let label: string | null = null;
    if (has(s, REMIND)) label = tidy(cut(cut(cut(s, REMIND), dur.src), "to|that|an|bana|beni|mich|daran|dass")) || null;
    return { kind: 'timer.set', seconds: dur.seconds, label };
  }

  // an alarm or a reminder at a time: "wake me at 6:30", "saat 7'ye alarm kur", "erinnere mich um 17 uhr an x"
  if (has(s, ALARM) || has(s, REMIND)) {
    const remind = has(s, REMIND);
    const t = findTime(s, remind ? 'event' : 'alarm');
    if (t) {
      let label: string | null = null;
      if (remind) {
        let rest = cut(s, REMIND);
        for (const w of t.src) rest = rest.replace(` ${w} `, ' ');
        const d = findDay(rest, now);
        if (d) rest = rest.replace(` ${d.src} `, ' ');
        label = tidy(cut(rest, "to|that|about|at|an|um|uhr|bana|beni|mich|daran|dass|saat|alarm|kur")) || null;
        // a reminder on another day than the clock's next hh:mm: the calendar can hold it, the clock cannot
        const day = findDay(s, now);
        if (day) {
          const at = new Date(day.date.getFullYear(), day.date.getMonth(), day.date.getDate(), t.h, t.m);
          const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.h, t.m);
          if (next <= now) next.setDate(next.getDate() + 1);
          if (at.getTime() !== next.getTime() && at > now) return { kind: 'calendar.add', title: label ?? '', start: at, end: new Date(at.getTime() + 30 * 60000), allDay: false };
        }
      }
      return { kind: 'alarm.set', hour: t.h, minute: t.m, label };
    }
  }

  // messages: read
  const from = whoWrote(s);
  if (from || has(s, READ_MSG)) return { kind: 'messages.read', from: from && from !== '*' ? from : null };

  // messages: a draft (never sent by the secretary)
  const draft = draftOf(s);
  if (draft) return draft;

  // the calendar: read
  if (has(s, CAL_READ) && !has(s, CAL_ADD.replace('|termin', ''))) {
    const day = findDay(s, now);
    const d = day?.date ?? midnight(now);
    return { kind: 'calendar.read', from: d, to: plusDays(d, 1) };
  }

  // the calendar: add (needs a day or a time, else it is conversation)
  if (has(s, CAL_ADD)) {
    const day = findDay(s, now);
    const t = findTime(s, 'event');
    if (!day && !t) return null;
    let rest = s;
    if (day) rest = rest.replace(` ${day.src} `, ' ');
    for (const w of t?.src ?? []) rest = rest.replace(` ${w} `, ' ');
    rest = cut(rest, CAL_ADD.replace('|termin', ''));
    rest = cut(rest, CAL_FILLER);
    let title = tidy(rest);
    if (!title && has(s, 'termin')) title = 'termin';
    if (!title) return null;
    const base = day?.date ?? midnight(now);
    if (!t) return { kind: 'calendar.add', title, start: base, end: plusDays(base, 1), allDay: true };
    let start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), t.h, t.m);
    if (!day && start <= now) start = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, t.h, t.m); // "add gym at 6" said at 20:00 is tomorrow
    return { kind: 'calendar.add', title, start, end: new Date(start.getTime() + 3600000), allDay: false };
  }

  return null;
}

/** "what did anna write", "anna ne yazdı", "was hat anna geschrieben", "messages from anna"; '*' for no name. */
function whoWrote(s: string): string | null {
  let x: RegExpExecArray | null;
  if ((x = / what did (.+?) (?:write|say|send|text)(?: me)? /.exec(s))) return name(x[1]);
  if ((x = / (?:messages?|texts?) from (.+?) (?:say|said)? ?$/.exec(s)) || (x = / (?:messages?|texts?) from (.+?) $/.exec(s))) return name(x[1]);
  if ((x = / did (.+?) (?:write|text|message|call)(?: me)? /.exec(s))) return name(x[1]);
  if ((x = / ([^ ]+(?: [^ ]+)?) ne (?:yazdı|yazdi|dedi|demiş|yazmış|göndermiş) /.exec(s))) return name(x[1]);
  if ((x = / ([^ ]+?)'?(?:dan|den|tan|ten) (?:gelen )?(?:mesaj|mesajlar|mesajı|mesajları)/.exec(s))) return name(x[1]);
  if ((x = / was hat (.+?) (?:geschrieben|gesagt|geschickt) /.exec(s))) return name(x[1]);
  if ((x = / (?:nachrichten|nachricht) von (.+?) $/.exec(s))) return name(x[1]);
  return null;
}
const name = (raw: string) => {
  const n = tidy(raw.replace(/^(?:my|the|meine?n?|benim) /, '').replace(/ (?:bana|sana|me|mir)$/, ''));
  return n && !/^(?:i|ben|ich|you|sen|du)$/.test(n) ? n : null;
};

function draftOf(s: string): Intent | null {
  let x: RegExpExecArray | null;
  const out = (to: string | null, text: string): Intent | null => {
    const t = tidy(text);
    if (to && /^(?:me|mir|bana|ben|ich|mich)$/.test(tidy(to))) return null;
    return t ? { kind: 'message.draft', to: to ? tidy(to) : null, text: t } : null;
  };
  // english
  if ((x = / (?:send|write) (?:a )?(?:message|text|note|whatsapp) to (.+?) (?:saying|that|says) (.+) $/.exec(s))) return out(x[1], x[2]);
  if ((x = / (?:send|write|text|message|tell|reply to) (.+?) (?:saying|that|says) (.+) $/.exec(s))) return out(x[1], x[2]);
  if ((x = / (?:text|message) ([^ ]+) (.+) $/.exec(s)) && !/^(?:from|to)$/.test(x[1])) return out(x[1], x[2]);
  // turkish: "anna'ya mesaj gönder: yarın geliyorum" / "anna'ya yarın geliyorum diye mesaj at" / "anna'ya yaz geç kalacağım"
  if ((x = / ([^ ]+?)'?(?:ya|ye|a|e) (.+?) diye (?:bir )?(?:mesaj )?(?:at|gönder|gonder|yaz|ilet)/.exec(s))) return out(x[1], x[2]);
  // a name needs its apostrophe ("anna'ya yaz …") unless the word mesaj is there: "takvime yaz" is no draft
  if ((x = / ([^ ]+)'(?:ya|ye|a|e) (?:bir )?(?:mesaj )?(?:at|gönder|gonder|yaz|söyle|soyle|de ki|ilet)(?: ki)? (.+) $/.exec(s))) return out(x[1], x[2]);
  if ((x = / ([^ ]+?)(?:ya|ye|a|e) (?:bir )?mesaj (?:at|gönder|gonder|yaz|ilet)(?: ki)? (.+) $/.exec(s))) return out(x[1], x[2]);
  if ((x = / (?:mesaj (?:at|gönder|gonder|yaz)) (.+) $/.exec(s))) return out(null, x[1]);
  // german
  if ((x = / (?:schick|schicke|sende) (.+?) eine nachricht (?:dass )?(.+) $/.exec(s))) return out(x[1], x[2]);
  if ((x = / (?:sag|sage) (.+?) dass (.+) $/.exec(s))) return out(x[1], x[2]);
  if ((x = / (?:schreib|schreibe|antworte) (?:an )?([^ ]+) (?:dass )?(.+) $/.exec(s)) && !/^(?:auf|mir)$/.test(x[1])) return out(x[1], x[2]);
  return null;
}
