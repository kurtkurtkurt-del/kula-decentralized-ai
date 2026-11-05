import type { BrainEntry, Tone } from '@/llm/brainlog';
import type { CalendarApi, CalEvent } from '@/voice/calendar';
import { answer, parse, type Intent, type VLang } from '@/voice/intents';
import type { Msg, VoiceNative } from '@/voice/native';
import type { NotesApi } from '@/voice/notes';

// The secretary's hands: what an intent (voice/intents.ts) does on this phone, and the one
// rule that guards every change: anything that writes (a calendar entry, an alarm, a timer,
// a draft, clearing the notes) is read back first and only done after a yes. Reading (the
// calendar, the messages, the notes, the time) is done at once. Every tool call goes to the
// brain tab's decisions log as a 'voice' line: what was heard, what was done, confirmed or not.
//
// Nothing here talks to the network. A draft opens the messaging app with the text filled in;
// the user sends it there.

type Tx = (key: string, fallback?: string, vars?: Record<string, string | number>) => string;
export type ToolDeps = {
  lang: VLang;
  now: () => Date;
  tx: Tx; // the translator of the voice's language
  calendar: CalendarApi;
  native: VoiceNative | null;
  notes: NotesApi;
  log: (e: BrainEntry) => void;
};

/** What the secretary does with an utterance: say this, or hand it to the model. */
export type Outcome =
  | { kind: 'say'; text: string; end?: boolean; open?: 'notificationAccess' | 'calendarPermission' }
  | { kind: 'chat' };

export const READ_MAX = 5; // messages / events read aloud at once

// ---- speaking dates and times -------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');

/** "18:30" (tr, de) or "6:30 pm" (en). */
export function clock(d: Date, lang: VLang): string {
  if (lang !== 'en') return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const h = d.getHours() % 12 || 12;
  const ap = d.getHours() < 12 ? 'am' : 'pm';
  return d.getMinutes() ? `${h}:${pad(d.getMinutes())} ${ap}` : `${h} ${ap}`;
}

/** "today", "tomorrow", "on friday", or "on 14 december". */
export function dayName(d: Date, now: Date, tx: Tx): string {
  const a = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const b = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((b - a) / 86400000);
  if (diff === 0) return tx('voice.when.today');
  if (diff === 1) return tx('voice.when.tomorrow');
  if (diff > 1 && diff < 7) return tx('voice.when.weekday', undefined, { day: tx(`voice.day.${d.getDay()}`) });
  return tx('voice.when.date', undefined, { d: d.getDate(), month: tx(`voice.month.${d.getMonth()}`) });
}

/** A day and a time as one phrase: "tomorrow at 18:00", "today, all day". */
export function when(d: Date, allDay: boolean, now: Date, lang: VLang, tx: Tx): string {
  const day = dayName(d, now, tx);
  return allDay ? tx('voice.when.allDay', undefined, { day }) : tx('voice.when.at', undefined, { day, time: clock(d, lang) });
}

const duration = (seconds: number, tx: Tx) =>
  seconds % 3600 === 0 ? tx(seconds === 3600 ? 'voice.dur.hour' : 'voice.dur.hours', undefined, { n: seconds / 3600 })
    : seconds % 60 === 0 ? tx(seconds === 60 ? 'voice.dur.minute' : 'voice.dur.minutes', undefined, { n: seconds / 60 })
      : tx('voice.dur.seconds', undefined, { n: seconds });

// ---- messages -----------------------------------------------------------------------------

/**
 * The messages from someone, newest first. Loosely: "annem" finds "Annem ❤️", "anna" finds
 * "Anna Schulz", a Turkish ending on the heard name is allowed ("tomun" → "Tom").
 */
