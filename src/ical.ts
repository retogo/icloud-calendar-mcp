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
  /** UTC offset of the user, used for all-day dates and floating times */
  localOffsetSeconds: number;
};

type Occurrence = {
  item: ICAL.Event;
  startDate: ICAL.Time;
  endDate: ICAL.Time;
};

export type SkippedEvent = {
  uid: string;
  summary: string;
};

/** A daily rule reaches 54 years before an event is skipped */
const MAX_ITERATIONS_PER_EVENT = 20_000;
const MAX_ITERATIONS_PER_REQUEST = 100_000;
const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * MILLISECONDS_PER_SECOND;

/**
 * Bounds the CPU spent expanding recurrences for one request. Events that
 * would exceed it are skipped and reported instead of failing the request.
 */
export class RecurrenceBudget {
  readonly skipped: SkippedEvent[] = [];
  #remaining: number;

  constructor(limit = MAX_ITERATIONS_PER_REQUEST) {
    this.#remaining = limit;
  }

  /** Consumes one iteration; false once the budget is spent */
  take(): boolean {
    if (this.#remaining === 0) {
      return false;
    }
    this.#remaining--;
    return true;
  }

  skip(event: SkippedEvent): void {
    this.skipped.push(event);
  }
}
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

/** All-day dates and floating times are wall-clock times of the user */
function instantMs(time: ICAL.Time, period: Period): number {
  if (!time.isDate && !isFloating(time)) {
    return time.toJSDate().getTime();
  }
  const wallMs = Date.UTC(
    time.year,
    time.month - 1,
    time.day,
    time.isDate ? 0 : time.hour,
    time.isDate ? 0 : time.minute,
    time.isDate ? 0 : time.second,
  );
  return wallMs - period.localOffsetSeconds * MILLISECONDS_PER_SECOND;
}

/** Zero-length events count when they start inside the period */
function overlaps(occurrence: Occurrence, period: Period): boolean {
  const start = instantMs(occurrence.startDate, period);
  const end = instantMs(occurrence.endDate, period);
  const periodStart = period.start.getTime();
  return (
    start < period.end.getTime() && (end > periodStart || start >= periodStart)
  );
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

/** `modified` holds the RECURRENCE-IDs of overridden occurrences, which may move into the period */
function occurrencesOf(
  event: ICAL.Event,
  modified: ReadonlySet<string>,
  period: Period,
  budget: RecurrenceBudget,
): Occurrence[] {
  if (!event.isRecurring()) {
    return [
      { item: event, startDate: event.startDate, endDate: event.endDate },
    ];
  }
  // ICAL.Time compares dates and floating times as UTC, so widen the bounds
  // by a day and let `overlaps` decide with the user's offset
  const periodEnd = ICAL.Time.fromJSDate(
    new Date(period.end.getTime() + MILLISECONDS_PER_DAY),
    true,
  );
  // Unmodified occurrences starting earlier end before the period begins
  const windowStart = ICAL.Time.fromJSDate(
    new Date(
      period.start.getTime() -
        event.duration.toSeconds() * MILLISECONDS_PER_SECOND -
        MILLISECONDS_PER_DAY,
    ),
    true,
  );
  const occurrences: Occurrence[] = [];
  const iterator = event.iterator();
  let iterations = 0;
  for (
    let next = iterator.next();
    next && next.compare(periodEnd) < 0;
    next = iterator.next()
  ) {
    iterations++;
    if (iterations > MAX_ITERATIONS_PER_EVENT || !budget.take()) {
      budget.skip({ uid: event.uid, summary: event.summary ?? "" });
      return [];
    }
    if (next.compare(windowStart) >= 0 || modified.has(next.toString())) {
      occurrences.push(event.getOccurrenceDetails(next));
    }
  }
  return occurrences;
}

const INTL_LOCALE = "en-US";
const HOURS_PER_DAY = 24;

function referencedTimeZones(calendar: ICAL.Component): Set<string> {
  const tzids = new Set<string>();
  for (const event of calendar.getAllSubcomponents("vevent")) {
    for (const property of event.getAllProperties()) {
      const tzid = property.getParameter("tzid");
      if (typeof tzid === "string") {
        tzids.add(tzid);
      }
    }
  }
  return tzids;
}

function isIanaTimeZone(tzid: string): boolean {
  try {
    new Intl.DateTimeFormat(INTL_LOCALE, { timeZone: tzid });
    return true;
  } catch {
    return false;
  }
}

/** Seconds that `timeZone` is ahead of UTC at the instant `utcMs` */
function offsetAt(utcMs: number, formatter: Intl.DateTimeFormat): number {
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(utcMs))
      .map((part) => [part.type, Number(part.value)]),
  );
  const wallMs = Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    (parts.hour ?? 0) % HOURS_PER_DAY,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  return Math.round((wallMs - utcMs) / MILLISECONDS_PER_SECOND);
}

