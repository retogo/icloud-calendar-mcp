import { describe, expect, test } from "bun:test";
import type { Calendar, StoredEvent } from "../src/caldav-client.ts";
import type { NewEvent, RecurrenceBudget } from "../src/ical.ts";
import { type CalendarStore, CalendarTools } from "../src/tools.ts";

const WORK: Calendar = {
  url: "https://p42-caldav.icloud.com/123/calendars/work/",
  name: "Work",
};
const HOME: Calendar = {
  url: "https://p42-caldav.icloud.com/123/calendars/home/",
  name: "Home",
};
const FOREIGN_URL = "https://attacker.example/123/calendars/work/";
const NOW = new Date("2026-10-06T00:00:00Z");

const event = (calendar: Calendar, start: string): StoredEvent => ({
  url: `${calendar.url}${start}.ics`,
  etag: '"e"',
  uid: start,
  summary: `${calendar.name} event`,
  start,
  end: start,
  allDay: false,
});

function fakeStore() {
  const calls: string[] = [];
  const budgets: RecurrenceBudget[] = [];
  const created: { calendarUrl: string; event: NewEvent; now: Date }[] = [];
  const store: CalendarStore = {
    listCalendars: async () => [WORK, HOME],
    listEvents: async (calendarUrl, _start, _end, budget) => {
      calls.push(`listEvents ${calendarUrl}`);
      budgets.push(budget);
      if (calendarUrl === WORK.url) {
        return [event(WORK, "2026-10-06T10:00:00+09:00")];
      }
      budget.skip({ uid: "flood", summary: "Flood" });
      return [event(HOME, "2026-10-06T03:00:00Z")];
    },
    createEvent: async (calendarUrl, newEvent, now) => {
      created.push({ calendarUrl, event: newEvent, now });
      return `${calendarUrl}${newEvent.uid}.ics`;
    },
    deleteEvent: async (eventUrl) => {
      calls.push(`deleteEvent ${eventUrl}`);
    },
    getEvent: async (eventUrl) => {
      calls.push(`getEvent ${eventUrl}`);
      return { data: STORED_ICS, etag: '"e1"' };
    },
    updateEvent: async (eventUrl, data, etag) => {
      calls.push(`updateEvent ${eventUrl} ${etag}`);
      updated.push(data);
    },
  };
  const updated: string[] = [];
  const tools = new CalendarTools(store, {
    now: () => NOW,
    newUid: () => "generated-uid",
  });
  return { tools, calls, budgets, created, updated };
}

const STORED_ICS = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:a",
  "DTSTAMP:20261001T000000Z",
  "DTSTART:20261006T010000Z",
  "DTEND:20261006T020000Z",
  "SUMMARY:Sync",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("CalendarTools.updateEvent", () => {
  test("applies the changes and writes back with the ETag it read", async () => {
    const { tools, calls, updated } = fakeStore();
    const eventUrl = `${WORK.url}a.ics`;

    const result = await tools.updateEvent({
      eventUrl,
      summary: "Weekly sync",
      start: "2026-10-06T11:00:00+09:00",
      end: "2026-10-06T12:00:00+09:00",
    });

    expect(result).toEqual({ updated: eventUrl });
    expect(calls).toEqual([
      `getEvent ${eventUrl}`,
      `updateEvent ${eventUrl} "e1"`,
    ]);
    const lines = updated[0]?.split("\r\n");
    expect(lines).toContain("SUMMARY:Weekly sync");
    expect(lines).toContain("DTSTART:20261006T020000Z");
  });

  test("rejects URLs outside the owner's calendars without any request", async () => {
    const { tools, calls } = fakeStore();
    const eventUrl = "https://attacker.example/123/calendars/work/a.ics";

    await expect(tools.updateEvent({ eventUrl, summary: "x" })).rejects.toThrow(
      `Unknown event: ${eventUrl}`,
    );
    expect(calls).toEqual([]);
  });

  test.each([
    [{ start: "2026-10-06T11:00:00+09:00" }],
    [{ end: "2026-10-06T12:00:00+09:00" }],
    [{ start: "2026-10-10", end: "2026-10-11T00:00:00Z" }],
  ])(
    "rejects an incomplete or mixed period without any request: %o",
    async (period) => {
      const { tools, calls } = fakeStore();

      await expect(
        tools.updateEvent({ eventUrl: `${WORK.url}a.ics`, ...period }),
      ).rejects.toThrow("Invalid event period");
      expect(calls).toEqual([]);
    },
  );
});

