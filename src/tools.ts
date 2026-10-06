import type { CalDavClient, Calendar, StoredEvent } from "./caldav-client.ts";
import { type NewEvent, RecurrenceBudget, type SkippedEvent } from "./ical.ts";

export type CalendarStore = Pick<
  CalDavClient,
  "listCalendars" | "listEvents" | "createEvent" | "deleteEvent"
>;

export type ListEventsInput = {
  start: string;
  end: string;
  calendarUrls?: string[];
};

export type CreateEventInput = {
  calendarUrl: string;
  summary: string;
  /** Date-only (YYYY-MM-DD) means an all-day event */
  start: string;
  end: string;
  location?: string;
  description?: string;
};

export type DeleteEventInput = {
  eventUrl: string;
};

export type ListedEvent = StoredEvent & { calendar: string };

export type ListedEvents = {
  events: ListedEvent[];
  /** Recurring events too expensive to expand; they are missing from `events` */
  skipped: SkippedEvent[];
};

type Dependencies = {
  now: () => Date;
  newUid: () => string;
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const ISO_DATE_LENGTH = 10;

type PeriodKind = "date" | "dateTime";

function periodKind(value: string): PeriodKind | undefined {
  if (DATE_ONLY.test(value)) {
    const roundTrip = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(roundTrip.getTime()) &&
      roundTrip.toISOString().slice(0, ISO_DATE_LENGTH) === value
      ? "date"
      : undefined;
  }
  return DATE_TIME_WITH_OFFSET.test(value) && !Number.isNaN(Date.parse(value))
    ? "dateTime"
    : undefined;
}

function isAllDayPeriod(start: string, end: string): boolean {
  const kind = periodKind(start);
  if (kind === undefined || kind !== periodKind(end)) {
    throw new Error(`Invalid event period: ${start} / ${end}`);
  }
  return kind === "date";
}

function isEventOf(calendar: Calendar, eventUrl: URL): boolean {
  const calendarUrl = new URL(calendar.url);
  const name = eventUrl.pathname.slice(calendarUrl.pathname.length);
  return (
    eventUrl.origin === calendarUrl.origin &&
    eventUrl.search === "" &&
    eventUrl.hash === "" &&
    eventUrl.pathname.startsWith(calendarUrl.pathname) &&
    name !== "" &&
    !name.includes("/")
  );
}

export class CalendarTools {
  constructor(
    private readonly store: CalendarStore,
    private readonly dependencies: Dependencies,
  ) {}

  listCalendars(): Promise<Calendar[]> {
    return this.store.listCalendars();
  }

  async listEvents(input: ListEventsInput): Promise<ListedEvents> {
    const calendars = await this.store.listCalendars();
    const targets = input.calendarUrls
      ? input.calendarUrls.map((url) => findCalendar(calendars, url))
      : calendars;
    const start = new Date(input.start);
    const end = new Date(input.end);
    const budget = new RecurrenceBudget();
    const events = await Promise.all(
      targets.map(async (calendar) =>
        (await this.store.listEvents(calendar.url, start, end, budget)).map(
          (event) => ({ ...event, calendar: calendar.name }),
        ),
      ),
    );
    return {
      events: events
        .flat()
        .sort((a, b) => Date.parse(a.start) - Date.parse(b.start)),
      skipped: budget.skipped,
    };
  }

  async createEvent(
    input: CreateEventInput,
  ): Promise<{ url: string; uid: string }> {
    const allDay = isAllDayPeriod(input.start, input.end);
    const calendar = findCalendar(
      await this.store.listCalendars(),
      input.calendarUrl,
    );
    const { calendarUrl: _, ...fields } = input;
    const event: NewEvent = {
      uid: this.dependencies.newUid(),
      ...fields,
      allDay,
    };
    const url = await this.store.createEvent(
      calendar.url,
      event,
      this.dependencies.now(),
    );
    return { url, uid: event.uid };
  }

  async deleteEvent(input: DeleteEventInput): Promise<void> {
    const calendars = await this.store.listCalendars();
    const eventUrl = new URL(input.eventUrl);
    if (!calendars.some((calendar) => isEventOf(calendar, eventUrl))) {
      throw new Error(`Unknown event: ${input.eventUrl}`);
    }
    await this.store.deleteEvent(eventUrl.href);
  }
}

function findCalendar(calendars: Calendar[], url: string): Calendar {
  const calendar = calendars.find((c) => c.url === url);
  if (!calendar) {
    throw new Error(`Unknown calendar: ${url}`);
  }
  return calendar;
}
