import { describe, expect, test } from "bun:test";
import { buildEvent, parseEvents, RecurrenceBudget } from "../src/ical.ts";

const MAX_LINE_OCTETS = 75;
const now = new Date("2026-10-06T00:00:00Z");

describe("buildEvent", () => {
  test("converts offset times to UTC and builds a VCALENDAR", () => {
    const ics = buildEvent(
      {
        uid: "new-1",
        summary: "Meeting",
        start: "2026-10-06T10:00:00+09:00",
        end: "2026-10-06T11:00:00+09:00",
        allDay: false,
      },
      now,
    );

    expect(ics.split("\r\n")).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//icloud-calendar-mcp//EN",
      "BEGIN:VEVENT",
      "UID:new-1",
      "DTSTAMP:20261006T000000Z",
      "DTSTART:20261006T010000Z",
      "DTEND:20261006T020000Z",
      "SUMMARY:Meeting",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ]);
  });

  test("writes all-day events with VALUE=DATE", () => {
    const ics = buildEvent(
      {
        uid: "new-2",
        summary: "Vacation",
        start: "2026-10-10",
        end: "2026-10-12",
        allDay: true,
      },
      now,
    );

    expect(ics).toContain("\r\nDTSTART;VALUE=DATE:20261010\r\n");
    expect(ics).toContain("\r\nDTEND;VALUE=DATE:20261012\r\n");
  });

  test("escapes text, folds multi-byte lines at 75 octets, and round-trips", () => {
    const event = {
      uid: "new-3",
      summary: "A, B; C\\D",
      start: "2026-10-06T01:00:00Z",
      end: "2026-10-06T02:00:00Z",
      allDay: false,
      location: "東京都千代田区丸の内一丁目",
      description: `${"長い説明文です。".repeat(20)}\n改行のあと`,
    };

    const ics = buildEvent(event, now);

    const encoder = new TextEncoder();
    for (const line of ics.split("\r\n")) {
      expect(encoder.encode(line).length).toBeLessThanOrEqual(MAX_LINE_OCTETS);
    }
    const day = {
      start: new Date("2026-10-06T00:00:00Z"),
      end: new Date("2026-10-07T00:00:00Z"),
      localOffsetSeconds: 0,
    };
    expect(parseEvents(ics, day, new RecurrenceBudget())).toEqual([event]);
  });

  test("prevents property injection via CR / CRLF in text", () => {
    const ics = buildEvent(
      {
        uid: "new-4",
        summary: "a\r\nX-INJECTED:1\rEND:VEVENT",
        start: "2026-10-06T01:00:00Z",
        end: "2026-10-06T02:00:00Z",
        allDay: false,
      },
      now,
    );

    expect(ics).toContain("\r\nSUMMARY:a\\nX-INJECTED:1\\nEND:VEVENT\r\n");
    expect(
      ics.split("\r\n").filter((line) => line === "END:VEVENT"),
    ).toHaveLength(1);
  });
});
