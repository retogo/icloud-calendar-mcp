import { describe, expect, test } from "bun:test";
import { parseEvents } from "../src/ical.ts";

const TOKYO = [
  "BEGIN:VTIMEZONE",
  "TZID:Asia/Tokyo",
  "BEGIN:STANDARD",
  "DTSTART:19390101T000000",
  "TZOFFSETFROM:+0900",
  "TZOFFSETTO:+0900",
  "TZNAME:JST",
  "END:STANDARD",
  "END:VTIMEZONE",
];

const NEW_YORK = [
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "BEGIN:DAYLIGHT",
  "DTSTART:20070311T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:EDT",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "DTSTART:20071104T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "END:STANDARD",
  "END:VTIMEZONE",
];

const calendar = (...lines: string[]) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    ...TOKYO,
    ...NEW_YORK,
    ...lines,
    "END:VCALENDAR",
  ].join("\r\n");

const OCTOBER = {
  start: new Date("2026-10-01T00:00:00Z"),
  end: new Date("2026-11-01T00:00:00Z"),
};

describe("parseEvents: single events", () => {
  test("returns UTC times with Z", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:abc-123",
      "SUMMARY:Weekly sync",
      "DTSTART:20261006T010000Z",
      "DTEND:20261006T020000Z",
      "LOCATION:Room A",
      "DESCRIPTION:Review the agenda",
      "END:VEVENT",
    );

    expect(parseEvents(ics, OCTOBER)).toEqual([
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

  test("returns TZID times with their UTC offset and time zone", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:u3",
      "SUMMARY:Dinner",
      "DTSTART;TZID=Asia/Tokyo:20261006T180000",
      "DTEND;TZID=Asia/Tokyo:20261006T200000",
      "END:VEVENT",
    );

    const [event] = parseEvents(ics, OCTOBER);
    expect(event?.start).toBe("2026-10-06T18:00:00+09:00");
    expect(event?.end).toBe("2026-10-06T20:00:00+09:00");
    expect(event?.timeZone).toBe("Asia/Tokyo");
  });

  test("returns floating times without an offset", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:float",
      "SUMMARY:Wake up",
      "DTSTART:20261006T070000",
      "DTEND:20261006T071500",
      "END:VEVENT",
    );

    const [event] = parseEvents(ics, OCTOBER);
    expect(event?.start).toBe("2026-10-06T07:00:00");
    expect(event).not.toHaveProperty("timeZone");
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

    const [event] = parseEvents(ics, OCTOBER);
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

    expect(parseEvents(ics, OCTOBER)).toEqual([
      {
        uid: "u2",
        summary: "Vacation",
        start: "2026-10-10",
        end: "2026-10-12",
        allDay: true,
      },
    ]);
  });

  test("treats an all-day event without DTEND as ending the next day", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:u4",
      "SUMMARY:Birthday",
      "DTSTART;VALUE=DATE:20261031",
      "END:VEVENT",
    );

    expect(parseEvents(ics, OCTOBER)[0]?.end).toBe("2026-11-01");
  });

  test("ends a timed event without DTEND at its start time", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:u5",
      "SUMMARY:Reminder",
      "DTSTART:20261006T010000Z",
      "END:VEVENT",
    );

    expect(parseEvents(ics, OCTOBER)[0]?.end).toBe("2026-10-06T01:00:00Z");
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

    expect(parseEvents(ics, OCTOBER)[0]).not.toHaveProperty("description");
  });
});

describe("parseEvents: recurring events", () => {
  test("expands a recurrence rule into occurrences within the range", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:weekly",
      "SUMMARY:Standup",
      "DTSTART;TZID=Asia/Tokyo:20260922T093000",
      "DTEND;TZID=Asia/Tokyo:20260922T094500",
      "RRULE:FREQ=WEEKLY;COUNT=8",
      "END:VEVENT",
    );

    expect(
      parseEvents(ics, OCTOBER).map((e) => [e.uid, e.start, e.end]),
    ).toEqual([
      ["weekly", "2026-10-06T09:30:00+09:00", "2026-10-06T09:45:00+09:00"],
      ["weekly", "2026-10-13T09:30:00+09:00", "2026-10-13T09:45:00+09:00"],
      ["weekly", "2026-10-20T09:30:00+09:00", "2026-10-20T09:45:00+09:00"],
      ["weekly", "2026-10-27T09:30:00+09:00", "2026-10-27T09:45:00+09:00"],
    ]);
  });

  test("uses the offset of each occurrence across a daylight saving change", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:ny",
      "SUMMARY:NY call",
      "DTSTART;TZID=America/New_York:20261027T090000",
      "DTEND;TZID=America/New_York:20261027T100000",
      "RRULE:FREQ=WEEKLY;COUNT=2",
      "END:VEVENT",
    );

    const range = {
      start: new Date("2026-10-26T00:00:00Z"),
      end: new Date("2026-11-10T00:00:00Z"),
    };
    expect(parseEvents(ics, range).map((e) => e.start)).toEqual([
      "2026-10-27T09:00:00-04:00",
      "2026-11-03T09:00:00-05:00",
    ]);
  });

  test("skips excluded dates", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:ex",
      "SUMMARY:Gym",
      "DTSTART:20261005T100000Z",
      "DTEND:20261005T110000Z",
      "RRULE:FREQ=WEEKLY;COUNT=3",
      "EXDATE:20261012T100000Z",
      "END:VEVENT",
    );

    expect(parseEvents(ics, OCTOBER).map((e) => e.start)).toEqual([
      "2026-10-05T10:00:00Z",
      "2026-10-19T10:00:00Z",
    ]);
  });

  test("applies modified occurrences", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:mod",
      "SUMMARY:Review",
      "DTSTART:20261005T100000Z",
      "DTEND:20261005T110000Z",
      "RRULE:FREQ=WEEKLY;COUNT=2",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:mod",
      "RECURRENCE-ID:20261012T100000Z",
      "SUMMARY:Review (moved)",
      "DTSTART:20261013T150000Z",
      "DTEND:20261013T160000Z",
      "END:VEVENT",
    );

    expect(parseEvents(ics, OCTOBER).map((e) => [e.summary, e.start])).toEqual([
      ["Review", "2026-10-05T10:00:00Z"],
      ["Review (moved)", "2026-10-13T15:00:00Z"],
    ]);
  });

  test("returns instances that the server already expanded", () => {
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

    expect(parseEvents(ics, OCTOBER).map((e) => e.start)).toEqual([
      "2026-10-06T01:00:00Z",
      "2026-10-13T01:00:00Z",
    ]);
  });

  test("expands recurring all-day events as dates", () => {
    const ics = calendar(
      "BEGIN:VEVENT",
      "UID:monthly",
      "SUMMARY:Rent",
      "DTSTART;VALUE=DATE:20260925",
      "DTEND;VALUE=DATE:20260926",
      "RRULE:FREQ=MONTHLY",
      "END:VEVENT",
    );

    expect(
      parseEvents(ics, OCTOBER).map((e) => [e.start, e.end, e.allDay]),
    ).toEqual([["2026-10-25", "2026-10-26", true]]);
  });
});
