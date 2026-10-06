export type CalendarEvent = {
  uid: string;
  summary: string;
  /** UTC with `Z`, local time with TZID, `YYYY-MM-DD` for all-day */
  start: string;
  end: string;
  allDay: boolean;
  timeZone?: string;
  location?: string;
  description?: string;
};

type Property = {
  name: string;
  params: Record<string, string>;
  value: string;
};

type DateValue = {
  iso: string;
  allDay: boolean;
  timeZone?: string;
};

const FOLDED_LINE_BREAK = /\r?\n[ \t]/g;
const LINE_BREAK = /\r?\n/;
const TEXT_ESCAPE = /\\([\\;,nN])/g;
const DATE_TIME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;
const DATE = /^(\d{4})(\d{2})(\d{2})$/;
const ISO_DATE_LENGTH = 10;

function unescapeText(value: string): string {
  return value.replace(TEXT_ESCAPE, (_, char: string) =>
    char === "n" || char === "N" ? "\n" : char,
  );
}

function parseProperty(line: string): Property {
  const colon = line.indexOf(":");
  const [name = "", ...rawParams] = line.slice(0, colon).split(";");
  const params = Object.fromEntries(
    rawParams.map((param) => {
      const [key = "", value = ""] = param.split("=");
      return [key.toUpperCase(), value];
    }),
  );
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}

function parseDate(property: Property): DateValue {
  const date = DATE.exec(property.value);
  if (date) {
    const [, y, mo, d] = date;
    return { iso: `${y}-${mo}-${d}`, allDay: true };
  }
  const [, y, mo, d, h, mi, s, utc] = DATE_TIME.exec(property.value) ?? [];
  const timeZone = property.params.TZID;
  return {
    iso: `${y}-${mo}-${d}T${h}:${mi}:${s}${utc}`,
    allDay: false,
    ...(timeZone === undefined ? {} : { timeZone }),
  };
}

function nextDay(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, ISO_DATE_LENGTH);
}

function toEvent(properties: Property[]): CalendarEvent {
  const get = (name: string) => properties.find((p) => p.name === name);
  const text = (name: string) => {
    const value = get(name)?.value;
    return value === undefined ? undefined : unescapeText(value);
  };
  const dtstart = get("DTSTART");
  if (!dtstart) {
    throw new Error(`VEVENT ${get("UID")?.value} has no DTSTART`);
  }
  const start = parseDate(dtstart);
  const dtend = get("DTEND");
  const end = dtend
    ? parseDate(dtend).iso
    : start.allDay
      ? nextDay(start.iso)
      : start.iso;
  const location = text("LOCATION");
  const description = text("DESCRIPTION");
  return {
    uid: get("UID")?.value ?? "",
    summary: text("SUMMARY") ?? "",
    start: start.iso,
    end,
    allDay: start.allDay,
    ...(start.timeZone === undefined ? {} : { timeZone: start.timeZone }),
    ...(location === undefined ? {} : { location }),
    ...(description === undefined ? {} : { description }),
  };
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

export function parseEvents(ics: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  let current: Property[] | undefined;
  let nestedDepth = 0;
  for (const line of ics.replace(FOLDED_LINE_BREAK, "").split(LINE_BREAK)) {
    if (line === "BEGIN:VEVENT") {
      current = [];
    } else if (line === "END:VEVENT" && current) {
      events.push(toEvent(current));
      current = undefined;
    } else if (current && line.startsWith("BEGIN:")) {
      nestedDepth++;
    } else if (current && line.startsWith("END:")) {
      nestedDepth--;
    } else if (current && nestedDepth === 0 && line.includes(":")) {
      current.push(parseProperty(line));
    }
  }
  return events;
}
