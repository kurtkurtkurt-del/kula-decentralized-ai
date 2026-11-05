// Talk mode's rule-based intent parser (voice/intents.ts) in tr / en / de, on a fixed clock:
// Thursday 5 November 2026, 10:00.
import { describe, expect, it } from '@jest/globals';
import { answer, findDay, findDuration, findTime, norm, parse, type Intent } from '@/voice/intents';

const NOW = new Date(2026, 10, 5, 10, 0);
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m);
const p = (text: string, lang: 'en' | 'de' | 'tr' = 'en', now = NOW) => parse(text, lang, now);
const add = (i: Intent | null) => {
  expect(i?.kind).toBe('calendar.add');
  return i as Extract<Intent, { kind: 'calendar.add' }>;
};

describe('norm', () => {
  it('lowercases Turkish right, keeps times and suffixes, drops punctuation', () => {
    expect(norm('Yarın 18.00’e SPOR ekle!', 'tr')).toBe(" yarın 18:00'e spor ekle ");
    expect(norm('IŞIK', 'tr')).toBe(' ışık ');
    expect(norm('Add gym at 6 p.m.', 'en')).toBe(' add gym at 6 pm ');
  });
});

describe('days and times', () => {
  it('finds relative days and weekdays', () => {
    expect(findDay(' yarın ', NOW)?.date).toEqual(new Date(2026, 10, 6));
    expect(findDay(' übermorgen ', NOW)?.date).toEqual(new Date(2026, 10, 7));
    expect(findDay(' on monday ', NOW)?.date).toEqual(new Date(2026, 10, 9));
    expect(findDay(' cuma günü ', NOW)?.date).toEqual(new Date(2026, 10, 6));
    expect(findDay(' cumartesi ', NOW)?.date).toEqual(new Date(2026, 10, 7));
    expect(findDay(' pazartesi ', NOW)?.date).toEqual(new Date(2026, 10, 9));
    expect(findDay(' am freitag ', NOW)?.date).toEqual(new Date(2026, 10, 6));
    expect(findDay(' next thursday ', NOW)?.date).toEqual(new Date(2026, 10, 12));
    expect(findDay(' thursday ', NOW)?.date).toEqual(new Date(2026, 10, 5));
    expect(findDay(' heute ', NOW)?.date).toEqual(new Date(2026, 10, 5));
    expect(findDay(' nothing here ', NOW)).toBeNull();
  });
  it('reads clock times in every form', () => {
    expect(findTime(" 18:00'e ", 'event')).toMatchObject({ h: 18, m: 0 });
    expect(findTime(' at 6 pm ', 'event')).toMatchObject({ h: 18, m: 0 });
    expect(findTime(' at 6:30 am ', 'event')).toMatchObject({ h: 6, m: 30 });
    expect(findTime(" akşam 7'de ", 'event')).toMatchObject({ h: 19, m: 0 });
    expect(findTime(" sabah 7'de ", 'event')).toMatchObject({ h: 7, m: 0 });
    expect(findTime(" saat 6'da ", 'event')).toMatchObject({ h: 18 }); // a bare 1–7 is the evening for an event
    expect(findTime(" saat 6'da ", 'alarm')).toMatchObject({ h: 6 }); // but the morning for an alarm
    expect(findTime(' um 18 uhr ', 'event')).toMatchObject({ h: 18, m: 0 });
    expect(findTime(' halb 7 ', 'alarm')).toMatchObject({ h: 6, m: 30 });
    expect(findTime(' 6 buçukta ', 'alarm')).toMatchObject({ h: 6, m: 30 });
    expect(findTime(' at noon ', 'event')).toMatchObject({ h: 12, m: 0 });
    expect(findTime(" gece 11'de ", 'event')).toMatchObject({ h: 23 });
    expect(findTime(' um 6 uhr abends ', 'event')).toMatchObject({ h: 18 });
    expect(findTime(' no time ', 'event')).toBeNull();
  });
  it('reads lengths of time', () => {
    expect(findDuration(' for 10 minutes ')?.seconds).toBe(600);
    expect(findDuration(' 10 dakikalık ')?.seconds).toBe(600);
    expect(findDuration(' yarım saat ')?.seconds).toBe(1800);
    expect(findDuration(' eine stunde ')?.seconds).toBe(3600);
    expect(findDuration(' 90 sekunden ')?.seconds).toBe(90);
  });
});