export function pickMessages(list: Msg[], from: string | null, max = READ_MAX): Msg[] {
  const newest = [...list].sort((a, b) => b.at - a.at);
  if (!from) return newest.slice(0, max);
  const want = from.toLowerCase().replace(/'.*$/, '');
  const words = want.split(' ').filter((w) => w.length > 1);
  return newest
    .filter((m) => {
      const t = m.title.toLowerCase();
      return t.includes(want) || words.some((w) => t.split(/[^\p{L}\p{N}]+/u).some((x) => x && (x.startsWith(w) || (w.startsWith(x) && w.length - x.length <= 3)) && Math.min(x.length, w.length) >= 3));
    })
    .slice(0, max);
}

// ---- the secretary ------------------------------------------------------------------------

type Pending = { intent: Intent; heard: string; asked: number; question: string };

export class Secretary {
  private pending: Pending | null = null;
  constructor(private deps: ToolDeps) {}

  /** Whether a yes/no question is waiting (the screen shows it). */
  waiting(): string | null {
    return this.pending?.question ?? null;
  }
  setLang(lang: VLang, tx: Tx) {
    this.deps = { ...this.deps, lang, tx };
  }
  forget() {
    this.pending = null;
  }

  async handle(heard: string): Promise<Outcome> {
    const { tx, lang } = this.deps;
    if (this.pending) {
      const p = this.pending;
      const a = answer(heard, lang);
      if (a === 'yes') {
        this.pending = null;
        return this.run(p.intent, p.heard, true);
      }
      if (a === 'no') {
        this.pending = null;
        this.note('brain.voice.declined', { what: p.question }, p.heard, 'warn');
        return { kind: 'say', text: tx('voice.say.cancelled') };
      }
      if (p.asked < 2) {
        p.asked++;
        return { kind: 'say', text: tx('voice.say.yesOrNo', undefined, { q: p.question }) };
      }
      // twice unclear: the question is dropped and the words are taken as new
      this.pending = null;
    }
    const intent = parse(heard, lang, this.deps.now());
    if (!intent) return { kind: 'chat' };
    const question = this.question(intent);
    if (question) {
      this.pending = { intent, heard, asked: 0, question };
      return { kind: 'say', text: question };
    }
    return this.run(intent, heard, false);
  }

  /** The read-back for anything that writes, or null for what is done at once. */
  private question(i: Intent): string | null {
    const { tx, lang } = this.deps;
    const now = this.deps.now();
    switch (i.kind) {
      case 'calendar.add':
        return tx('voice.ask.calendar', undefined, { title: i.title || tx('voice.reminder'), when: when(i.start, i.allDay, now, lang, tx) });
      case 'alarm.set': {
        const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), i.hour, i.minute);
        if (at <= now) at.setDate(at.getDate() + 1);
        return tx(i.label ? 'voice.ask.reminder' : 'voice.ask.alarm', undefined, { when: when(at, false, now, lang, tx), label: i.label ?? '' });
      }
      case 'timer.set':
        return tx(i.label ? 'voice.ask.timerLabel' : 'voice.ask.timer', undefined, { len: duration(i.seconds, tx), label: i.label ?? '' });
      case 'message.draft':
        return tx(i.to ? 'voice.ask.draftTo' : 'voice.ask.draft', undefined, { to: i.to ?? '', text: i.text });
      case 'notes.clear':
        return this.deps.notes.list().length ? tx('voice.ask.notesClear', undefined, { n: this.deps.notes.list().length }) : null;
      default:
        return null;
    }
  }

  private note(key: string, vars: Record<string, string | number>, heard: string, tone: Tone = 'ok') {
    try {
      this.deps.log({ at: this.deps.now().getTime(), kind: 'voice', key, vars, detail: `“${heard}”`, tone });
    } catch {}
  }

  private async run(i: Intent, heard: string, confirmed: boolean): Promise<Outcome> {
    const { tx, lang, native, calendar, notes } = this.deps;
    const now = this.deps.now();
    const said = (text: string, extra: Partial<Extract<Outcome, { kind: 'say' }>> = {}): Outcome => ({ kind: 'say', text, ...extra });
    const yes = confirmed ? tx('voice.log.confirmed') : '';
    try {
      switch (i.kind) {
        case 'end':
          return said(tx('voice.say.bye'), { end: true });

        case 'time':
          this.note('brain.voice.clock', {}, heard, 'info');
          return said(tx('voice.say.time', undefined, { time: clock(now, lang) }));

        case 'date':
          this.note('brain.voice.clock', {}, heard, 'info');
          return said(tx('voice.say.date', undefined, { day: tx(`voice.day.${now.getDay()}`), d: now.getDate(), month: tx(`voice.month.${now.getMonth()}`), y: now.getFullYear() }));

        case 'note.add':
          if (!i.text) return said(tx('voice.say.noteEmpty'));
          notes.add(i.text, now.getTime());
          this.note('brain.voice.note', { text: i.text }, heard);
          return said(tx('voice.say.noted'));

        case 'notes.read': {
          const list = notes.list();
          this.note('brain.voice.notesRead', { n: list.length }, heard, 'info');
          if (!list.length) return said(tx('voice.say.notesNone'));
          const last = list.slice(-READ_MAX).reverse();
          return said([tx('voice.say.notesCount', undefined, { n: list.length }), ...last.map((n) => `${n.text}.`)].join(' '));
        }

        case 'notes.clear': {
          const n = notes.list().length;
          if (!n) return said(tx('voice.say.notesNone'));
          notes.clear();
          this.note('brain.voice.notesClear', { n, yes }, heard, 'warn');
          return said(tx('voice.say.notesCleared'));
        }

        case 'calendar.read': {
          if (!(await calendar.permission(true))) {
            this.note('brain.voice.denied', { what: tx('voice.what.calendar') }, heard, 'warn');
            return said(tx('voice.say.calendarDenied'), { open: 'calendarPermission' });
          }
          const list = await calendar.events(i.from, i.to);
          const day = dayName(i.from, now, tx);
          this.note('brain.voice.calendarRead', { n: list.length, day }, heard, 'info');
          if (!list.length) return said(tx('voice.say.calendarEmpty', undefined, { day }));
          const parts = list.slice(0, READ_MAX).map((e: CalEvent) => (e.allDay ? tx('voice.say.eventAllDay', undefined, { title: e.title }) : tx('voice.say.event', undefined, { time: clock(e.start, lang), title: e.title })));
          const more = list.length > READ_MAX ? tx('voice.say.more', undefined, { n: list.length - READ_MAX }) : '';
          return said([tx('voice.say.calendarCount', undefined, { day, n: list.length }), ...parts, more].filter(Boolean).join(' '));
        }

        case 'calendar.add': {
          if (!(await calendar.permission(true))) {
            this.note('brain.voice.denied', { what: tx('voice.what.calendar') }, heard, 'warn');
            return said(tx('voice.say.calendarDenied'), { open: 'calendarPermission' });
          }
          const title = i.title || tx('voice.reminder');
          const ok = await calendar.add({ title, start: i.start, end: i.end, allDay: i.allDay });
          const w = when(i.start, i.allDay, now, lang, tx);
          if (!ok) {
            this.note('brain.voice.failed', { what: tx('voice.what.calendar') }, heard, 'bad');
            return said(tx('voice.say.noCalendar'));
          }
          this.note('brain.voice.calendarAdd', { title, when: w, yes }, heard);
          return said(tx('voice.say.calendarAdded', undefined, { title, when: w }));
        }

        case 'messages.read': {
          if (!native) return said(tx('voice.say.noNative'));
          if (!native.notificationAccess()) {
            this.note('brain.voice.denied', { what: tx('voice.what.messages') }, heard, 'warn');
            return said(tx('voice.say.needAccess'), { open: 'notificationAccess' });
          }
          const list = pickMessages(native.recentMessages(), i.from);
          this.note('brain.voice.messagesRead', { n: list.length, from: i.from ?? '—' }, heard, 'info');
          if (!list.length) return said(i.from ? tx('voice.say.noMessagesFrom', undefined, { from: i.from }) : tx('voice.say.noMessages'));
          const head = i.from ? tx('voice.say.messagesFrom', undefined, { n: list.length, from: i.from }) : tx('voice.say.messagesCount', undefined, { n: list.length });
          return said([head, ...list.map((m) => tx('voice.say.message', undefined, { who: m.title, app: m.app, text: m.text.replace(/[.!?…]*$/, '') }))].join(' '));
        }

        case 'message.draft': {
          if (!native) return said(tx('voice.say.noNative'));
          // a reply goes to the app the person last wrote from, when we know it
          const recent = i.to && native.notificationAccess() ? pickMessages(native.recentMessages(), i.to, 1)[0] : undefined;
          const ok = native.draftMessage(i.text, recent?.pkg ?? null);
          this.note(ok ? 'brain.voice.draft' : 'brain.voice.failed', ok ? { to: i.to ?? '—', app: recent?.app ?? '—', yes } : { what: tx('voice.what.draft') }, heard, ok ? 'ok' : 'bad');
          return said(ok ? tx('voice.say.drafted') : tx('voice.say.failed'));
        }

        case 'alarm.set': {
          if (!native) return said(tx('voice.say.noNative'));
          const ok = native.setAlarm(i.hour, i.minute, i.label);
          const time = `${pad(i.hour)}:${pad(i.minute)}`;
          this.note(ok ? 'brain.voice.alarm' : 'brain.voice.failed', ok ? { time, label: i.label ?? '—', yes } : { what: tx('voice.what.alarm') }, heard, ok ? 'ok' : 'bad');
          return said(ok ? tx('voice.say.alarmSet', undefined, { time: clock(new Date(2000, 0, 1, i.hour, i.minute), lang) }) : tx('voice.say.noClock'));
        }

        case 'timer.set': {
          if (!native) return said(tx('voice.say.noNative'));
          const ok = native.setTimer(i.seconds, i.label);
          const len = duration(i.seconds, tx);
          this.note(ok ? 'brain.voice.timer' : 'brain.voice.failed', ok ? { len, label: i.label ?? '—', yes } : { what: tx('voice.what.alarm') }, heard, ok ? 'ok' : 'bad');
          return said(ok ? tx('voice.say.timerSet', undefined, { len }) : tx('voice.say.noClock'));
        }
      }
    } catch (e) {
      this.note('brain.voice.failed', { what: i.kind }, `${heard} · ${e instanceof Error ? e.message : String(e)}`, 'bad');
      return said(tx('voice.say.failed'));
    }
    return { kind: 'chat' };
  }
}
