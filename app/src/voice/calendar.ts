import * as Calendar from 'expo-calendar';

// The phone's calendar for the secretary, through expo-calendar (SDK 57's object API). Read:
// every visible calendar's events in a window. Write: one event into the primary writable
// calendar (Android has no single default: the primary one of an account, else the first
// that allows changes). The permission is asked the first time a calendar sentence is heard.
export type CalEvent = { title: string; start: Date; end: Date; allDay: boolean };
export type CalendarApi = {
  permission(ask: boolean): Promise<boolean>;
  events(from: Date, to: Date): Promise<CalEvent[]>;
  add(e: CalEvent): Promise<boolean>;
};

const asDate = (d: string | Date) => (d instanceof Date ? d : new Date(d));

export const phoneCalendar: CalendarApi = {
  async permission(ask) {
    const now = await Calendar.getCalendarPermissions();
    if (now.granted || !ask) return now.granted;
    if (!now.canAskAgain) return false;
    return (await Calendar.requestCalendarPermissions()).granted;
  },
  async events(from, to) {
    const cals = (await Calendar.getCalendars()).filter((c) => c.isVisible !== false);
    if (!cals.length) return [];
    const list = await Calendar.listEvents(cals.map((c) => c.id), from, to);
    return list
      .map((e) => ({ title: e.title || '', start: asDate(e.startDate), end: asDate(e.endDate), allDay: !!e.allDay }))
      .sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.getTime() - b.start.getTime());
  },
  async add(e) {
    const cals = (await Calendar.getCalendars()).filter((c) => c.allowsModifications);
    const cal = cals.find((c) => c.isPrimary && c.isVisible !== false) ?? cals.find((c) => c.isVisible !== false) ?? cals[0];
    if (!cal) return false;
    await cal.createEvent({
      title: e.title,
      startDate: e.start,
      endDate: e.end,
      allDay: e.allDay,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    return true;
  },
};