describe('calendar: add', () => {
  it('turkish: "yarın 18:00\'e spor ekle"', () => {
    const i = add(p("yarın 18:00'e spor ekle", 'tr'));
    expect(i.title).toBe('spor');
    expect(i.start).toEqual(at(6, 18));
    expect(i.end).toEqual(at(6, 19));
    expect(i.allDay).toBe(false);
  });
  it('turkish with a part of day and a weekday', () => {
    const i = add(p("cuma günü akşam 7'de spor salonu ekle", 'tr'));
    expect(i.title).toBe('spor salonu');
    expect(i.start).toEqual(at(6, 19));
    expect(add(p("yarın saat 6'da spor ekle", 'tr')).start).toEqual(at(6, 18));
  });
  it('english: "add gym tomorrow at 6 pm"', () => {
    const i = add(p('add gym tomorrow at 6 pm'));
    expect(i.title).toBe('gym');
    expect(i.start).toEqual(at(6, 18));
  });
  it('english with filler words', () => {
    const i = add(p('Add lunch with Anna to my calendar on Monday at noon.'));
    expect(i.title).toBe('lunch with anna');
    expect(i.start).toEqual(at(9, 12));
    expect(add(p('schedule a dentist appointment on friday at 9:30')).title).toBe('dentist appointment');
  });
  it('german: "füge morgen um 18 uhr sport hinzu" and "trag … ein"', () => {
    const i = add(p('Füge morgen um 18 Uhr Sport hinzu', 'de'));
    expect(i.title).toBe('sport');
    expect(i.start).toEqual(at(6, 18));
    const j = add(p('trag übermorgen um 10:30 zahnarzt ein', 'de'));
    expect(j.title).toBe('zahnarzt');
    expect(j.start).toEqual(at(7, 10, 30));
  });
  it('a day and no time is all day; a time already past today is tomorrow', () => {
    const i = add(p('add mom’s birthday on saturday'));
    expect(i.allDay).toBe(true);
    expect(i.start).toEqual(new Date(2026, 10, 7));
    expect(i.end).toEqual(new Date(2026, 10, 8));
    expect(add(p('add stretching at 9 am')).start).toEqual(at(6, 9));
    expect(add(p('add stretching at 11 am')).start).toEqual(at(5, 11));
  });
  it('no day and no time is conversation', () => {
    expect(p('add some salt to the soup')).toBeNull();
  });
});

describe('calendar: read', () => {
  it('today and tomorrow in three languages', () => {
    expect(p("what's on my calendar today")).toEqual({ kind: 'calendar.read', from: new Date(2026, 10, 5), to: new Date(2026, 10, 6) });
    expect(p('what do I have tomorrow')).toMatchObject({ kind: 'calendar.read', from: new Date(2026, 10, 6) });
    expect(p('yarın ne var', 'tr')).toMatchObject({ kind: 'calendar.read', from: new Date(2026, 10, 6) });
    expect(p('bugün programımda ne var', 'tr')).toMatchObject({ kind: 'calendar.read', from: new Date(2026, 10, 5) });
    expect(p('was habe ich morgen', 'de')).toMatchObject({ kind: 'calendar.read', from: new Date(2026, 10, 6) });
    expect(p('was steht heute an', 'de')).toMatchObject({ kind: 'calendar.read', from: new Date(2026, 10, 5) });
  });
});

describe('messages', () => {
  it('reads all, or from someone', () => {
    expect(p('read my messages')).toEqual({ kind: 'messages.read', from: null });
    expect(p('mesajlarımı oku', 'tr')).toEqual({ kind: 'messages.read', from: null });
    expect(p('yeni mesaj var mı', 'tr')).toEqual({ kind: 'messages.read', from: null });
    expect(p('lies meine Nachrichten', 'de')).toEqual({ kind: 'messages.read', from: null });
    expect(p('what did Anna write')).toEqual({ kind: 'messages.read', from: 'anna' });
    expect(p('Anna ne yazdı', 'tr')).toEqual({ kind: 'messages.read', from: 'anna' });
    expect(p('annem bana ne yazdı', 'tr')).toEqual({ kind: 'messages.read', from: 'annem' });
    expect(p('was hat Tom geschrieben', 'de')).toEqual({ kind: 'messages.read', from: 'tom' });
  });
  it('drafts a message, never more', () => {
    expect(p("send a message to Anna saying I'm running late")).toEqual({ kind: 'message.draft', to: 'anna', text: "i'm running late" });
    expect(p("Anna'ya mesaj gönder yarın geliyorum", 'tr')).toEqual({ kind: 'message.draft', to: 'anna', text: 'yarın geliyorum' });
    expect(p("Anna'ya yarın geliyorum diye mesaj at", 'tr')).toEqual({ kind: 'message.draft', to: 'anna', text: 'yarın geliyorum' });
    expect(p('schreib Tom dass ich später komme', 'de')).toEqual({ kind: 'message.draft', to: 'tom', text: 'ich später komme' });
    expect(p('tell me that joke again')).toBeNull();
  });
});

