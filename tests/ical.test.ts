import { describe, expect, test } from "bun:test";
import { parseEvents } from "../src/ical.ts";

const calendar = (...lines: string[]) => lines.join("\r\n");

describe("parseEvents", () => {
  test("reads a timed event in UTC", () => {
    const ics = calendar(
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:abc-123",
      "SUMMARY:Weekly sync",
      "DTSTART:20261006T010000Z",
      "DTEND:20261006T020000Z",
      "LOCATION:Room A",
      "DESCRIPTION:Review the agenda",
      "END:VEVENT",
      "END:VCALENDAR",
    );

    expect(parseEvents(ics)).toEqual([
      {
        uid: "abc-123",
        summary: "Weekly sync",
        start: "2026-10-06T01:00:00Z",
        end: "2026-10-06T02:00:00Z",
        allDay: false,
        location: "Room A",
        description: "Review the agenda",
      },
    ]);
  });

  test("unfolds lines and unescapes text", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:u1",
      "SUMMARY:A\\, B\\; C",
      "DTSTART:20261006T010000Z",
      "DTEND:20261006T020000Z",
      "DESCRIPTION:Line one\\nline t",
      " wo continued",
      "END:VEVENT",
    );

    const [event] = parseEvents(ics);
    expect(event?.summary).toBe("A, B; C");
    expect(event?.description).toBe("Line one\nline two continued");
  });

  test("returns only dates for all-day events", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:u2",
      "SUMMARY:Vacation",
      "DTSTART;VALUE=DATE:20261010",
      "DTEND;VALUE=DATE:20261012",
      "END:VEVENT",
    );

    expect(parseEvents(ics)).toEqual([
      {
        uid: "u2",
        summary: "Vacation",
        start: "2026-10-10",
        end: "2026-10-12",
        allDay: true,
      },
    ]);
  });

  test("returns local time and time zone for TZID times", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:u3",
      "SUMMARY:Standup",
      "DTSTART;TZID=Asia/Tokyo:20261006T093000",
      "DTEND;TZID=Asia/Tokyo:20261006T094500",
      "END:VEVENT",
    );

    const [event] = parseEvents(ics);
    expect(event?.start).toBe("2026-10-06T09:30:00");
    expect(event?.end).toBe("2026-10-06T09:45:00");
    expect(event?.timeZone).toBe("Asia/Tokyo");
  });

  test("treats an all-day event without DTEND as ending the next day", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:u4",
      "SUMMARY:Birthday",
      "DTSTART;VALUE=DATE:20261231",
      "END:VEVENT",
    );

    expect(parseEvents(ics)[0]?.end).toBe("2027-01-01");
  });

  test("ends a timed event without DTEND at its start time", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:u5",
      "SUMMARY:Reminder",
      "DTSTART:20261006T010000Z",
      "END:VEVENT",
    );

    expect(parseEvents(ics)[0]?.end).toBe("2026-10-06T01:00:00Z");
  });

  test("ignores VALARM properties inside a VEVENT", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:u6",
      "SUMMARY:Doctor",
      "DTSTART:20261006T010000Z",
      "DTEND:20261006T020000Z",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      "DESCRIPTION:Reminder",
      "TRIGGER:-PT15M",
      "END:VALARM",
      "END:VEVENT",
    );

    expect(parseEvents(ics)[0]).not.toHaveProperty("description");
  });

  test("returns expanded recurring instances as separate events", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:weekly",
      "SUMMARY:Weekly",
      "RECURRENCE-ID:20261006T010000Z",
      "DTSTART:20261006T010000Z",
      "DTEND:20261006T020000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:weekly",
      "SUMMARY:Weekly",
      "RECURRENCE-ID:20261013T010000Z",
      "DTSTART:20261013T010000Z",
      "DTEND:20261013T020000Z",
      "END:VEVENT",
    );

    expect(parseEvents(ics).map((e) => e.start)).toEqual([
      "2026-10-06T01:00:00Z",
      "2026-10-13T01:00:00Z",
    ]);
  });
});
