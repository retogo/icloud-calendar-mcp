import ICAL from "ical.js";

export type CalendarEvent = {
  uid: string;
  summary: string;
  /**
   * ISO 8601: `YYYY-MM-DD` for all-day events, `Z` for UTC, the occurrence's
   * UTC offset for times in a time zone, and no offset for floating times
   */
  start: string;
  end: string;
  allDay: boolean;
  /** IANA name of the event's time zone, when it has one */
  timeZone?: string;
  location?: string;
  description?: string;
};

export type Period = {
  start: Date;
  end: Date;
};

type Occurrence = {
  item: ICAL.Event;
  startDate: ICAL.Time;
  endDate: ICAL.Time;
};

const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;
const OFFSET_PAD = 2;

function formatOffset(seconds: number): string {
  const sign = seconds < 0 ? "-" : "+";
  const absolute = Math.abs(seconds);
  const hours = Math.floor(absolute / SECONDS_PER_HOUR);
  const minutes = Math.floor(
    (absolute % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE,
  );
  return `${sign}${String(hours).padStart(OFFSET_PAD, "0")}:${String(minutes).padStart(OFFSET_PAD, "0")}`;
}

function isFloating(time: ICAL.Time): boolean {
  return !time.zone || time.zone === ICAL.Timezone.localTimezone;
}

/** `toString()` already ends UTC times with `Z` */
function formatTime(time: ICAL.Time): string {
  return time.isDate ||
    isFloating(time) ||
    time.zone === ICAL.Timezone.utcTimezone
    ? time.toString()
    : `${time.toString()}${formatOffset(time.utcOffset())}`;
}

function timeZoneOf(time: ICAL.Time): string | undefined {
  return time.isDate ||
    isFloating(time) ||
    time.zone === ICAL.Timezone.utcTimezone
    ? undefined
    : time.zone.tzid;
}

/** Zero-length events count when they start inside the period */
function overlaps(occurrence: Occurrence, period: Period): boolean {
  const start = occurrence.startDate.toJSDate();
  const end = occurrence.endDate.toJSDate();
  return start < period.end && (end > period.start || start >= period.start);
}

function toCalendarEvent({
  item,
  startDate,
  endDate,
}: Occurrence): CalendarEvent {
  const timeZone = timeZoneOf(startDate);
  const location = item.location ?? undefined;
  const description = item.description ?? undefined;
  return {
    uid: item.uid,
    summary: item.summary ?? "",
    start: formatTime(startDate),
    end: formatTime(endDate),
    allDay: startDate.isDate,
    ...(timeZone === undefined ? {} : { timeZone }),
    ...(location === undefined ? {} : { location }),
    ...(description === undefined ? {} : { description }),
  };
}

function occurrencesOf(event: ICAL.Event, period: Period): Occurrence[] {
  if (!event.isRecurring()) {
    return [
      { item: event, startDate: event.startDate, endDate: event.endDate },
    ];
  }
  const occurrences: Occurrence[] = [];
  const iterator = event.iterator();
  for (
    let next = iterator.next();
    next && next.toJSDate() < period.end;
    next = iterator.next()
  ) {
    occurrences.push(event.getOccurrenceDetails(next));
  }
  return occurrences;
}

/**
 * Parses calendar data into events overlapping `period`, expanding recurrence
 * rules so that servers which ignore CalDAV `expand` still yield occurrences
 */
export function parseEvents(ics: string, period: Period): CalendarEvent[] {
  const calendar = new ICAL.Component(ICAL.parse(ics));
  for (const zone of calendar.getAllSubcomponents("vtimezone")) {
    ICAL.TimezoneService.register(zone);
  }
  const components = calendar.getAllSubcomponents("vevent");
  const isException = (component: ICAL.Component) =>
    component.hasProperty("recurrence-id");
  const masters = components.filter((c) => !isException(c));
  const masterUids = new Set(
    masters.map((c) => String(c.getFirstPropertyValue("uid"))),
  );
  const exceptions = components.filter(isException);
  const orphans = exceptions.filter(
    (c) => !masterUids.has(String(c.getFirstPropertyValue("uid"))),
  );
  const events = [
    ...masters.map((master) => {
      const uid = master.getFirstPropertyValue("uid");
      return new ICAL.Event(master, {
        exceptions: exceptions.filter(
          (c) => c.getFirstPropertyValue("uid") === uid,
        ),
      });
    }),
    ...orphans.map((orphan) => new ICAL.Event(orphan)),
  ];
  return events
    .flatMap((event) => occurrencesOf(event, period))
    .filter((occurrence) => overlaps(occurrence, period))
    .map(toCalendarEvent);
}

export type NewEvent = Omit<CalendarEvent, "timeZone">;

const PRODID = "-//icloud-calendar-mcp//EN";
const CRLF = "\r\n";
const MAX_LINE_OCTETS = 75;
const FOLD_PREFIX = " ";
const TEXT_SPECIALS = /\r\n|[\\;,\r\n]/g;
const ISO_SEPARATORS = /[-:]|\.\d{3}/g;
const utf8 = new TextEncoder();

function escapeText(value: string): string {
  return value.replace(TEXT_SPECIALS, (char) =>
    char.endsWith("\n") || char === "\r" ? "\\n" : `\\${char}`,
  );
}

function toUtcDateTime(date: Date): string {
  return date.toISOString().replace(ISO_SEPARATORS, "");
}

function foldLine(line: string): string[] {
  const lines: string[] = [];
  let current = "";
  let octets = 0;
  for (const char of line) {
    const size = utf8.encode(char).length;
    if (octets + size > MAX_LINE_OCTETS) {
      lines.push(current);
      current = FOLD_PREFIX;
      octets = FOLD_PREFIX.length;
    }
    current += char;
    octets += size;
  }
  lines.push(current);
  return lines;
}

function dateProperty(name: string, value: string, allDay: boolean): string {
  return allDay
    ? `${name};VALUE=DATE:${value.replaceAll("-", "")}`
    : `${name}:${toUtcDateTime(new Date(value))}`;
}

export function buildEvent(event: NewEvent, now: Date): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODID}`,
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${toUtcDateTime(now)}`,
    dateProperty("DTSTART", event.start, event.allDay),
    dateProperty("DTEND", event.end, event.allDay),
    `SUMMARY:${escapeText(event.summary)}`,
    ...(event.location === undefined
      ? []
      : [`LOCATION:${escapeText(event.location)}`]),
    ...(event.description === undefined
      ? []
      : [`DESCRIPTION:${escapeText(event.description)}`]),
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.flatMap(foldLine).join(CRLF)}${CRLF}`;
}