/** An ical.js zone whose offsets come from the runtime's IANA database */
function intlTimeZone(tzid: string): ICAL.Timezone {
  const formatter = new Intl.DateTimeFormat(INTL_LOCALE, {
    timeZone: tzid,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  const zone = ICAL.Timezone.fromData({ tzid });
  zone.utcOffset = (time: ICAL.Time) => {
    const wallMs = Date.UTC(
      time.year,
      time.month - 1,
      time.day,
      time.hour,
      time.minute,
      time.second,
    );
    // The offset at the wall time's own instant, refined once for DST shifts
    const guess = offsetAt(wallMs, formatter);
    return offsetAt(wallMs - guess * MILLISECONDS_PER_SECOND, formatter);
  };
  return zone;
}

/**
 * Parses calendar data into events overlapping `period`, expanding recurrence
 * rules so that servers which ignore CalDAV `expand` still yield occurrences
 */
export function parseEvents(
  ics: string,
  period: Period,
  budget: RecurrenceBudget,
): CalendarEvent[] {
  const calendar = new ICAL.Component(ICAL.parse(ics));
  // The zone registry is global to the isolate; scope it to this calendar
  try {
    for (const zone of calendar.getAllSubcomponents("vtimezone")) {
      ICAL.TimezoneService.register(zone);
    }
    // iCloud omits VTIMEZONE; resolve IANA names from the runtime's tz database
    for (const tzid of referencedTimeZones(calendar)) {
      if (!ICAL.TimezoneService.has(tzid) && isIanaTimeZone(tzid)) {
        ICAL.TimezoneService.register(intlTimeZone(tzid));
      }
    }
    return expandEvents(calendar, period, budget);
  } finally {
    ICAL.TimezoneService.reset();
  }
}

function expandEvents(
  calendar: ICAL.Component,
  period: Period,
  budget: RecurrenceBudget,
): CalendarEvent[] {
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
      const overrides = exceptions.filter(
        (c) => c.getFirstPropertyValue("uid") === uid,
      );
      return {
        event: new ICAL.Event(master, { exceptions: overrides }),
        modified: new Set(
          overrides.map((c) =>
            String(c.getFirstPropertyValue("recurrence-id")),
          ),
        ),
      };
    }),
    ...orphans.map((orphan) => ({
      event: new ICAL.Event(orphan),
      modified: new Set<string>(),
    })),
  ];
  return events
    .flatMap(({ event, modified }) =>
      occurrencesOf(event, modified, period, budget),
    )
    .filter((occurrence) => overlaps(occurrence, period))
    .map(toCalendarEvent);
}

export type NewEvent = Omit<CalendarEvent, "timeZone">;

/** Omitted fields stay as they are; `null` removes a field */
export type EventChanges = {
  summary?: string;
  location?: string | null;
  description?: string | null;
} & (
  | { start: string; end: string; allDay: boolean }
  | { start?: undefined; end?: undefined; allDay?: undefined }
);

const ANY_LINE_BREAK = /\r\n?/g;

function setText(
  component: ICAL.Component,
  name: string,
  value: string | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null) {
    component.removeAllProperties(name);
    return;
  }
  component.updatePropertyWithValue(name, value.replace(ANY_LINE_BREAK, "\n"));
}

function setBoundary(
  component: ICAL.Component,
  name: string,
  value: string,
  allDay: boolean,
): void {
  const property = new ICAL.Property(name);
  property.setValue(
    allDay
      ? ICAL.Time.fromDateString(value)
      : ICAL.Time.fromJSDate(new Date(value), true),
  );
  component.removeAllProperties(name);
  component.addProperty(property);
}

/**
 * Edits the series (the VEVENT without RECURRENCE-ID) in place so that
 * alarms, attendees, recurrence rules and overridden occurrences survive
 */
export function applyEventChanges(
  ics: string,
  changes: EventChanges,
  now: Date,
): string {
  const calendar = new ICAL.Component(ICAL.parse(ics));
  const series = calendar
    .getAllSubcomponents("vevent")
    .find((component) => !component.hasProperty("recurrence-id"));
  if (!series) {
    throw new Error("The event has no series to update");
  }
  setText(series, "summary", changes.summary);
  setText(series, "location", changes.location);
  setText(series, "description", changes.description);
  if (changes.start !== undefined) {
    setBoundary(series, "dtstart", changes.start, changes.allDay);
    setBoundary(series, "dtend", changes.end, changes.allDay);
    series.removeAllProperties("duration");
  }
  const sequence = Number(series.getFirstPropertyValue("sequence") ?? 0);
  series.updatePropertyWithValue("sequence", sequence + 1);
  series.updatePropertyWithValue("dtstamp", ICAL.Time.fromJSDate(now, true));
  return calendar.toString();
}

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