describe("CalendarTools.listEvents", () => {
  test("returns events from all calendars in chronological order across offsets", async () => {
    const { tools } = fakeStore();

    const { events } = await tools.listEvents({
      start: "2026-10-06T00:00:00+09:00",
      end: "2026-10-07T00:00:00+09:00",
    });

    expect(events.map((e) => [e.calendar, e.start])).toEqual([
      ["Work", "2026-10-06T10:00:00+09:00"],
      ["Home", "2026-10-06T03:00:00Z"],
    ]);
  });

  test("shares one recurrence budget across calendars and reports skipped events", async () => {
    const { tools, budgets } = fakeStore();

    const { skipped } = await tools.listEvents({
      start: "2026-10-06T00:00:00+09:00",
      end: "2026-10-07T00:00:00+09:00",
    });

    expect(budgets).toHaveLength(2);
    expect(budgets[0]).toBe(budgets[1] as RecurrenceBudget);
    expect(skipped).toEqual([{ uid: "flood", summary: "Flood" }]);
  });

  test("queries only the specified calendar", async () => {
    const { tools, calls } = fakeStore();

    await tools.listEvents({
      start: "2026-10-06T00:00:00+09:00",
      end: "2026-10-07T00:00:00+09:00",
      calendarUrls: [WORK.url],
    });

    expect(calls).toEqual([`listEvents ${WORK.url}`]);
  });

  test("rejects URLs outside the owner's calendars without querying", async () => {
    const { tools, calls } = fakeStore();

    await expect(
      tools.listEvents({
        start: "2026-10-06T00:00:00+09:00",
        end: "2026-10-07T00:00:00+09:00",
        calendarUrls: [FOREIGN_URL],
      }),
    ).rejects.toThrow(`Unknown calendar: ${FOREIGN_URL}`);
    expect(calls).toEqual([]);
  });
});

describe("CalendarTools.createEvent", () => {
  test("creates an event with a server-generated UID", async () => {
    const { tools, created } = fakeStore();

    const result = await tools.createEvent({
      calendarUrl: WORK.url,
      summary: "Meeting",
      start: "2026-10-06T10:00:00+09:00",
      end: "2026-10-06T11:00:00+09:00",
    });

    expect(result).toEqual({
      url: `${WORK.url}generated-uid.ics`,
      uid: "generated-uid",
    });
    expect(created).toEqual([
      {
        calendarUrl: WORK.url,
        event: {
          uid: "generated-uid",
          summary: "Meeting",
          start: "2026-10-06T10:00:00+09:00",
          end: "2026-10-06T11:00:00+09:00",
          allDay: false,
        },
        now: NOW,
      },
    ]);
  });

  test("treats date-only start and end as an all-day event", async () => {
    const { tools, created } = fakeStore();

    await tools.createEvent({
      calendarUrl: HOME.url,
      summary: "Vacation",
      start: "2026-10-10",
      end: "2026-10-12",
      location: "Okinawa",
    });

    expect(created[0]?.event).toEqual({
      uid: "generated-uid",
      summary: "Vacation",
      start: "2026-10-10",
      end: "2026-10-12",
      allDay: true,
      location: "Okinawa",
    });
  });

  test.each([
    ["2026-10-10", "2026-10-11\r\nX-INJECTED:1"],
    ["2026-10-10", "2026-10-11T00:00:00Z"],
    ["2026-10-10T10:00:00+09:00", "2026-10-11"],
    ["2026-10-10T10:00:00+09:00", "not a date"],
    ["2026-13-40", "2026-13-41"],
  ])(
    "does not create an event with mismatched or invalid start/end: %s / %s",
    async (start, end) => {
      const { tools, created } = fakeStore();

      await expect(
        tools.createEvent({ calendarUrl: WORK.url, summary: "x", start, end }),
      ).rejects.toThrow("Invalid event period");
      expect(created).toEqual([]);
    },
  );

  test("does not create events outside the owner's calendars", async () => {
    const { tools, created } = fakeStore();

    await expect(
      tools.createEvent({
        calendarUrl: FOREIGN_URL,
        summary: "x",
        start: "2026-10-10",
        end: "2026-10-11",
      }),
    ).rejects.toThrow(`Unknown calendar: ${FOREIGN_URL}`);
    expect(created).toEqual([]);
  });
});

describe("CalendarTools.deleteEvent", () => {
  test("deletes an event under the owner's calendar", async () => {
    const { tools, calls } = fakeStore();
    const eventUrl = `${WORK.url}a.ics`;

    await tools.deleteEvent({ eventUrl });

    expect(calls).toEqual([`deleteEvent ${eventUrl}`]);
  });

  test.each([
    "https://p42-caldav.icloud.com/123/calendars/workx/a.ics",
    `${WORK.url}../../../other/a.ics`,
    `${WORK.url}%2e%2e/%2e%2e/other/a.ics`,
    `${WORK.url}?a.ics`,
    `${WORK.url}#a.ics`,
    `${WORK.url}sub/a.ics`,
  ])("does not delete URLs outside a calendar: %s", async (eventUrl) => {
    const { tools, calls } = fakeStore();

    await expect(tools.deleteEvent({ eventUrl })).rejects.toThrow(
      "Unknown event",
    );
    expect(calls).toEqual([]);
  });
});