describe('alarms, timers, reminders', () => {
  it('alarms', () => {
    expect(p('set an alarm for 7')).toEqual({ kind: 'alarm.set', hour: 7, minute: 0, label: null });
    expect(p('wake me up at 6:30')).toEqual({ kind: 'alarm.set', hour: 6, minute: 30, label: null });
    expect(p("yarın sabah 7'ye alarm kur", 'tr')).toEqual({ kind: 'alarm.set', hour: 7, minute: 0, label: null });
    expect(p('stell einen Wecker auf 6 Uhr', 'de')).toEqual({ kind: 'alarm.set', hour: 6, minute: 0, label: null });
  });
  it('timers', () => {
    expect(p('set a timer for 10 minutes')).toEqual({ kind: 'timer.set', seconds: 600, label: null });
    expect(p('10 dakikalık zamanlayıcı kur', 'tr')).toEqual({ kind: 'timer.set', seconds: 600, label: null });
    expect(p('Timer für 5 Minuten', 'de')).toEqual({ kind: 'timer.set', seconds: 300, label: null });
    expect(p('remind me in 20 minutes to call mom')).toEqual({ kind: 'timer.set', seconds: 1200, label: 'call mom' });
  });
  it('reminders at a time', () => {
    expect(p('remind me at 5 to call mom')).toEqual({ kind: 'alarm.set', hour: 17, minute: 0, label: 'call mom' });
    expect(p("bana 5'te anneyi aramayı hatırlat", 'tr')).toEqual({ kind: 'alarm.set', hour: 17, minute: 0, label: 'anneyi aramayı' });
    expect(p('erinnere mich um 17 Uhr an den Müll', 'de')).toEqual({ kind: 'alarm.set', hour: 17, minute: 0, label: 'den müll' });
  });
  it('a reminder on a later day than the clock can hold goes to the calendar', () => {
    const i = add(p('remind me on saturday at 9 am to water the plants'));
    expect(i.title).toBe('water the plants');
    expect(i.start).toEqual(at(7, 9));
  });
});

describe('time, date, notes, the end', () => {
  it('time and date', () => {
    expect(p('what time is it')).toEqual({ kind: 'time' });
    expect(p('saat kaç', 'tr')).toEqual({ kind: 'time' });
    expect(p('wie spät ist es', 'de')).toEqual({ kind: 'time' });
    expect(p("what's the date")).toEqual({ kind: 'date' });
    expect(p('bugün günlerden ne', 'tr')).toEqual({ kind: 'date' });
    expect(p('der wievielte ist heute', 'de')).toEqual({ kind: 'date' });
  });
  it('notes', () => {
    expect(p('take a note buy milk')).toEqual({ kind: 'note.add', text: 'buy milk' });
    expect(p("not al: yarın 6'da spor", 'tr')).toEqual({ kind: 'note.add', text: "yarın 6'da spor" });
    expect(p('notiere Brot kaufen', 'de')).toEqual({ kind: 'note.add', text: 'brot kaufen' });
    expect(p('read my notes')).toEqual({ kind: 'notes.read' });
    expect(p('notlarımı oku', 'tr')).toEqual({ kind: 'notes.read' });
    expect(p('lies meine Notizen', 'de')).toEqual({ kind: 'notes.read' });
    expect(p('delete my notes')).toEqual({ kind: 'notes.clear' });
    expect(p('notlarımı sil', 'tr')).toEqual({ kind: 'notes.clear' });
  });
  it('bye ends talk mode; anything else is conversation', () => {
    expect(p('bye')).toEqual({ kind: 'end' });
    expect(p('görüşürüz', 'tr')).toEqual({ kind: 'end' });
    expect(p('tschüss', 'de')).toEqual({ kind: 'end' });
    expect(p('why is the sky blue')).toBeNull();
    expect(p('bana bir fıkra anlat', 'tr')).toBeNull();
    expect(p('')).toBeNull();
  });
});

describe('yes / no', () => {
  it('in three languages, no wins', () => {
    for (const w of ['yes', 'yeah sure', 'okay do it']) expect(answer(w, 'en')).toBe('yes');
    for (const w of ['evet', 'tamam ekle', 'olur']) expect(answer(w, 'tr')).toBe('yes');
    for (const w of ['ja', 'genau', 'ja bitte']) expect(answer(w, 'de')).toBe('yes');
    for (const w of ['no', 'cancel', "don't"]) expect(answer(w, 'en')).toBe('no');
    for (const w of ['hayır', 'iptal', 'tamam iptal et', 'vazgeç']) expect(answer(w, 'tr')).toBe('no');
    for (const w of ['nein', 'abbrechen', 'lieber nicht']) expect(answer(w, 'de')).toBe('no');
    expect(answer('what is the weather', 'en')).toBeNull();
  });
});
